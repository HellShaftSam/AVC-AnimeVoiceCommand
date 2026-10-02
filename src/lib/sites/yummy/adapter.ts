/**
 * YummyAnimeAdapter — серверный адаптер сайта (мастер-промпт #4, #53, #78).
 *
 * Работа БЕЗ координат и DOM-инъекций: у сайта есть JSON API и
 * предсказуемые HTML-секции. Все селекторы собраны в одном месте (SELECTORS),
 * при изменении сайта правится только этот файл.
 *
 * Реальные эндпоинты old.yummyani.me:
 *   GET /api/search?q=            — JSON поиск
 *   GET /api/anime/{id}           — JSON детали (translates, episodes.count/aired)
 *   GET /api/anime/{id}/videos    — JSON матрица серий×озвучек (+iframe плеера)
 *   GET /catalog[/ongoing|/announcement|/schedule|/top] — HTML секции
 *   GET /catalog/random           — 302 редирект на случайный тайтл
 *   GET /catalog/item/{slug}      — HTML страница аниме (data-anime-id)
 */
import {
  AnimeCard,
  AnimeDetails,
  DubOption,
  SectionPage,
  SiteSectionId,
  VideoEntry,
  YummyAccountSnapshot,
  YummyFavoritesResult,
  YummyFavoriteItem,
  YummyUserSnapshot,
} from '@/lib/avc/types'
import { IAnimeSiteAdapter, SiteDiagnostics } from '../types'
import { getYummySessionCookie } from './session-store'
import {
  demoDetails,
  demoRandom,
  demoSearch,
  demoSection,
  SECTION_TITLES,
} from './fallback'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** Все селекторы/шаблоны в одном месте (мастер-промпт #53) */
const SELECTORS = {
  card: /<div class="anime-column[^"]*" data-anime-id="(\d+)">([\s\S]*?)(?=<div class="anime-column[^"]*" data-anime-id=|<\/div>\s*<\/div>\s*<\/div>|$)/g,
  cardSlug: /href="\/catalog\/item\/([a-z0-9-]+)"/i,
  cardTitle: /class="anime-title"[^>]*>([^<]+)</i,
  cardPoster: /<img[^>]+src="([^"]+posters[^"]+)"/i,
  cardType: /anime-column-info[\s\S]*?anime-title[^>]*>[^<]+<\/a>\s*<div>([^<]+)<\/div>/i,
  pagination: /catalog\/(?:[^/?]+)\/?\?page=(\d+)/g,
  animeIdOnPage: /data-anime-id="(\d+)"/,
  slugFromUrl: /\/catalog\/item\/([a-z0-9-]+)/i,
}

// --- кэш (мастер-промпт #88: без постоянного поллинга, TTL-кэш) --------------

interface CacheEntry<T> {
  data: T
  expires: number
}

const cache = new Map<string, CacheEntry<unknown>>()
const CACHE_TTL = 5 * 60 * 1000

function cacheGet<T>(key: string): T | null {
  const e = cache.get(key)
  if (e && e.expires > Date.now()) return e.data as T
  if (e) cache.delete(key)
  return null
}

function cacheSet<T>(key: string, data: T): T {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL })
  return data
}

export function clearSiteCache() {
  cache.clear()
}

// --- HTTP helpers ------------------------------------------------------------

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function fetchJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

// --- парсинг HTML карточек ---------------------------------------------------

function parseCards(html: string): AnimeCard[] {
  const cards: AnimeCard[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  SELECTORS.card.lastIndex = 0
  while ((m = SELECTORS.card.exec(html)) !== null) {
    const id = parseInt(m[1], 10)
    const block = m[2]
    const slug = block.match(SELECTORS.cardSlug)?.[1]
    const title = block.match(SELECTORS.cardTitle)?.[1]?.trim()
    if (!slug || !title || seen.has(slug)) continue
    seen.add(slug)
    const posterRaw = block.match(SELECTORS.cardPoster)?.[1] ?? null
    cards.push({
      animeId: id,
      slug,
      title,
      poster: posterRaw ? (posterRaw.startsWith('//') ? `https:${posterRaw}` : posterRaw) : null,
      year: null,
      rating: null,
      status: null,
      type: block.match(SELECTORS.cardType)?.[1]?.trim() ?? null,
    })
  }
  return cards
}

function parseTotalPages(html: string): number | null {
  let max = 1
  let m: RegExpExecArray | null
  SELECTORS.pagination.lastIndex = 0
  while ((m = SELECTORS.pagination.exec(html)) !== null) {
    max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

// --- секции ------------------------------------------------------------------

const SECTION_PATHS: Record<Exclude<SiteSectionId, 'home' | 'random'>, string> = {
  catalog: '/catalog',
  ongoing: '/catalog/ongoing',
  announcements: '/catalog/announcement',
  schedule: '/catalog/schedule',
  top100: '/catalog/top',
}

// --- API-типы сайта ----------------------------------------------------------

interface ApiSearchItem {
  anime_id: number
  anime_url: string
  title: string
  year: number
  poster: { medium?: string; big?: string; small?: string }
  anime_status: { title: string }
  type: { shortname: string }
  rating: { average: number }
}

interface ApiAnimeDetails {
  anime_id: number
  anime_url: string
  title: string
  description: string
  year: number
  poster: { medium?: string; big?: string }
  rating: { average: number }
  anime_status: { title: string }
  type: { shortname: string }
  genres: Array<{ title: string }>
  studios: Array<{ title: string }>
  translates: Array<{ value: number; title: string; href: string }>
  episodes: { count: number; aired: number }
}

interface ApiVideoItem {
  video_id: number
  number: string
  iframe_url: string
  duration: number
  data: { player: string; dubbing: string }
}

// --- адаптер -----------------------------------------------------------------

export class YummyAnimeAdapter implements IAnimeSiteAdapter {
  readonly siteName = 'YummyAnime'
  readonly baseUrl: string
  /** Версия адаптера (спецификация аккаунта, секция 46) — меняем при изменении сайта */
  readonly adapterVersion = '1.1.0-account'

  constructor(baseUrl = 'https://old.yummyani.me') {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async searchAnime(query: string): Promise<AnimeCard[]> {
    const key = `search:${this.baseUrl}:${query}`
    const cached = cacheGet<AnimeCard[]>(key)
    if (cached) return cached
    try {
      const data = await fetchJson<{ response: ApiSearchItem[] }>(
        `${this.baseUrl}/api/search?q=${encodeURIComponent(query)}`,
      )
      const items: AnimeCard[] = (data.response ?? []).map((it) => ({
        animeId: it.anime_id,
        slug: it.anime_url,
        title: it.title,
        poster: it.poster?.medium ? (it.poster.medium.startsWith('//') ? `https:${it.poster.medium}` : it.poster.medium) : null,
        year: it.year ?? null,
        rating: it.rating?.average ?? null,
        status: it.anime_status?.title ?? null,
        type: it.type?.shortname ?? null,
      }))
      return cacheSet(key, items)
    } catch {
      return demoSearch(query)
    }
  }

  async getVideos(animeId: number): Promise<VideoEntry[]> {
    const key = `videos:${this.baseUrl}:${animeId}`
    const cached = cacheGet<VideoEntry[]>(key)
    if (cached) return cached
    try {
      const data = await fetchJson<{ response: ApiVideoItem[] }>(
        `${this.baseUrl}/api/anime/${animeId}/videos`,
      )
      const items: VideoEntry[] = (data.response ?? []).map((v) => ({
        videoId: v.video_id,
        episode: parseInt(v.number, 10) || 0,
        dubName: v.data?.dubbing ?? 'Неизвестная озвучка',
        playerName: v.data?.player ?? '',
        iframeUrl: v.iframe_url ?? '',
        duration: v.duration ?? null,
      }))
      return cacheSet(key, items)
    } catch {
      return []
    }
  }

  async getAnimeById(id: number): Promise<AnimeDetails | null> {
    const key = `anime:${this.baseUrl}:${id}`
    const cached = cacheGet<AnimeDetails>(key)
    if (cached) return cached
    try {
      const [detailsResp, videos] = await Promise.all([
        fetchJson<{ response: ApiAnimeDetails }>(`${this.baseUrl}/api/anime/${id}`),
        this.getVideos(id),
      ])
      const d = detailsResp.response
      const result = this.buildDetails(d, videos)
      return cacheSet(key, result)
    } catch {
      return demoDetails(id)
    }
  }

  async getAnimeBySlug(slug: string): Promise<AnimeDetails | null> {
    const key = `animeslug:${this.baseUrl}:${slug}`
    const cached = cacheGet<AnimeDetails>(key)
    if (cached) return cached
    try {
      // /api/anime/{alias} принимает человекочитаемый alias и возвращает anime_id
      const [detailsResp, first] = await Promise.all([
        fetchJson<{ response: ApiAnimeDetails }>(`${this.baseUrl}/api/anime/${encodeURIComponent(slug)}`),
        Promise.resolve(null as ApiVideoItem[] | null),
      ])
      const d = detailsResp.response
      const videos = await this.getVideos(d.anime_id)
      const result = this.buildDetails(d, videos)
      return cacheSet(key, result)
    } catch {
      return demoDetails(slug)
    }
  }

  async getSection(section: SiteSectionId, page = 1): Promise<SectionPage> {
    if (section === 'home') {
      return {
        section: 'home',
        title: SECTION_TITLES.home,
        page: 1,
        totalPages: 1,
        items: [],
        source: 'live',
      }
    }
    const key = `section:${this.baseUrl}:${section}:${page}`
    const cached = cacheGet<SectionPage>(key)
    if (cached) return { ...cached, source: 'cache' }
    try {
      if (section === 'random') {
        const details = await this.getRandom()
        return {
          section,
          title: SECTION_TITLES.random,
          page: 1,
          totalPages: 1,
          items: details
            ? [
                {
                  animeId: details.animeId,
                  slug: details.slug,
                  title: details.title,
                  poster: details.poster,
                  year: details.year,
                  rating: details.rating,
                  status: details.status,
                  type: details.type,
                },
              ]
            : [],
          source: 'live',
        }
      }
      const path = SECTION_PATHS[section]
      const url = page > 1 ? `${this.baseUrl}${path}/?page=${page}` : `${this.baseUrl}${path}`
      const html = await fetchText(url)
      const items = parseCards(html)
      if (items.length === 0) throw new Error('no cards parsed')
      return cacheSet(key, {
        section,
        title: SECTION_TITLES[section],
        page,
        totalPages: parseTotalPages(html),
        items,
        source: 'live',
      })
    } catch (e) {
      if (process.env.AVC_DEBUG) {
        console.error(`[adapter] getSection(${section}) failed:`, e)
      }
      return demoSection(section, page)
    }
  }

  async getRandom(): Promise<AnimeDetails | null> {
    try {
      // /catalog/random отвечает 302 редиректом на случайный тайтл
      const res = await fetch(`${this.baseUrl}/catalog/random`, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        cache: 'no-store',
      })
      const finalUrl = res.url
      const slug = finalUrl.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1]
      if (!slug) throw new Error('random redirect not parsed')
      return await this.getAnimeBySlug(slug)
    } catch {
      return demoRandom()
    }
  }

  async runDiagnostics(): Promise<SiteDiagnostics[]> {
    const out: SiteDiagnostics[] = []
    const check = async (name: string, fn: () => Promise<string>) => {
      try {
        const detail = await fn()
        out.push({ name, ok: true, detail })
      } catch (e) {
        out.push({ name, ok: false, detail: e instanceof Error ? e.message : 'ошибка' })
      }
    }

    await check('Сайт доступен', async () => {
      await fetchText(this.baseUrl, 8000)
      return this.baseUrl
    })
    await check('Поиск (JSON API)', async () => {
      const r = await this.searchAnime('берсерк')
      if (r.length === 0) throw new Error('пустой результат')
      return `найдено ${r.length}`
    })
    await check('Секция Онгоинги', async () => {
      const s = await this.getSection('ongoing')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Секция ТОП-100', async () => {
      const s = await this.getSection('top100')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Секция Расписание', async () => {
      const s = await this.getSection('schedule')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Случайное аниме', async () => {
      const d = await this.getRandom()
      return d ? d.title : 'нет данных'
    })
    await check('Матрица серий/озвучек (videos API)', async () => {
      const d = await this.getRandom()
      if (!d) throw new Error('нет аниме для теста')
      const v = await this.getVideos(d.animeId)
      if (v.length === 0) throw new Error('пусто')
      return `${v.length} записей, ${d.dubs.length} озвучек`
    })
    return out
  }

  // --- приватное -------------------------------------------------------------

  /** TTL-кэш аккаунта (спецификация секции 14, 40: профиль ~5 минут) */
  private accountCache: CacheEntry<YummyAccountSnapshot> | null = null

  /**
   * fetch с cookie-сессией yummyani.me (если она сохранена в session-store).
   * Cookie нигде не логируем (спецификация секции 37).
   */
  private async fetchWithSession(
    url: string,
    timeoutMs = 12000,
  ): Promise<Response> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const cookie = getYummySessionCookie()
      return await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/html,*/*',
          ...(cookie ? { Cookie: cookie } : {}),
          Referer: `${this.baseUrl}/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: ctrl.signal,
        redirect: 'follow',
        cache: 'no-store',
      })
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * Защитная нормализация JSON профиля сайта. Формат ответа точно не
   * документирован — парсим по образцу публичного /api/users:
   * { response: { id, texts: { left, right }, avatars: { small, big }, ... } }.
   * Ничего не выдумываем: не нашли поле — null (спецификация секции 45).
   */
  private normalizeProfile(body: unknown): YummyUserSnapshot | null {
    if (typeof body !== 'object' || body === null) return null
    const root = body as Record<string, unknown>
    const u = (root.response ?? root.user ?? root) as Record<string, unknown>
    if (typeof u !== 'object' || u === null) return null

    const texts = (u.texts ?? null) as Record<string, unknown> | null
    const avatars = (u.avatars ?? null) as Record<string, unknown> | null
    const ids = (u.ids ?? null) as Record<string, unknown> | null

    const rawId = u.id ?? u.user_id ?? u.userId ?? null
    const id = rawId !== null && rawId !== undefined ? String(rawId) : null

    const nameCandidates = [
      u.name,
      u.login,
      u.username,
      u.nickname,
      ids && typeof ids === 'object' ? (ids as Record<string, unknown>).tg_nickname : null,
      texts && typeof texts === 'object' ? (texts as Record<string, unknown>).left : null,
      texts && typeof texts === 'object' ? (texts as Record<string, unknown>).right : null,
    ]
    const name = nameCandidates.find((v) => typeof v === 'string' && (v as string).trim() !== '')

    const avatarCandidates = [
      u.avatar,
      u.avatar_url,
      avatars && typeof avatars === 'object' ? (avatars as Record<string, unknown>).small : null,
      avatars && typeof avatars === 'object' ? (avatars as Record<string, unknown>).big : null,
    ]
    const avatarRaw = avatarCandidates.find(
      (v) => typeof v === 'string' && (v as string).trim() !== '',
    ) as string | undefined
    let avatarUrl: string | null = null
    if (avatarRaw) {
      avatarUrl = avatarRaw.startsWith('//') ? `https:${avatarRaw}` : avatarRaw
    }

    if (id === null && !name) return null
    return {
      userId: id,
      username: typeof name === 'string' ? name.trim() : null,
      displayName: typeof name === 'string' ? name.trim() : null,
      avatarUrl,
    }
  }

  /**
   * Проверить состояние аккаунта на реальном сайте.
   * GET /api/profile: 200 → залогинен; 401 → сессии нет/истекла (подтверждено
   * живым сайтом). TTL-кэш 5 минут; refresh=true — принудительно (секция 41).
   */
  async getAccountState(opts?: { refresh?: boolean }): Promise<YummyAccountSnapshot> {
    if (!opts?.refresh && this.accountCache && this.accountCache.expires > Date.now()) {
      return { ...this.accountCache.data, source: 'cache' }
    }

    const cookie = getYummySessionCookie()
    if (!cookie) {
      const snap: YummyAccountSnapshot = {
        state: 'loggedOut',
        user: null,
        lastSync: new Date().toISOString(),
        source: 'no-session',
        message: 'Сессия YummyAnime не обнаружена — войдите на сайте',
      }
      this.accountCache = { data: snap, expires: Date.now() + 60_000 }
      return snap
    }

    try {
      const res = await this.fetchWithSession(`${this.baseUrl}/api/profile`)
      if (res.status === 401) {
        const snap: YummyAccountSnapshot = {
          state: 'sessionExpired',
          user: null,
          lastSync: new Date().toISOString(),
          source: 'live',
          message: 'Сессия YummyAnime истекла. Войдите снова.',
        }
        this.accountCache = { data: snap, expires: Date.now() + 60_000 }
        return snap
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as unknown
      const user = this.normalizeProfile(body)
      const snap: YummyAccountSnapshot = {
        state: user ? 'loggedIn' : 'loggedOut',
        user,
        lastSync: new Date().toISOString(),
        source: 'live',
        message: user
          ? `Сайт подтвердил вход: ${user.username ?? 'без имени'}`
          : 'Сайт ответил 200, но профиль не распознан (сайт изменился?)',
      }
      this.accountCache = { data: snap, expires: Date.now() + 5 * 60_000 }
      return snap
    } catch (e) {
      // Сайт недоступен: НЕ стираем кеш (секция 25 — offline behavior)
      const prev = this.accountCache?.data ?? null
      const snap: YummyAccountSnapshot = {
        state: prev?.state === 'loggedIn' ? prev.state : 'unavailable',
        user: prev?.user ?? null,
        lastSync: prev?.lastSync ?? null,
        source: prev ? 'cache' : 'error',
        message: `Сайт недоступен (${e instanceof Error ? e.message : 'ошибка сети'}). Показаны кешированные данные.`,
      }
      this.accountCache = { data: snap, expires: Date.now() + 60_000 }
      return snap
    }
  }

  /**
   * Выход: POST /api/profile/logout (подтверждённый эндпоинт сайта) + локальная
   * очистка cookie выполняется на уровне API-роута.
   */
  async siteLogout(): Promise<boolean> {
    try {
      const res = await this.fetchWithSession(`${this.baseUrl}/api/profile/logout`, 8000)
      return res.ok
    } catch {
      return false
    }
  }

  /** Сбросить кеш аккаунта (после входа/выхода — чтобы UI не показал устаревшее) */
  resetAccountCache(): void {
    this.accountCache = null
    cache.delete(`favorites:${this.baseUrl}`)
  }

  /**
   * Избранное с сайта. Сайт даёт список только через /actions/export-favorites.php
   * (найдено в JS сайта; формат ответа не документирован) — парсим защитно,
   * при любой неудаче честно сообщаем available:false (ничего не выдумываем).
   */
  async getFavorites(opts?: { refresh?: boolean }): Promise<YummyFavoritesResult> {
    const key = `favorites:${this.baseUrl}`
    if (!opts?.refresh) {
      const cached = cacheGet<YummyFavoritesResult>(key)
      if (cached) return { ...cached, lastSync: cached.lastSync }
    }
    const cookie = getYummySessionCookie()
    if (!cookie) {
      return {
        available: false,
        items: [],
        reason: 'Нет сессии YummyAnime — войдите на сайте',
        lastSync: null,
      }
    }
    try {
      const res = await this.fetchWithSession(
        `${this.baseUrl}/actions/export-favorites.php?format=json&vote=0`,
      )
      if (!res.ok) {
        return {
          available: false,
          items: [],
          reason: `Сайт ответил HTTP ${res.status} на export-favorites`,
          lastSync: null,
        }
      }
      const body = (await res.json()) as unknown
      const items = this.normalizeFavorites(body)
      if (items === null) {
        return {
          available: false,
          items: [],
          reason: 'Формат export-favorites не распознан (сайт изменился?) — данные не выдумываем',
          lastSync: null,
        }
      }
      const result: YummyFavoritesResult = {
        available: true,
        items,
        reason: null,
        lastSync: new Date().toISOString(),
      }
      cacheSet(key, result)
      return result
    } catch (e) {
      return {
        available: false,
        items: [],
        reason: `Не удалось получить избранное: ${e instanceof Error ? e.message : 'ошибка сети'}`,
        lastSync: null,
      }
    }
  }

  /**
   * Защитный парсинг export-favorites.php. JS сайта делает .json() и берёт
   * { filename, data } — пробуем data (JSON-строка/массив) и сам массив.
   * Элементы: anime_id/id, title/name, slug/url, poster — все опциональны.
   */
  private normalizeFavorites(body: unknown): YummyFavoriteItem[] | null {
    const tryParse = (v: unknown): unknown => {
      if (typeof v === 'string') {
        try {
          return JSON.parse(v) as unknown
        } catch {
          return null
        }
      }
      return v
    }

    let list: unknown = null
    if (Array.isArray(body)) list = body
    else if (typeof body === 'object' && body !== null) {
      const root = body as Record<string, unknown>
      const data = tryParse(root.data)
      if (Array.isArray(data)) list = data
      else if (Array.isArray(root.items)) list = root.items
      else if (Array.isArray(root.response)) list = root.response
      else if (data && typeof data === 'object') {
        const inner = data as Record<string, unknown>
        if (Array.isArray(inner.favorites)) list = inner.favorites
        else if (Array.isArray(inner.items)) list = inner.items
      }
    }
    if (!Array.isArray(list)) return null

    const out: YummyFavoriteItem[] = []
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const it = raw as Record<string, unknown>
      const title = [it.title, it.name, it.anime_title].find(
        (v) => typeof v === 'string' && (v as string).trim() !== '',
      ) as string | undefined
      const rawId = it.anime_id ?? it.animeId ?? it.id
      const rawSlug =
        typeof it.slug === 'string'
          ? it.slug
          : typeof it.url === 'string'
            ? it.url.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1] ?? it.url
            : null
      if (!title && rawId === undefined && !rawSlug) continue
      const posterRaw =
        typeof it.poster === 'string'
          ? it.poster
          : typeof (it.poster as Record<string, unknown> | undefined)?.medium === 'string'
            ? ((it.poster as Record<string, unknown>).medium as string)
            : null
      out.push({
        animeId: typeof rawId === 'number' ? rawId : null,
        slug: typeof rawSlug === 'string' && rawSlug.trim() !== '' ? rawSlug : null,
        title: title ?? `Аниме #${String(rawId ?? '?')}`,
        poster: posterRaw
          ? posterRaw.startsWith('//')
            ? `https:${posterRaw}`
            : posterRaw
          : null,
      })
    }
    return out
  }

  private buildDetails(d: ApiAnimeDetails, videos: VideoEntry[]): AnimeDetails {
    // Группировка озвучек из матрицы видео (фактически доступные)
    const byDub = new Map<string, Set<number>>()
    for (const v of videos) {
      const name = v.dubName?.trim()
      if (!name) continue
      if (!byDub.has(name)) byDub.set(name, new Set())
      byDub.get(name)!.add(v.episode)
    }
    const dubs: DubOption[] = [...byDub.entries()]
      .map(([name, eps]) => ({
        name,
        shortName: name.replace(/^(Озвучка|Субтитры)\s*/i, '').trim() || name,
        episodes: [...eps].sort((a, b) => a - b),
      }))
      .filter((d) => d.shortName.length > 0)

    // Если озвучек из видео нет — используем translates из деталей
    if (dubs.length === 0 && d.translates) {
      for (const t of d.translates) {
        dubs.push({ name: t.title, shortName: t.title, episodes: [] })
      }
    }

    return {
      animeId: d.anime_id,
      slug: d.anime_url,
      title: d.title,
      poster: d.poster?.medium
        ? d.poster.medium.startsWith('//')
          ? `https:${d.poster.medium}`
          : d.poster.medium
        : null,
      year: d.year ?? null,
      rating: d.rating?.average ?? null,
      status: d.anime_status?.title ?? null,
      type: d.type?.shortname ?? null,
      description: d.description ?? null,
      genres: (d.genres ?? []).map((g) => g.title),
      studios: (d.studios ?? []).map((s) => s.title),
      episodesAired: d.episodes?.aired ?? 0,
      episodesTotal: d.episodes?.count ?? null,
      dubs,
      videos,
    }
  }
}

/** Адаптер по умолчанию (singleton) */
let defaultAdapter: YummyAnimeAdapter | null = null

export function getAdapter(baseUrl?: string): YummyAnimeAdapter {
  if (baseUrl) return new YummyAnimeAdapter(baseUrl)
  if (!defaultAdapter) defaultAdapter = new YummyAnimeAdapter()
  return defaultAdapter
}
