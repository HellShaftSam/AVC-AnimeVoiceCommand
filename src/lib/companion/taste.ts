/**
 * Anime Companion — карта вкусов (ТЗ §9).
 *
 * ТОЛЬКО реальные сигналы пользователя, никаких выдумок:
 *   Любимые (список 4) + свои оценки ≥ 7 (любой список) → детали с сайта
 *   (адаптер, тот же путь что у рекомендаций) → агрегат жанров и студий.
 *
 * Нет сигналов → пустые массивы + available:true + честная подсказка.
 * Библиотека недоступна → available:false + причина (работать не на чем).
 * Кэш результата 60 с, ключ accountKey+lastSync, Map ≤ 32 записей (не безграничный).
 */
import type { AnimeDetails } from '@/lib/avc/types'
import { getAdapter } from '@/lib/sites/yummy/adapter'
import { loadLibrary } from './library'

// --- типы ответа -------------------------------------------------------------------

export interface TasteGenre {
  name: string
  count: number
  /** 0..1, нормировано на самый частый жанр */
  weight: number
  /** До 3 тайтлов-доказательств */
  evidence: string[]
}

export interface TasteStudio {
  name: string
  count: number
  /** До 3 тайтлов-доказательств */
  titles: string[]
}

export interface TasteTopRated {
  title: string
  rating: number
}

export interface TasteSignalCounts {
  rated: number
  favorites: number
  watching: number
  completed: number
  dropped: number
}

export interface TasteResult {
  available: boolean
  reason: string | null
  genres: TasteGenre[]
  studios: TasteStudio[]
  topRated: TasteTopRated[]
  signalCounts: TasteSignalCounts
}

const MAX_SIGNAL_TITLES = 16
const MIN_RATING = 7
const EVIDENCE_LIMIT = 3
const TOP_RATED_LIMIT = 12

// --- сигналы -------------------------------------------------------------------------

/** Один сигнал вкуса (реальное действие пользователя с сайта) */
export interface TasteSignal {
  animeId: number
  title: string
  ownRating: number | null
  isFavorite: boolean
}

/**
 * ЧИСТАЯ агрегация сигналов + метаданных (экспортирована для тестов).
 * Жанры: count desc, weight = count/max, evidence ≤ 3 (порядок сигналов).
 * Студии: count desc, titles ≤ 3. topRated: оценка desc, ≤ 12.
 * Сортировка при равенстве — по алфавиту (детерминизм).
 */
export function aggregateTasteSignals(
  signals: TasteSignal[],
  details: Map<number, Pick<AnimeDetails, 'genres' | 'studios'> | null>,
): {
  genres: TasteGenre[]
  studios: TasteStudio[]
  topRated: TasteTopRated[]
} {
  const genreCount = new Map<string, number>()
  const genreEvidence = new Map<string, string[]>()
  const studioCount = new Map<string, number>()
  const studioTitles = new Map<string, string[]>()

  for (const signal of signals) {
    const meta = details.get(signal.animeId) ?? null
    if (!meta) continue // деталей нет — жанр/студию выдумывать нельзя
    for (const g of meta.genres ?? []) {
      genreCount.set(g, (genreCount.get(g) ?? 0) + 1)
      const ev = genreEvidence.get(g) ?? []
      if (ev.length < EVIDENCE_LIMIT && !ev.includes(signal.title)) ev.push(signal.title)
      genreEvidence.set(g, ev)
    }
    for (const s of meta.studios ?? []) {
      studioCount.set(s, (studioCount.get(s) ?? 0) + 1)
      const t = studioTitles.get(s) ?? []
      if (t.length < EVIDENCE_LIMIT && !t.includes(signal.title)) t.push(signal.title)
      studioTitles.set(s, t)
    }
  }

  const maxGenre = Math.max(0, ...genreCount.values())
  const genres: TasteGenre[] = [...genreCount.entries()]
    .map(([name, count]) => ({
      name,
      count,
      weight: maxGenre > 0 ? Math.round((count / maxGenre) * 100) / 100 : 0,
      evidence: genreEvidence.get(name) ?? [],
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const studios: TasteStudio[] = [...studioCount.entries()]
    .map(([name, count]) => ({ name, count, titles: studioTitles.get(name) ?? [] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const topRated: TasteTopRated[] = signals
    .filter((s) => typeof s.ownRating === 'number' && s.ownRating >= 1)
    .sort((a, b) => (b.ownRating ?? 0) - (a.ownRating ?? 0) || a.title.localeCompare(b.title))
    .slice(0, TOP_RATED_LIMIT)
    .map((s) => ({ title: s.title, rating: s.ownRating as number }))

  return { genres, studios, topRated }
}

// --- детали тайтлов (тот же серверный путь, что у рекомендаций) ------------------------

interface DetailsCacheEntry {
  details: Pick<AnimeDetails, 'genres' | 'studios'> | null // null = сайт не отдал live — не выдумываем
  at: number
}
const detailsCache = new Map<number, DetailsCacheEntry>()
const DETAILS_TTL = 60 * 60 * 1000 // метаданные тайтлов меняются редко
const DETAILS_CACHE_MAX = 64

async function getLiveMeta(animeId: number): Promise<Pick<AnimeDetails, 'genres' | 'studios'> | null> {
  const hit = detailsCache.get(animeId)
  if (hit && hit.at + DETAILS_TTL > Date.now()) return hit.details
  let live: Pick<AnimeDetails, 'genres' | 'studios'> | null = null
  try {
    const d = await getAdapter().getAnimeById(animeId)
    if (d && d.source === 'live') live = { genres: d.genres ?? [], studios: d.studios ?? [] }
  } catch {
    live = null
  }
  while (detailsCache.size >= DETAILS_CACHE_MAX) {
    const oldest = detailsCache.keys().next().value
    if (oldest === undefined) break
    detailsCache.delete(oldest)
  }
  detailsCache.set(animeId, { details: live, at: Date.now() })
  return live
}

// --- кэш результата (60 с, ключ accountKey+lastSync, ≤ 32 записей) ---------------------

const RESULT_TTL = 60 * 1000
const RESULT_MAX = 32
const resultCache = new Map<string, { result: TasteResult; at: number }>()

function resultCacheGet(key: string): TasteResult | null {
  const hit = resultCache.get(key)
  if (hit && hit.at + RESULT_TTL > Date.now()) return hit.result
  if (hit) resultCache.delete(key)
  return null
}

function resultCacheSet(key: string, result: TasteResult): TasteResult {
  while (resultCache.size >= RESULT_MAX) {
    const oldest = resultCache.keys().next().value
    if (oldest === undefined) break
    resultCache.delete(oldest)
  }
  resultCache.set(key, { result, at: Date.now() })
  return result
}

/** Сбросить кэш карты вкусов (логаут — по образцу recs) */
export function clearCompanionTasteCache(): void {
  resultCache.clear()
}

// --- основной расчёт -------------------------------------------------------------------

export async function getTaste(accountKey: string): Promise<TasteResult> {
  const library = await loadLibrary()

  if (!library.ok) {
    return {
      available: false,
      reason: library.reason,
      genres: [],
      studios: [],
      topRated: [],
      signalCounts: { rated: 0, favorites: 0, watching: 0, completed: 0, dropped: 0 },
    }
  }

  const { lists, lastSync } = library.snapshot
  const cacheKey = `${accountKey}:${lastSync}`
  const cached = resultCacheGet(cacheKey)
  if (cached) return cached

  // 1. Счётчики списков (реальные действия на сайте)
  const watchingIds = new Set<number>()
  const completedIds = new Set<number>()
  const droppedIds = new Set<number>()
  const favoriteIds = new Set<number>()
  const ratedIds = new Set<number>()
  for (const list of lists) {
    for (const item of list.items) {
      if (item.animeId === null) continue
      if (list.listId === 0) watchingIds.add(item.animeId)
      else if (list.listId === 2) completedIds.add(item.animeId)
      else if (list.listId === 3) droppedIds.add(item.animeId)
      if (list.listId === 4 || item.isFavorite) favoriteIds.add(item.animeId)
      if (typeof item.ownRating === 'number' && item.ownRating >= 1) ratedIds.add(item.animeId)
    }
  }

  // 2. Сигналы: Любимые + оценки ≥ MIN_RATING; Любимые первыми, затем по оценке desc
  const byId = new Map<number, TasteSignal>()
  for (const list of lists) {
    if (list.listId !== 4) continue
    for (const item of list.items) {
      if (item.animeId === null) continue
      byId.set(item.animeId, {
        animeId: item.animeId,
        title: item.title,
        ownRating: item.ownRating,
        isFavorite: true,
      })
    }
  }
  const rated: TasteSignal[] = []
  for (const list of lists) {
    for (const item of list.items) {
      if (item.animeId === null) continue
      if (!(typeof item.ownRating === 'number' && item.ownRating >= MIN_RATING)) continue
      if (byId.has(item.animeId)) continue
      rated.push({
        animeId: item.animeId,
        title: item.title,
        ownRating: item.ownRating,
        isFavorite: item.isFavorite,
      })
    }
  }
  rated.sort((a, b) => (b.ownRating ?? 0) - (a.ownRating ?? 0) || a.title.localeCompare(b.title))
  const signals = [...byId.values(), ...rated].slice(0, MAX_SIGNAL_TITLES)

  const signalCounts: TasteSignalCounts = {
    rated: ratedIds.size,
    favorites: favoriteIds.size,
    watching: watchingIds.size,
    completed: completedIds.size,
    dropped: droppedIds.size,
  }

  // 3. Нет сигналов — честные пустые массивы (не выдумки)
  if (signals.length === 0) {
    const result: TasteResult = {
      available: true,
      reason:
        'Пока нет сигналов вкуса: добавьте тайтлы в Любимые или поставьте оценки 7+ в библиотеке на сайте',
      genres: [],
      studios: [],
      topRated: [],
      signalCounts,
    }
    return resultCacheSet(cacheKey, result)
  }

  // 4. Детали сигналов (жанры/студии) — батч с ограниченной конкурентностью
  const details = new Map<number, Pick<AnimeDetails, 'genres' | 'studios'> | null>()
  const LIMIT = 4
  let next = 0
  const workers = Array.from({ length: Math.min(LIMIT, signals.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= signals.length) return
      const s = signals[i]
      details.set(s.animeId, await getLiveMeta(s.animeId))
    }
  })
  await Promise.all(workers)

  const { genres, studios, topRated } = aggregateTasteSignals(signals, details)
  const result: TasteResult = {
    available: true,
    reason: null,
    genres,
    studios,
    topRated,
    signalCounts,
  }
  return resultCacheSet(cacheKey, result)
}
