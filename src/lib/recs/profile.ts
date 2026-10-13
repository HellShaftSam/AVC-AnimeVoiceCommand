/**
 * Рекомендации — сборка профиля предпочтений из РЕАЛЬНЫХ данных пользователя.
 *
 * Источники (ТЗ §3, верифицированы аудитом):
 *  - сайт YummyAnime: списки 0..5 (Смотрю/В Планах/Просмотрено/Брошено/Отложено/
 *    Любимые) + своя оценка user.rating 1..10 + флаг is_fav — сервер-авторитетен;
 *  - локальный трекинг просмотра приложения (WatchProgressEntry, accountKey =
 *    userId сайта) — слабый сигнал: «открыл серию» ≠ «нравится».
 *
 * Правила смешивания (ТЗ §5.3 — НЕ уравнивать):
 *  - watching ≠ любит; completed ≠ высоко оценено; planned ≠ completed;
 *  - dropped ≠ нейтрально — это ЖЁСТКОЕ исключение тайтла;
 *  - отсутствие оценки ≠ оценка 0 — тайтл остаётся «завершён без оценки»;
 *  - своя оценка и рейтинг сайта никогда не смешиваются.
 */
import type { YummyLibraryItem, YummyLibraryList } from '@/lib/avc/types'
import type {
  RecAnchor,
  RecEngineSettings,
  RecKnownStatus,
  RecProfile,
  RecProfileEntry,
} from './types'
import { STATUS_STRENGTH, ratingStrength } from './types'

/** Нормализация элемента библиотеки сайта → элемент профиля */
export function entryFromLibraryItem(item: YummyLibraryItem): RecProfileEntry | null {
  if (item.animeId === null || !item.slug) return null
  // Статус — ТОЛЬКО из списка тайтла (listId). Флаг is_fav учитывается отдельно
  // (силой сигнала): «избранное» на сайте лежит поверх основного списка.
  const status: RecKnownStatus =
    item.listId === 0
      ? 'watching'
      : item.listId === 1
        ? 'planned'
        : item.listId === 2
          ? 'completed'
          : item.listId === 3
            ? 'dropped'
            : item.listId === 4
              ? 'favorite'
              : item.listId === 5
                ? 'on_hold'
                : 'watching'
  // user.rating 0 = «оценки нет» (сайт так отдаёт) → null, НО никогда не 0
  const ownRating =
    typeof item.ownRating === 'number' && item.ownRating >= 1 && item.ownRating <= 10
      ? item.ownRating
      : null
  return {
    animeId: item.animeId,
    slug: item.slug,
    title: item.title,
    poster: item.poster,
    status,
    ownRating,
    siteRating: item.siteRating,
    isFavorite: item.isFavorite === true,
    source: 'site',
  }
}

/** Элемент локального трекинга → слабый профиль-сигнал «смотрю» */
export function entryFromProgress(item: {
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
}): RecProfileEntry {
  return {
    animeId: item.animeId,
    slug: item.slug,
    title: item.title,
    poster: item.poster,
    status: 'watching',
    ownRating: null,
    siteRating: null,
    isFavorite: false,
    source: 'local-progress',
    episode: item.episode ?? null,
  }
}

/**
 * Приоритет статусов при дублировании (сайт допускает «избранное» поверх списка;
 * один тайтл может встретиться в нескольких ответах списков):
 *   favorite > dropped > watching > completed > on_hold > planned.
 * Детерминировано и тестируется (ТЗ §6.4 «странный комбинации статусов»).
 */
export const STATUS_PRECEDENCE: Record<RecKnownStatus, number> = {
  favorite: 5,
  dropped: 4,
  watching: 3,
  completed: 2,
  on_hold: 1,
  planned: 0,
}

export function strongerStatus(a: RecKnownStatus, b: RecKnownStatus): RecKnownStatus {
  return STATUS_PRECEDENCE[a] >= STATUS_PRECEDENCE[b] ? a : b
}

/**
 * Построить профиль. Жёсткие исключения (dropped / ownRating < threshold)
 * помечаются здесь же — фильтр кандидатов применит их ДО ранжирования (ТЗ: в.1).
 */
export function buildProfile(
  accountKey: string | null,
  lists: YummyLibraryList[],
  progress: Array<{ animeId: number; slug: string; title: string; poster: string | null; episode: number | null }>,
  settings: RecEngineSettings,
): RecProfile {
  const byId = new Map<number, RecProfileEntry>()

  // 1. Сайт — источник истины
  for (const list of lists) {
    for (const item of list.items) {
      const entry = entryFromLibraryItem(item)
      if (!entry) continue
      const prev = byId.get(entry.animeId)
      if (prev) {
        // Дубль из разных списков: берём сильнейший статус, оценка/фав склеиваются
        prev.status = strongerStatus(prev.status, entry.status)
        if (entry.ownRating !== null) prev.ownRating = entry.ownRating
        if (entry.isFavorite) prev.isFavorite = true
      } else {
        byId.set(entry.animeId, entry)
      }
    }
  }

  // 2. Локальный трекинг — только если тайтла нет на сайте (сайт приоритетен)
  for (const p of progress) {
    if (byId.has(p.animeId)) continue
    if (!p.slug) continue
    byId.set(p.animeId, entryFromProgress(p))
  }

  // 3. Якоря с силой сигнала
  const anchors: RecAnchor[] = []
  const knownIds = new Set<number>()
  const knownSlugs = new Set<string>()
  const hardExcludedIds = new Set<number>()
  const franchiseParents = new Map<number, { title: string; strength: number }>()
  let positiveEvidence = 0

  for (const entry of byId.values()) {
    knownIds.add(entry.animeId)
    knownSlugs.add(entry.slug)

    const negative =
      entry.status === 'dropped' ||
      (entry.ownRating !== null && entry.ownRating < settings.ratingThreshold)

    let strength: number
    if (negative) {
      // dropped → жёсткое исключение; низкая оценка → жёсткое исключение тайтла.
      // Негативный якорь УЧАСТВУЕТ в негативном векторе вкуса (слабо), но
      // жанр целиком никогда не отвергается (ТЗ §6.1).
      strength =
        entry.status === 'dropped'
          ? 0.8
          : entry.ownRating !== null
            ? Math.min(1, (settings.ratingThreshold - entry.ownRating) / Math.max(1, settings.ratingThreshold - 1))
            : 0.5
      hardExcludedIds.add(entry.animeId)
    } else {
      const base = STATUS_STRENGTH[entry.status]
      const rating = entry.ownRating !== null ? ratingStrength(entry.ownRating, settings.ratingThreshold) : 0
      const favBonus = entry.isFavorite && entry.status !== 'favorite' ? 0.35 : 0
      strength = Math.min(1, base + rating + favBonus)
      if (strength > 0) positiveEvidence += strength
      if (strength > 0) {
        franchiseParents.set(entry.animeId, { title: entry.title, strength })
      }
    }

    anchors.push({
      entry,
      strength,
      negative,
      genres: [], // заполняется после обогащения деталями
      studios: [],
    })
  }

  return {
    accountKey,
    anchors,
    positiveEvidence,
    genreWeights: new Map(),
    negativeGenreWeights: new Map(),
    studioWeights: new Map(),
    knownIds,
    knownSlugs,
    hardExcludedIds,
    franchiseParents,
  }
}

/**
 * Заполнить вектор вкуса жанров/студий из якорей (после обогащения деталей).
 * Позитивные и негативные веса РАЗДЕЛЬНЫЕ; негативный вклад взвешен 0.6
 * (одиночное «брошено» не отвергает жанр целиком — ТЗ §6.1).
 */
export function applyAnchorMetadata(
  profile: RecProfile,
  metadata: Map<number, { genres: string[]; studios: string[] }>,
): void {
  profile.genreWeights = new Map()
  profile.negativeGenreWeights = new Map()
  profile.studioWeights = new Map()

  for (const anchor of profile.anchors) {
    const meta = metadata.get(anchor.entry.animeId)
    anchor.genres = meta?.genres ?? []
    anchor.studios = meta?.studios ?? []
    if (anchor.strength <= 0) continue

    const genreTarget = anchor.negative ? profile.negativeGenreWeights : profile.genreWeights
    const w = anchor.strength * (anchor.negative ? 0.6 : 1)
    for (const g of anchor.genres) {
      genreTarget.set(g, (genreTarget.get(g) ?? 0) + w)
    }
    if (!anchor.negative) {
      for (const s of anchor.studios) {
        profile.studioWeights.set(s, (profile.studioWeights.get(s) ?? 0) + anchor.strength * 0.5)
      }
    }
  }
}

/** Топ жанров профиля (для UI/объяснений) */
export function topGenres(profile: RecProfile, n = 5): string[] {
  return [...profile.genreWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([g]) => g)
}
