/**
 * GET /api/recs — персональные рекомендации (полный конвейер на сервере).
 *
 * Данные (ТЗ §3, сервер-авторитетно):
 *  - сессия сайта (web-session) → профиль → numericId;
 *  - библиотека: GET /api/users/{id}/lists/0..5 (6 списков, кэш 60 с);
 *  - локальный трекинг просмотра (SQLite, accountKey = numericId);
 *  - обратная связь RecFeedback (скрытое/«уже видел»).
 *
 * Кандидаты: франшизы позитивных тайтлов (viewing_order) + каталог сайта
 * (ТОП-100, онгоинги, каталог) + опционально AniList→поиск по сайту.
 * Обогащение метаданными — батчами с ограниченной конкурентностью и кэшем.
 *
 * Снапшот в AppSetting (key = recs:snapshot:{accountKey}) с фингерпринтом входа:
 * те же входы → мгновенный ответ без пересчёта (ТЗ §10 инкрементальность);
 * сайт недоступен → честный stale-снапшот либо ошибка, ничего не выдумываем.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { getAdapter } from '@/lib/sites/yummy/adapter'
import { fetchProfile, fetchUserList, parseLibraryItems, parseProfile } from '@/lib/sites/yummy/web-auth'
import { loadWebSession } from '@/lib/sites/yummy/web-session'
import { buildProfile, applyAnchorMetadata, topGenres } from '@/lib/recs/profile'
import {
  computeRecommendations,
  franchiseToCandidate,
  cardToCandidate,
  franchiseKind,
} from '@/lib/recs/engine'
import { fetchAnilistRecommendations } from '@/lib/recs/anilist'
import type { RecCard, RecCandidate, RecEngineSettings, RecResult } from '@/lib/recs/types'
import { loadRecsSnapshot, saveRecsSnapshot } from '@/lib/recs/snapshot'
import { DEFAULT_REC_SETTINGS } from '@/lib/recs/types'
import type { AnimeDetails, YummyLibraryList } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// --- типы ответа ---------------------------------------------------------------

export interface RecsResponse {
  ok: boolean
  /** personalized | discovery | logged-out | unavailable */
  mode: RecResult['mode'] | 'unavailable'
  items: RecCard[]
  profileSummary: RecResult['profileSummary'] | null
  message: string | null
  reason: string | null
  /** true — ответ из снапшота (сайт был недоступен для свежего пересчёта) */
  stale: boolean
  /** true — фингерпринт совпал, отдали кэш без пересчёта */
  cached: boolean
  computedAt: string | null
  /** Обратная связь для UI-кнопки «вернуть скрытые» */
  feedback: Array<{ animeId: number; action: string; title: string }>
}

// --- утилиты ---------------------------------------------------------------------

/** mapLimit — параллельность с потолком; порядок результатов = порядку входа */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// --- кэши (модуль, живут с сервером; TTL — не поллинг, ТЗ §10) ---------------------

interface LibCacheEntry {
  lists: YummyLibraryList[]
  at: number
}
let libCache: LibCacheEntry | null = null
const LIB_TTL = 60 * 1000

interface DetailsCacheEntry {
  details: AnimeDetails | null // null = сайт вернул demo/ошибку — не выдумываем
  at: number
}
const detailsCache = new Map<number, DetailsCacheEntry>()
const DETAILS_TTL = 60 * 60 * 1000 // метаданные тайтлов меняются редко

async function getLiveDetails(animeId: number): Promise<AnimeDetails | null> {
  const hit = detailsCache.get(animeId)
  if (hit && hit.at + DETAILS_TTL > Date.now()) return hit.details
  try {
    const d = await getAdapter().getAnimeById(animeId)
    const live = d && d.source === 'live' ? d : null
    detailsCache.set(animeId, { details: live, at: Date.now() })
    return live
  } catch {
    detailsCache.set(animeId, { details: null, at: Date.now() })
    return null
  }
}

// --- сбор данных ------------------------------------------------------------------

interface AccountData {
  numericId: string
  nickname: string
  lists: YummyLibraryList[]
}

async function loadAccount(force: boolean): Promise<AccountData | { error: string }> {
  const session = await loadWebSession()
  if (!session) return { error: 'NO_SESSION' }
  const profile = await fetchProfile(session.cookie)
  if (profile.status === 401 || profile.status === 403) return { error: 'SESSION_EXPIRED' }
  if (profile.status !== 200) return { error: `SITE_HTTP_${profile.status}` }
  const user = parseProfile(profile.body)
  const numericId = user?.userId?.match(/^(\d+)$/)?.[1] ?? null
  if (!numericId) return { error: 'NO_NUMERIC_ID' }

  if (!force && libCache && libCache.at + LIB_TTL > Date.now()) {
    return {
      numericId,
      nickname: user?.displayName ?? user?.username ?? 'Аккаунт',
      lists: libCache.lists,
    }
  }

  const order = [0, 1, 2, 3, 5, 4] as const
  const settled = await Promise.all(
    order.map(async (listId) => ({
      listId,
      ...(await fetchUserList(session.cookie, numericId, listId)),
    })),
  )
  const lists: YummyLibraryList[] = []
  for (const s of settled) {
    if (s.status === 200)
      lists.push({
        listId: s.listId,
        name: '',
        count: 0,
        items: parseLibraryItems(s.body),
      })
  }
  if (lists.length === 0) return { error: 'LISTS_UNAVAILABLE' }
  libCache = { lists, at: Date.now() }
  return { numericId, nickname: user?.displayName ?? user?.username ?? 'Аккаунт', lists }
}

// --- сбор кандидатов -------------------------------------------------------------

const MAX_ANCHOR_ENRICH = 16
const MAX_CANDIDATES = 42
const CATALOG_SOURCES: Array<{ section: 'top100' | 'ongoing' | 'catalog'; page: number }> = [
  { section: 'top100', page: 1 },
  { section: 'top100', page: 2 },
  { section: 'ongoing', page: 1 },
  { section: 'catalog', page: 1 },
]

interface CollectResult {
  candidates: RecCandidate[]
  anchorMeta: Map<number, { genres: string[]; studios: string[] }>
  siteErrors: number
}

async function collectCandidates(
  positiveAnchorIds: Array<{ animeId: number; strength: number }>,
  settings: RecEngineSettings,
): Promise<CollectResult> {
  let siteErrors = 0
  const anchorMeta = new Map<number, { genres: string[]; studios: string[] }>()

  // 1. Обогащение якорей (жанры/студии/франшиза) — топ по силе, батчами
  const anchorIds = positiveAnchorIds
    .slice()
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_ANCHOR_ENRICH)
  const anchorDetails = await mapLimit(anchorIds, 4, async (a) => ({
    id: a.animeId,
    strength: a.strength,
    details: await getLiveDetails(a.animeId),
  }))
  for (const { id, details } of anchorDetails) {
    if (!details) {
      siteErrors++
      continue
    }
    anchorMeta.set(id, { genres: details.genres ?? [], studios: details.studios ?? [] })
  }

  // 2. Кандидаты из франшиз позитивных якорей (viewing_order уже в деталях)
  const candidates: RecCandidate[] = []
  const seenIds = new Set<number>()
  const franchiseQueue: Array<{
    item: Parameters<typeof franchiseToCandidate>[0]
    parent: { animeId: number; title: string; strength: number }
    prio: number
  }> = []
  for (const { id, strength, details } of anchorDetails) {
    if (!details || strength <= 0) continue
    for (const rel of details.viewingOrder ?? []) {
      if (rel.isCurrent || rel.animeId === id) continue
      franchiseQueue.push({
        item: rel,
        parent: { animeId: id, title: details.title, strength },
        prio: strength * franchiseKind(rel.relation),
      })
    }
  }
  franchiseQueue.sort((a, b) => b.prio - a.prio)
  for (const f of franchiseQueue) {
    if (candidates.length >= MAX_CANDIDATES) break
    if (seenIds.has(f.item.animeId)) continue
    seenIds.add(f.item.animeId)
    candidates.push(franchiseToCandidate(f.item, f.parent))
  }

  // 3. Кандидаты из каталога сайта (живые секции; demo/ошибки пропускаем честно)
  const cards = await mapLimit(CATALOG_SOURCES, 2, async (src) => {
    try {
      const page = await getAdapter().getSection(src.section, src.page)
      return page.source === 'demo' ? [] : page.items
    } catch {
      return []
    }
  })
  const CATALOG_CAP = MAX_CANDIDATES + 20
  for (const list of cards) {
    for (const card of list) {
      if (candidates.length >= CATALOG_CAP) break
      if (seenIds.has(card.animeId)) continue
      seenIds.add(card.animeId)
      candidates.push(cardToCandidate(card))
    }
  }

  // 4. Опционально AniList: MAL ID позитивных якорей → рекомендации → поиск по сайту
  if (settings.useAnilist) {
    const malIds = anchorDetails
      .map((a) => a.details?.malId ?? null)
      .filter((x): x is number => typeof x === 'number')
    if (malIds.length > 0) {
      const recs = await fetchAnilistRecommendations(malIds)
      // Каждое название AniList ищем в YummyAnime — берём ТОЧНОЕ совпадение
      const found = await mapLimit(recs.slice(0, 12), 3, async (rec) => {
        try {
          const res = await getAdapter().searchAnime(rec.searchTitle)
          const norm = rec.title.trim().toLowerCase()
          const hit = res.find((r) => r.title.trim().toLowerCase() === norm)
          return hit ?? null
        } catch {
          return null
        }
      })
      for (const hit of found) {
        if (!hit || seenIds.has(hit.animeId)) continue
        if (candidates.length >= CATALOG_CAP) break
        seenIds.add(hit.animeId)
        candidates.push({ ...cardToCandidate(hit), origin: 'anilist' })
      }
    }
  }

  // 5. Обогащение кандидатов (жанры/студии/рейтинг) — батчами; неудачи не блокируют
  const enriched = await mapLimit(candidates, 5, async (c) => {
    const d = await getLiveDetails(c.animeId)
    if (!d) {
      siteErrors++
      return c // скорим тем, что есть (франшиза/качество-нейтраль)
    }
    return {
      ...c,
      genres: d.genres ?? [],
      studios: d.studios ?? [],
      rating: d.rating ?? c.rating,
      malId: d.malId ?? null,
    } satisfies RecCandidate
  })

  return { candidates: enriched, anchorMeta, siteErrors }
}

// --- снапшот (lib/recs/snapshot.ts) ------------------------------------------------

// --- GET ---------------------------------------------------------------------------

function parseSettings(req: NextRequest): RecEngineSettings {
  const sp = req.nextUrl.searchParams
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(sp.get(k))
    return Number.isFinite(v) && v >= lo && v <= hi ? v : d
  }
  return {
    ratingThreshold: num('threshold', DEFAULT_REC_SETTINGS.ratingThreshold, 1, 10),
    excludeKnown: sp.get('excludeKnown') !== '0',
    diversity: sp.get('diversity') !== '0',
    useAnilist: sp.get('anilist') === '1',
  }
}

export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get('refresh') === '1'
  const settings = parseSettings(req)

  // 1. Аккаунт (сессия сайта — сервер-авторитетно)
  const acc = await loadAccount(refresh)
  if ('error' in acc) {
    const mode: RecsResponse['mode'] =
      acc.error === 'NO_SESSION' || acc.error === 'SESSION_EXPIRED' ? 'logged-out' : 'unavailable'
    const reason =
      acc.error === 'NO_SESSION'
        ? 'Войдите в аккаунт YummyAnime — рекомендации строятся по вашей библиотеке на сайте'
        : acc.error === 'SESSION_EXPIRED'
          ? 'Сессия YummyAnime истекла — войдите заново'
          : acc.error === 'LISTS_UNAVAILABLE'
            ? 'Сайт YummyAnime недоступен — не удалось прочитать библиотеку'
            : `Сайт недоступен (${acc.error})`
    return NextResponse.json<RecsResponse>({
      ok: false,
      mode,
      items: [],
      profileSummary: null,
      message: null,
      reason,
      stale: false,
      cached: false,
      computedAt: null,
      feedback: [],
    })
  }

  // 2. Локальный трекинг + обратная связь
  const [progressRows, feedbackRows] = await Promise.all([
    db.watchProgressEntry
      .findMany({ where: { accountKey: acc.numericId }, orderBy: { updatedAt: 'desc' }, take: 50 })
      .catch(() => []),
    db.recFeedback.findMany({ where: { accountKey: acc.numericId } }).catch(() => []),
  ])
  const feedback = feedbackRows.map((f) => ({ animeId: f.animeId, action: f.action, title: f.title }))
  const feedbackHiddenIds = new Set(feedbackRows.map((f) => f.animeId))

  // 3. Фингерпринт входа: те же данные + настройки → мгновенный ответ (без пересчёта)
  const fingerprint = sha256(
    JSON.stringify({
      numericId: acc.numericId,
      lists: acc.lists,
      progress: progressRows.map((p) => [p.animeId, p.episode, p.updatedAt?.toISOString?.() ?? null]),
      feedback,
      settings,
    }),
  )

  if (!refresh) {
    const snap = await loadRecsSnapshot(acc.numericId)
    if (snap && snap.fingerprint === fingerprint) {
      return NextResponse.json<RecsResponse>({ ...snap.response, stale: false, cached: true })
    }
  }

  // 4. Профиль + кандидаты + движок
  try {
    const profile = buildProfile(
      acc.numericId,
      acc.lists,
      progressRows.map((p) => ({
        animeId: p.animeId,
        slug: p.slug,
        title: p.title,
        poster: p.poster,
        episode: p.episode,
      })),
      settings,
    )
    const positiveAnchorIds = profile.anchors
      .filter((a) => !a.negative && a.strength > 0)
      .map((a) => ({ animeId: a.entry.animeId, strength: a.strength }))

    const { candidates, anchorMeta } = await collectCandidates(positiveAnchorIds, settings)
    applyAnchorMetadata(profile, anchorMeta)

    const result = computeRecommendations({ profile, candidates, settings, feedbackHiddenIds })

    const computedAt = new Date().toISOString()
    const response: Omit<RecsResponse, 'stale' | 'cached'> = {
      ok: true,
      mode: result.mode,
      items: result.items,
      profileSummary: { ...result.profileSummary, topGenres: topGenres(profile, 5) },
      message: result.message,
      reason: null,
      computedAt,
      feedback,
    }
    await saveRecsSnapshot(acc.numericId, { fingerprint, computedAt, response })
    return NextResponse.json<RecsResponse>({ ...response, stale: false, cached: false })
  } catch (e) {
    // Сеть/сайт упали в процессе — честный stale-снапшот или честная ошибка
    const snap = await loadRecsSnapshot(acc.numericId)
    if (snap) {
      return NextResponse.json<RecsResponse>({ ...snap.response, stale: true, cached: false })
    }
    return NextResponse.json<RecsResponse>({
      ok: false,
      mode: 'unavailable',
      items: [],
      profileSummary: null,
      message: null,
      reason: `Не удалось собрать рекомендации: ${e instanceof Error ? e.message : 'ошибка'}`,
      stale: false,
      cached: false,
      computedAt: null,
      feedback,
    })
  }
}
