/**
 * ReleaseMeta — многоисточниковая система дат выхода, трейлеров и расписания
 * серий (ТЗ «анонсы: даты + трейлеры + авто-переключение» и §14 «календарь»).
 *
 * ИСТОЧНИКИ (LIVE-VERIFY 2026-10):
 *  1. YummyAnime /api/anime/{id}        — эпisodes.next_date (часто
 *     ПЛЕЙСХОЛДЕР: «1 января 00:00 UTC» = «в таком-то году», «1 июля» =
 *     тоже год), episodes.prev_date, remote_ids.myanimelist_id, year,
 *     anime_status.alias (released|ongoing|announcement).
 *  2. YummyAnime /api/anime/{id}/trailers — официальные трейлеры/тизеры
 *     сайта: [{trailer_id, number:"Тизер", iframe_url:"youtube.com/embed/ID"}].
 *  3. AniList GraphQL (graphql.anilist.co, без ключа, Page(idMal_in) —
 *     батч до 50 тайтлов ОДНИМ запросом): status, startDate{y,m,d} с
 *     частичной точностью, trailer{site:'youtube', id},
 *     nextAiringEpisode{episode, airingAt} — ТОЧНОЕ время следующей серии.
 *  4. Jikan v4 (api.jikan.moe, лимит 3 rps) — резерв, когда AniList не знает
 *     MAL id; даёт trailer.youtube_id и broadcast {day,time,timezone}.
 *
 * ПРАВИЛА ЧЕСТНОСТИ (ТЗ §3, §14.9):
 *  - даты не придумываются; точность честная: день/месяц/год/неизвестно;
 *  - плейсхолдеры сайта (1 янв / 1 июл 00:00 UTC) не выдаются за точные даты;
 *  - известная дата не перезаписывается пустым значением другого источника;
 *  - конфликт источников фиксируется в note, приоритет — сайт воспроизведения;
 *  - серия не становится «вышедшей» от наступления даты — только от факта
 *    (videos/aired с сайта или nextAiringEpisode AniList).
 *
 * Кэш: TTL в памяти (LRU) — трейлеры 6 ч, внешние метаданные 6 ч, сводные
 * ReleaseMeta 3 ч; повторные открытия страниц не бьют по API.
 */
import type {
  EpisodeScheduleInfo,
  NextEpisodeInfo,
  ReleaseDateInfo,
  ReleaseMeta,
  ReleasePrecision,
  ReleaseStatus,
  TrailerInfo,
} from '@/lib/avc/types'
import { getAdapter } from './adapter'

// --- TTL-кэш (LRU) -------------------------------------------------------------

interface CacheEntry<T> {
  data: T
  expires: number
}

function makeCache(maxEntries: number) {
  const map = new Map<string, CacheEntry<unknown>>()
  return {
    get<T>(key: string): T | null {
      const e = map.get(key)
      if (!e) return null
      if (e.expires <= Date.now()) {
        map.delete(key)
        return null
      }
      return e.data as T
    },
    set<T>(key: string, data: T, ttlMs: number): T {
      while (map.size >= maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      map.set(key, { data, expires: Date.now() + ttlMs })
      return data
    },
  }
}

const trailerCache = makeCache(600) // 6 ч
const EXTERNAL_TTL = 6 * 60 * 60 * 1000 // 6 ч
const metaCache = makeCache(800) // 3 ч
const META_TTL = 3 * 60 * 60 * 1000

// --- HTTP ----------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(t)
  }
}

/** AniList GraphQL: ошибки сети/лимитов → null (честно нет данных) */
async function anilistQuery<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(
      'https://graphql.anilist.co',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      9000,
    )
    if (!res.ok) return null
    const json = (await res.json()) as { data?: T; errors?: unknown }
    if (!json.data || (Array.isArray(json.errors) && json.errors.length > 0)) return null
    return json.data
  } catch {
    return null
  }
}

// --- внешние метаданные ---------------------------------------------------------

interface AniListMedia {
  idMal: number | null
  status: string | null // NOT_YET_RELEASED | RELEASING | FINISHED | CANCELLED | HIATUS | NOT_YET_AIRED
  startDate: { year: number | null; month: number | null; day: number | null } | null
  trailer: { id: string | null; site: string | null } | null
  nextAiringEpisode: { episode: number; airingAt: number } | null
}

interface ExternalMeta {
  status: string | null
  startYear: number | null
  startMonth: number | null
  startDay: number | null
  trailerYoutubeId: string | null
  nextEpisode: NextEpisodeInfo | null
  source: 'anilist' | 'jikan'
}

const ANILIST_PAGE_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: ANIME) {
      idMal
      status
      startDate { year month day }
      trailer { id site }
      nextAiringEpisode { episode airingAt }
    }
  }
}`

/**
 * Батч-метаданные AniList по MAL ID: ОДИН запрос на пакет (до 50) —
 * секция «Анонсы» не устраивает шторм по одному тайтлу.
 */
export async function fetchAniListBatch(malIds: number[]): Promise<Map<number, ExternalMeta>> {
  const out = new Map<number, ExternalMeta>()
  const ids = [...new Set(malIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50)
  if (ids.length === 0) return out

  // Сначала кэш
  const missing: number[] = []
  for (const id of ids) {
    const cached = trailerCache.get<ExternalMeta | null>(`anilist:${id}`)
    if (cached !== null) out.set(id, cached)
    else missing.push(id)
  }
  if (missing.length === 0) return out

  const data = await anilistQuery<{ Page: { media: AniListMedia[] } }>(ANILIST_PAGE_QUERY, { ids: missing })
  const mediaList = data?.Page?.media ?? []
  const byMal = new Map<number, AniListMedia>()
  for (const m of mediaList) {
    if (typeof m.idMal === 'number' && m.idMal > 0) byMal.set(m.idMal, m)
  }
  for (const id of missing) {
    const m = byMal.get(id)
    const ext: ExternalMeta | null = m
      ? {
          status: m.status ?? null,
          startYear: m.startDate?.year ?? null,
          startMonth: m.startDate?.month ?? null,
          startDay: m.startDate?.day ?? null,
          trailerYoutubeId: m.trailer && m.trailer.site === 'youtube' && m.trailer.id ? m.trailer.id : null,
          nextEpisode:
            m.nextAiringEpisode &&
            typeof m.nextAiringEpisode.airingAt === 'number' &&
            m.nextAiringEpisode.airingAt > 1_000_000_000
              ? {
                  number: m.nextAiringEpisode.episode,
                  at: m.nextAiringEpisode.airingAt,
                  source: 'anilist',
                }
              : null,
          source: 'anilist',
        }
      : // Не найдено — кэшируем НОЛЬ, чтобы не повторять запрос (6 ч)
        null
    trailerCache.set(`anilist:${id}`, ext, EXTERNAL_TTL)
    if (ext) out.set(id, ext)
  }
  return out
}

/** Jikan (резерв): только одиночный тайтл, короткий таймаут, сбои → null */
async function fetchJikanMeta(malId: number): Promise<ExternalMeta | null> {
  const cached = trailerCache.get<ExternalMeta | null>(`jikan:${malId}`)
  if (cached !== null) return cached
  try {
    const res = await fetchWithTimeout(`https://api.jikan.moe/v4/anime/${malId}`, {}, 8000)
    if (!res.ok) {
      trailerCache.set(`jikan:${malId}`, null, EXTERNAL_TTL)
      return null
    }
    const json = (await res.json()) as {
      data?: {
        status?: string
        trailer?: { youtube_id?: string | null } | null
        aired?: { from?: string | null } | null
        year?: number | null
        broadcast?: { day?: string | null; time?: string | null; timezone?: string | null } | null
      }
    }
    const d = json.data
    if (!d) {
      trailerCache.set(`jikan:${malId}`, null, EXTERNAL_TTL)
      return null
    }
    const from = d.aired?.from ? new Date(d.aired.from) : null
    const ext: ExternalMeta = {
      status: d.status ?? null,
      startYear: from && Number.isFinite(from.getTime()) ? from.getUTCFullYear() : (d.year ?? null),
      startMonth: from && Number.isFinite(from.getTime()) ? from.getUTCMonth() + 1 : null,
      startDay: from && Number.isFinite(from.getTime()) ? from.getUTCDate() : null,
      trailerYoutubeId: d.trailer?.youtube_id ?? null,
      nextEpisode: null,
      source: 'jikan',
    }
    trailerCache.set(`jikan:${malId}`, ext, EXTERNAL_TTL)
    return ext
  } catch {
    return null
  }
}

// --- трейлеры сайта -------------------------------------------------------------

interface ApiTrailerItem {
  trailer_id?: unknown
  number?: unknown
  iframe_url?: unknown
  player?: unknown
  dubbing?: unknown
}

/** YouTube ID из iframe_url сайта («youtube.com/embed/ID», «youtu.be/ID») */
export function youtubeIdFromEmbed(url: string): string | null {
  const m =
    url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,20})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/) ??
    url.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,20})/)
  return m?.[1] ?? null
}

/** Официальные трейлеры/тизеры с сайта (кэш 6 ч). Пусто → [] */
export async function getSiteTrailers(animeId: number): Promise<TrailerInfo[]> {
  const key = `sitetrailers:${animeId}`
  const cached = trailerCache.get<TrailerInfo[]>(key)
  if (cached) return cached
  const base = getAdapter().baseUrl
  try {
    const res = await fetchWithTimeout(
      `${base}/api/anime/${animeId}/trailers`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
      10000,
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { response?: ApiTrailerItem[] }
    const out: TrailerInfo[] = []
    for (const t of json.response ?? []) {
      const url = typeof t.iframe_url === 'string' ? t.iframe_url : ''
      const id = youtubeIdFromEmbed(url)
      if (!id) continue // не-YouTube плееры не встраиваем честно
      const label = typeof t.number === 'string' && t.number.trim() ? t.number.trim() : 'Трейлер'
      out.push({ youtubeId: id, title: label, source: 'yummy' })
    }
    trailerCache.set(key, out, EXTERNAL_TTL)
    return out
  } catch {
    return [] // сеть/лимиты — честно без трейлеров, но НЕ ложь о статусе
  }
}

// --- слияние дат ----------------------------------------------------------------

const MONTHS_NOM = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

/**
 * Плейсхолдер сайта: 1 января или 1 июля 00:00:00 UTC.
 * LIVE-VERIFY: у десятков анонсов 2027 один и тот же unix 1798761600
 * (= 2027-01-01 00:00 UTC) — это «в 2027 году», а не дата премьеры.
 */
export function isPlaceholderDate(unix: number): boolean {
  const d = new Date(unix * 1000)
  return (
    d.getUTCMilliseconds() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCHours() === 0 &&
    d.getUTCDate() === 1 &&
    (d.getUTCMonth() === 0 || d.getUTCMonth() === 6)
  )
}

function precisionOf(y: number | null, m: number | null, d: number | null): ReleasePrecision {
  if (y === null) return 'unknown'
  if (d !== null) return 'day'
  if (m !== null) return 'month'
  return 'year'
}

function dayUnix(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 1000)
}

/** «11 октября 2026» — для note о конфликте источников */
function fmtDay(y: number, m: number, d: number): string {
  return `${d} ${MONTHS_GEN_RU[m - 1]} ${y}`
}

const MONTHS_GEN_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * Слияние дат сайта и внешнего источника (ТЗ §3: не перезаписывать известную
 * дату пустотой; конфликт — фиксировать, приоритет у сайта воспроизведения).
 */
export function mergeReleaseDate(
  siteNextDate: number | null,
  siteYear: number | null,
  ext: ExternalMeta | null,
): ReleaseDateInfo {
  const siteReal = siteNextDate !== null && siteNextDate > 1_000_000_000

  // 1. У сайта точная (не плейсхолдер) дата — она главная (сайт воспроизведения)
  if (siteReal && !isPlaceholderDate(siteNextDate)) {
    const d = new Date(siteNextDate * 1000)
    const info: ReleaseDateInfo = {
      precision: 'day',
      unix: siteNextDate,
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      source: 'yummy',
      confirmed: true,
      note: null,
    }
    // Конфликт с AniList (оба день, разные даты) — честная пометка
    if (ext?.startDay && ext.startMonth && ext.startYear) {
      const extUnix = dayUnix(ext.startYear, ext.startMonth, ext.startDay)
      const siteDay = dayUnix(info.y!, info.m!, info.d!)
      if (extUnix !== siteDay) {
        info.confirmed = false
        info.note = `по AniList: ${fmtDay(ext.startYear, ext.startMonth, ext.startDay)}`
      }
    }
    return info
  }

  // 2. Плейсхолдер сайта («в 2027») — пробуем уточнить по внешнему источнику
  const placeholderYear = siteReal && isPlaceholderDate(siteNextDate) ? new Date(siteNextDate * 1000).getUTCFullYear() : null

  if (ext) {
    const p = precisionOf(ext.startYear, ext.startMonth, ext.startDay)
    if (p !== 'unknown') {
      return {
        precision: p,
        unix:
          p === 'day'
            ? dayUnix(ext.startYear!, ext.startMonth!, ext.startDay!)
            : null,
        y: ext.startYear,
        m: ext.startMonth,
        d: ext.startDay,
        source: ext.source,
        confirmed: true,
        note:
          placeholderYear !== null && ext.startYear === placeholderYear
            ? 'сайт указывает только год'
            : null,
      }
    }
  }

  if (placeholderYear !== null) {
    return {
      precision: 'year',
      unix: null,
      y: placeholderYear,
      m: null,
      d: null,
      source: 'yummy',
      confirmed: true,
      note: null,
    }
  }

  // 3. У сайта ничего — внешний источник (частичная точность допустима)
  if (ext) {
    const p = precisionOf(ext.startYear, ext.startMonth, ext.startDay)
    if (p !== 'unknown') {
      return {
        precision: p,
        unix: p === 'day' ? dayUnix(ext.startYear!, ext.startMonth!, ext.startDay!) : null,
        y: ext.startYear,
        m: ext.startMonth,
        d: ext.startDay,
        source: ext.source,
        confirmed: true,
        note: null,
      }
    }
  }

  // 4. Ничего не знаем — честно «не объявлена»
  return { precision: 'unknown', unix: null, y: null, m: null, d: null, source: 'none', confirmed: false, note: null }
}

// --- статус и расписание ---------------------------------------------------------

const WEEKDAYS_RU: Record<string, number> = {
  monday: 1, tuesdays: 2, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
}

interface JikanBroadcast {
  day?: string | null
  time?: string | null
  timezone?: string | null
}

/** Еженедельный слот в Астане из unix-времени серии (UTC+5: день недели/час/мин) */
export function almatyWeeklyFromUnix(unixSec: number): { weekday: number; hh: number; mm: number } {
  const shifted = new Date((unixSec + 5 * 3600) * 1000) // время Астаны как UTC
  const weekday = ((shifted.getUTCDay() + 6) % 7) + 1 // Пн=1…Вс=7
  return { weekday, hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes() }
}

/** Еженедельный слот из Jikan broadcast {day:'Mondays', time:'23:00', timezone:'Asia/Tokyo'} */
export function parseJikanWeekly(b: JikanBroadcast | null | undefined): { weekday: number; hh: number; mm: number } | null {
  if (!b || !b.day || !b.time) return null
  const day = WEEKDAYS_RU[String(b.day).toLowerCase().replace(/s$/, '')]
  const tm = /^(\d{1,2}):(\d{2})/.exec(String(b.time))
  if (!day || !tm) return null
  const hh = parseInt(tm[1], 10)
  const mm = parseInt(tm[2], 10)
  // Часовой пояс вещания (обычно Asia/Tokyo) → Астана (UTC+5). Jikan отдаёт
  // время с tz; конвертируем честно через Date (JST=UTC+9).
  const tz = String(b.timezone ?? 'Asia/Tokyo')
  let utcHh = hh
  if (tz === 'Asia/Tokyo') utcHh = hh - 9
  else if (tz === 'UTC') utcHh = hh
  else if (tz === 'Asia/Almaty') utcHh = hh - 5
  else return null // неизвестный пояс — не выдумываем
  // Приводим к Астане (UTC+5)
  let almatyHh = utcHh + 5
  let dayShift = 0
  while (almatyHh < 0) {
    almatyHh += 24
    dayShift -= 1
  }
  while (almatyHh >= 24) {
    almatyHh -= 24
    dayShift += 1
  }
  let weekday = ((day + dayShift - 1) % 7) + 1
  if (weekday < 1) weekday += 7
  return { weekday, hh: almatyHh, mm }
}

/** Сводный статус тайтла (ТЗ §6: состояния ANNOUNCED…DELAYED) */
export function resolveStatus(input: {
  siteAlias: string | null
  aired: number
  hasVideos: boolean
  date: ReleaseDateInfo
  extStatus: string | null
  nowSec: number
}): { status: ReleaseStatus; note: string | null } {
  const { siteAlias, aired, hasVideos, date, extStatus, nowSec } = input
  const alias = (siteAlias ?? '').toLowerCase()
  const anilist = (extStatus ?? '').toUpperCase()

  if (alias === 'released' || anilist === 'FINISHED') {
    return { status: 'released', note: null }
  }
  // Факт выхода серий — главный признак «вышло» (ТЗ §6: дата ≠ факт)
  if (hasVideos || aired > 0 || anilist === 'RELEASING') {
    return { status: 'airing', note: null }
  }
  if (anilist === 'CANCELLED') {
    return { status: 'delayed', note: 'производство отменено (AniList)' }
  }
  if (alias === 'announcement' || anilist === 'NOT_YET_RELEASED' || alias === '' || alias === 'ongoing') {
    // Дата премьеры уже прошла, серий нет → перенос (не выдумываем новую дату)
    if (date.precision === 'day' && date.unix !== null && date.unix < nowSec) {
      return {
        status: 'delayed',
        note: 'премьера ожидалась раньше — серии ещё не появились',
      }
    }
    if (date.precision !== 'unknown') return { status: 'upcoming', note: null }
    return { status: 'announced', note: null }
  }
  return { status: 'unknown', note: null }
}

// --- сводная сборка --------------------------------------------------------------

interface SiteDetailsLite {
  animeId: number
  title: string
  malId: number | null
  year: number | null
  statusAlias: string | null
  nextDate: number | null
  prevDate: number | null
  aired: number
  videosCount: number
}

/**
 * Лёгкое чтение деталей сайта — ТОЛЬКО из кэша адаптера (без повторных
 * запросов): адаптер отдаёт nextEpisodeAt/episodesPrevDate/statusAlias.
 */
async function readSiteDetails(animeId: number): Promise<SiteDetailsLite | null> {
  const d = await getAdapter().getAnimeById(animeId)
  if (!d || d.source === 'demo') return null
  const aliasMap: Record<string, string> = { 'анонс': 'announcement', 'онгоинг': 'ongoing', 'вышел': 'released' }
  const statusLower = (d.statusAlias ?? d.status ?? '').toLowerCase()
  return {
    animeId: d.animeId,
    title: d.title,
    malId: d.malId ?? null,
    year: d.year ?? null,
    statusAlias: aliasMap[statusLower] ?? statusLower ?? null,
    nextDate: typeof d.nextEpisodeAt === 'number' && d.nextEpisodeAt > 1_000_000_000 ? d.nextEpisodeAt : null,
    prevDate: typeof d.episodesPrevDate === 'number' && d.episodesPrevDate > 1_000_000_000 ? d.episodesPrevDate : null,
    aired: d.episodesAired ?? 0,
    videosCount: d.videos?.length ?? 0,
  }
}

/** Сводные метаданные одного тайтла (кэш 3 ч). Ошибки → честный минимальный ответ */
export async function getReleaseMeta(animeId: number, opts?: { forceExternal?: boolean }): Promise<ReleaseMeta> {
  const key = `meta:${animeId}`
  if (!opts?.forceExternal) {
    const cached = metaCache.get<ReleaseMeta>(key)
    if (cached) return cached
  }
  const site = await readSiteDetails(animeId)

  const trailers: TrailerInfo[] = site ? await getSiteTrailers(animeId) : []
  // Резервный трейлер внешнего источника (AniList/MAL), если сайт молчит
  const addExtTrailer = (list: TrailerInfo[], ext: ExternalMeta | null) => {
    if (ext?.trailerYoutubeId && !list.some((t) => t.youtubeId === ext.trailerYoutubeId)) {
      list.push({
        youtubeId: ext.trailerYoutubeId,
        title: ext.source === 'anilist' ? 'Трейлер (AniList)' : 'Трейлер (MyAnimeList)',
        source: ext.source,
      })
    }
  }

  // Внешний источник нужен, когда даты нет/плейсхолдер или трейлеров с сайта нет
  const needExternal =
    opts?.forceExternal === true ||
    (site !== null &&
      (site.nextDate === null || isPlaceholderDate(site.nextDate) || trailers.length === 0))
  let ext: ExternalMeta | null = null
  if (site?.malId && needExternal) {
    const batch = await fetchAniListBatch([site.malId])
    ext = batch.get(site.malId) ?? null
    if (!ext) ext = await fetchJikanMeta(site.malId)
  }

  if (!site) {
    return {
      status: 'unknown',
      releaseDate: { precision: 'unknown', unix: null, y: null, m: null, d: null, source: 'none', confirmed: false, note: null },
      nextEpisode: null,
      schedule: { next: null, weekly: null, estimated: [], announced: false },
      trailers,
      checkedAt: Date.now(),
    }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const date = mergeReleaseDate(site.nextDate, site.year, ext)
  addExtTrailer(trailers, ext)
  const { status, note } = resolveStatus({
    siteAlias: site.statusAlias,
    aired: site.aired,
    hasVideos: site.videosCount > 0,
    date,
    extStatus: ext?.status ?? null,
    nowSec,
  })

  // Следующая серия: факт AniList (точное время) → факт сайта (next_date).
  // Плейсхолдер сайта («в 2027») в серию НЕ превращаем — это дата премьеры
  // с точностью до года, а не время серии (честность ТЗ §14.1).
  let nextEpisode: NextEpisodeInfo | null = null
  if (ext?.nextEpisode) nextEpisode = ext.nextEpisode
  else if (
    site.nextDate !== null &&
    site.nextDate > 1_000_000_000 &&
    !isPlaceholderDate(site.nextDate) &&
    status !== 'released'
  ) {
    nextEpisode = {
      number: site.aired > 0 ? site.aired + 1 : 1,
      at: site.nextDate,
      source: 'yummy',
    }
  }

  // Подтверждённая периодичность: prev и next ровно в 7 дней → еженедельник
  let weekly: { weekday: number; hh: number; mm: number } | null = null
  if (
    site.nextDate !== null &&
    site.prevDate !== null &&
    Math.abs(site.nextDate - site.prevDate) === 7 * 86400
  ) {
    weekly = almatyWeeklyFromUnix(site.nextDate)
  }

  // Расчётные будущие серии: только при подтверждённой периодичности и живом онгоинге
  const estimated: Array<{ number: number; at: number }> = []
  if (weekly && nextEpisode && status === 'airing') {
    for (let i = 1; i <= 4; i++) {
      estimated.push({ number: nextEpisode.number + i, at: nextEpisode.at + i * 7 * 86400 })
    }
  }

  const schedule: EpisodeScheduleInfo = {
    next: nextEpisode,
    weekly,
    estimated,
    announced: nextEpisode !== null || estimated.length > 0,
  }

  const meta: ReleaseMeta = {
    status,
    releaseDate: { ...date, note: note ?? date.note },
    nextEpisode,
    schedule,
    trailers,
    checkedAt: Date.now(),
  }
  return metaCache.set(key, meta, META_TTL)
}

/** Батч для секции «Анонсы»/календаря: максимум 40 тайтлов за вызов */
export async function getReleaseMetaBatch(animeIds: number[]): Promise<Record<number, ReleaseMeta>> {
  const ids = [...new Set(animeIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40)
  const out: Record<number, ReleaseMeta> = {}
  if (ids.length === 0) return out

  // 1. Сайт: детали параллельно (кэш адаптера)
  const siteResults = await Promise.all(ids.map((id) => readSiteDetails(id).catch(() => null)))

  // 2. Трейлеры сайта параллельно (кэш)
  const trailerResults = await Promise.all(ids.map((id) => getSiteTrailers(id).catch(() => [] as TrailerInfo[])))

  // 3. AniList: ОДИН батч по всем, кому нужен внешний источник
  const needExtIds = siteResults
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s !== null && (s!.nextDate === null || isPlaceholderDate(s!.nextDate) || (trailerResults[i] ?? []).length === 0))
    .map(({ s }) => s!.malId)
    .filter((v): v is number => typeof v === 'number' && v > 0)
  const extMap = await fetchAniListBatch(needExtIds)

  const nowSec = Math.floor(Date.now() / 1000)
  ids.forEach((id, i) => {
    const site = siteResults[i]
    if (!site) return
    const trailers = trailerResults[i] ?? []
    const ext = (site.malId ? extMap.get(site.malId) : null) ?? null
    const date = mergeReleaseDate(site.nextDate, site.year, ext)
    if (ext?.trailerYoutubeId && !trailers.some((t) => t.youtubeId === ext.trailerYoutubeId)) {
      trailers.push({
        youtubeId: ext.trailerYoutubeId,
        title: ext.source === 'anilist' ? 'Трейлер (AniList)' : 'Трейлер (MyAnimeList)',
        source: ext.source,
      })
    }
    const { status, note } = resolveStatus({
      siteAlias: site.statusAlias,
      aired: site.aired,
      hasVideos: site.videosCount > 0,
      date,
      extStatus: ext?.status ?? null,
      nowSec,
    })

    let nextEpisode: NextEpisodeInfo | null = null
    if (ext?.nextEpisode) nextEpisode = ext.nextEpisode
    else if (
      site.nextDate !== null &&
      site.nextDate > 1_000_000_000 &&
      !isPlaceholderDate(site.nextDate) &&
      status !== 'released'
    ) {
      nextEpisode = { number: site.aired > 0 ? site.aired + 1 : 1, at: site.nextDate, source: 'yummy' }
    }

    let weekly: { weekday: number; hh: number; mm: number } | null = null
    if (site.nextDate !== null && site.prevDate !== null && Math.abs(site.nextDate - site.prevDate) === 7 * 86400) {
      weekly = almatyWeeklyFromUnix(site.nextDate)
    }

    const estimated: Array<{ number: number; at: number }> = []
    if (weekly && nextEpisode && status === 'airing') {
      for (let k = 1; k <= 4; k++) {
        estimated.push({ number: nextEpisode.number + k, at: nextEpisode.at + k * 7 * 86400 })
      }
    }

    out[id] = {
      status,
      releaseDate: { ...date, note: note ?? date.note },
      nextEpisode,
      schedule: { next: nextEpisode, weekly, estimated, announced: nextEpisode !== null || estimated.length > 0 },
      trailers,
      checkedAt: Date.now(),
    }
  })
  return out
}
