/**
 * YummyAnimeAccountAdapter (Task 17, мастер-промпт #17 «Real-Site Account
 * Integration») — серверный адаптер РЕАЛЬНОГО аккаунта YummyAnime.
 *
 * Вся site-specific логика аккаунта собрана ТОЛЬКО здесь (спека #29):
 *   - URL/заголовки/cookie-семантика;
 *   - детект авторизации по видимому состоянию сайта (GET /api/profile:
 *     200 → залогинен, 401 → аноним) — спека #4 «не считать cookie доказательством»;
 *   - вход ТОЛЬКО штатным механизмом сайта: POST /api/profile/login с тем же
 *     JSON-полезом, что шлёт собственная форма сайта (её же JS-клиент).
 *     Пароль пересылается ровно один раз по HTTPS на сервер сайта, НЕ
 *     хранится и НЕ логируется (спека #3, #37). Капчу/2FA не обходим (спека #3):
 *     при требовании капчи возвращаем captchaRequired, пользователь логинится
 *     на настоящем сайте.
 *   - списки (закладки/статусы) с реального сайта GET /api/users/{id}/lists[/{n}].
 *
 * ИСТОРИЯ ПРОСМОТРОВ/ПРОГРЕСС: сайт хранит их ЛОКАЛЬНО в IndexedDB браузера
 * (YummyDB.watched_ep, исследование Task 17) — серверного API НЕТ. Статус:
 * NOT AVAILABLE THROUGH CURRENT SITE INTERFACE. Приложение ведёт собственную
 * локальную историю (WatchHistoryEntry) — так же, как сам сайт (per-device).
 *
 * Безопасность (спека #37): логируем только метод/путь/статус/длительность.
 */

export const YUMMY_ADAPTER_VERSION = '1.0.0' // спека #46

const SITE_ORIGIN = 'https://old.yummyani.me'
const API_BASE = `${SITE_ORIGIN}/api`
const SITE_PROFILE_URL = `${SITE_ORIGIN}/users` // профиль сайта: /users/id{N}
const TIMEOUT_MS = 10_000

/** Числовые id списков сайта (исследование Task 17: enum [0..5] ответа сайта) */
export const YUMMY_LISTS = {
  WATCHING: 0, // «Смотрю»
  PLANNED: 1, // «В Планах»
  COMPLETED: 2, // «Просмотрено»
  DROPPED: 3, // «Брошено»
  FAVORITE: 4, // «Любимые»
  ON_HOLD: 5, // «Отложено»
} as const

export const YUMMY_LIST_LABELS: Record<number, string> = {
  0: 'Смотрю',
  1: 'В планах',
  2: 'Просмотрено',
  3: 'Брошено',
  4: 'Любимые',
  5: 'Отложено',
}

/** Состояние аутентификации (спека #4) */
export type YummyAuthState =
  | 'unknown'
  | 'checking'
  | 'logged_out'
  | 'logged_in'
  | 'session_expired'

export interface YummyProfileSnapshot {
  id: number
  nickname: string
  avatarUrl: string | null
  profileUrl: string
}

export interface YummyRemoteListItem {
  animeId: number
  animeUrl: string
  title: string
  poster: string | null
  listId: number
  year: number | null
  rating: number | null
  /** unix-ts добавления в список на сайте (для сортировки и хэша изменений) */
  siteDate: number | null
}

export interface YummyCheckResult {
  authenticated: boolean
  /** session_expired: был залогинен (cookie есть), сайт ответил 401 */
  state: YummyAuthState
  profile: YummyProfileSnapshot | null
}

export interface YummyLoginResult {
  ok: boolean
  profile: YummyProfileSnapshot | null
  /** ПОЛНЫЙ Cookie-загололовок сессии сайта (name=value; name2=value2) — только внутри сервера! */
  sessionCookieHeader: string | null
  error: string | null
  /** Сайт потребовал капчу — пользователь должен войти на настоящем сайте */
  captchaRequired: boolean
}

interface YummyApiError {
  error?: string
  error_title?: string
  error_code?: number
}

// --- sanitized logging (спека #37: без cookie/токенов/паролей) -----------------

function logRequest(method: string, path: string, status: number, ms: number): void {
  console.log(`[YummyAnime] ${method} ${path} -> ${status} (${ms} ms)`)
}

// --- низкоуровневый HTTP-транспорт адаптера ------------------------------------

interface TransportOptions {
  /** Cookie-загололовок сессии пользователя (transport-кэш, спека #30) */
  cookie?: string | null
  body?: unknown
  method?: 'GET' | 'POST'
  /** Вернуть заголовки Set-Cookie (нужно только для login) */
  captureSetCookie?: boolean
}

interface TransportResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: YummyApiError | null
  setCookies: string[]
  durationMs: number
}

/** Все запросы идут с заголовками, которые использует собственный JS сайта */
function baseHeaders(cookie?: string | null, hasBody = false): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    Lang: 'ru',
    Referer: `${SITE_ORIGIN}/`,
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (cookie) h.Cookie = cookie
  if (hasBody) h['Content-Type'] = 'application/json'
  return h
}

async function yummyFetch<T>(
  path: string,
  opts: TransportOptions = {},
): Promise<TransportResult<T>> {
  const started = Date.now()
  const method = opts.method ?? 'GET'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: baseHeaders(opts.cookie, opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    const durationMs = Date.now() - started
    logRequest(method, path, res.status, durationMs)
    const setCookies = opts.captureSetCookie ? res.headers.getSetCookie() : []
    let data: unknown = null
    let error: YummyApiError | null = null
    const text = await res.text()
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && 'response' in parsed) {
          data = parsed.response as T
        } else if ('error' in parsed) {
          error = parsed as YummyApiError
        } else if (res.ok) {
          data = parsed as T
        }
      } catch {
        if (!res.ok) error = { error: `Некорректный ответ сайта (HTTP ${res.status})` }
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      error,
      setCookies,
      durationMs,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const aborted = e instanceof Error && e.name === 'AbortError'
    logRequest(method, path, aborted ? 0 : -1, durationMs)
    return {
      ok: false,
      status: aborted ? 0 : -1,
      data: null,
      error: { error: aborted ? 'Сайт не ответил за отведённое время' : 'Сайт недоступен' },
      setCookies: [],
      durationMs,
    }
  }
}

// --- маппинг ответов сайта ------------------------------------------------------

interface YummyApiUser {
  id?: number
  nickname?: string
  avatars?: { small?: string; big?: string; full?: string }
}

function mapProfile(u: YummyApiUser): YummyProfileSnapshot | null {
  if (typeof u?.id !== 'number' || typeof u?.nickname !== 'string') return null
  const rawAvatar = u.avatars?.full || u.avatars?.big || u.avatars?.small || null
  return {
    id: u.id,
    nickname: u.nickname,
    // protocol-relative //static.yani.tv/... → https
    avatarUrl: rawAvatar ? (rawAvatar.startsWith('//') ? `https:${rawAvatar}` : rawAvatar) : null,
    profileUrl: `${SITE_PROFILE_URL}/id${u.id}`,
  }
}

interface YummyApiListItem {
  anime_id?: number
  anime_url?: string
  title?: string
  poster?: { big?: string; medium?: string; small?: string }
  year?: number
  rating?: number
  date?: number
}

function mapListItem(raw: YummyApiListItem, listId: number): YummyRemoteListItem | null {
  if (typeof raw?.anime_id !== 'number' || typeof raw?.title !== 'string') return null
  const poster = raw.poster?.big || raw.poster?.medium || raw.poster?.small || null
  return {
    animeId: raw.anime_id,
    animeUrl: raw.anime_url ?? String(raw.anime_id),
    title: raw.title,
    poster: poster ? (poster.startsWith('//') ? `https:${poster}` : poster) : null,
    listId,
    year: typeof raw.year === 'number' ? raw.year : null,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    siteDate: typeof raw.date === 'number' ? raw.date : null,
  }
}

interface ListFetchResult {
  ok: boolean
  items: YummyRemoteListItem[]
  error: string | null
  status: number
}

// --- публичный адаптер -----------------------------------------------------------

export const YummyAccountAdapter = {
  version: YUMMY_ADAPTER_VERSION,
  siteOrigin: SITE_ORIGIN,
  loginPageUrl: `${SITE_ORIGIN}/`,

  /** URL профиля на сайте (по id) */
  profilePageUrl(id: number): string {
    return `${SITE_PROFILE_URL}/id${id}`
  },

  /**
   * Детект авторизации по видимому состоянию сайта (спека #4, #51):
   * GET /api/profile — 200 = залогинен (сайт сам отдаёт профиль),
   * 401 = аноним. Cookie-существование доказательством НЕ считается.
   */
  async checkAuth(cookie: string | null): Promise<YummyCheckResult> {
    const res = await yummyFetch<YummyApiUser>('/profile', { cookie })
    if (res.ok && res.data) {
      const profile = mapProfile(res.data)
      if (profile) return { authenticated: true, state: 'logged_in', profile }
    }
    if (res.status === 401) {
      return {
        authenticated: false,
        state: cookie ? 'session_expired' : 'logged_out',
        profile: null,
      }
    }
    // Сеть/структура — не крэшимся (спека #26), состояние неизвестно
    return { authenticated: false, state: 'unknown', profile: null }
  },

  /**
   * Вход штатным механизмом сайта: тот же POST /api/profile/login с тем же
   * JSON-полезом {login, password}, что отправляет собственная форма сайта
   * (исследование Task 17). Пароль НЕ хранится/НЕ логируется; капча НЕ обходится.
   *
   * Устойчиво к формату ответа: профиль после успешного POST берём штатным
   * GET /api/profile с полученными cookie (именно так сайт сам проверяет вход).
   * Сохраняем ВСЕ выданные cookie (сессия может состоять из нескольких).
   */
  async login(login: string, password: string): Promise<YummyLoginResult> {
    if (!login.trim() || !password) {
      return {
        ok: false,
        profile: null,
        sessionCookieHeader: null,
        error: 'Введите логин и пароль',
        captchaRequired: false,
      }
    }
    const res = await yummyFetch<unknown>('/profile/login', {
      method: 'POST',
      body: { login: login.trim(), password },
      captureSetCookie: true,
    })
    if (!res.ok) {
      const siteError = res.error?.error ?? 'Не удалось войти'
      const lower = siteError.toLowerCase()
      const captchaRequired =
        lower.includes('captcha') || lower.includes('капч') || res.status === 403
      return {
        ok: false,
        profile: null,
        sessionCookieHeader: null,
        error: captchaRequired
          ? 'Сайт запросил проверку (капчу). Войдите на настоящем сайте — кнопка ниже.'
          : siteError,
        captchaRequired,
      }
    }

    // 2xx от логина: забираем ВСЕ cookie сессии и проверяем их реальным запросом
    const cookieHeader = buildCookieHeader(res.setCookies)
    if (!cookieHeader) {
      return {
        ok: false,
        profile: null,
        sessionCookieHeader: null,
        error: 'Сайт не выдал сессию — попробуйте войти на сайте',
        captchaRequired: false,
      }
    }
    const check = await YummyAccountAdapter.checkAuth(cookieHeader)
    if (check.authenticated && check.profile) {
      return {
        ok: true,
        profile: check.profile,
        sessionCookieHeader: cookieHeader,
        error: null,
        captchaRequired: false,
      }
    }
    return {
      ok: false,
      profile: null,
      sessionCookieHeader: cookieHeader,
      error:
        check.state === 'unknown'
          ? 'Сайт не подтвердил сессию (недоступен) — попробуйте ещё раз'
          : 'Сайт не подтвердил вход — проверьте логин и пароль',
      captchaRequired: false,
    }
  },

  /** Выход штатным методом сайта (POST /api/profile/logout) */
  async logout(cookie: string | null): Promise<boolean> {
    const res = await yummyFetch<unknown>('/profile/logout', { method: 'POST', cookie })
    return res.ok || res.status === 401
  },

  /**
   * Реальные списки пользователя по типам 0..5 (закладки/статусы).
   * Пагинация сайта offset/limit (исследование Task 17).
   */
  async getLists(cookie: string | null, yummyUserId: number, maxItems = 600): Promise<ListFetchResult> {
    const items: YummyRemoteListItem[] = []
    const seen = new Set<string>()
    const pageSize = 150
    const listIds: number[] = [
      YUMMY_LISTS.WATCHING,
      YUMMY_LISTS.PLANNED,
      YUMMY_LISTS.COMPLETED,
      YUMMY_LISTS.DROPPED,
      YUMMY_LISTS.FAVORITE,
      YUMMY_LISTS.ON_HOLD,
    ]
    for (const listId of listIds) {
      for (let offset = 0; offset < maxItems; offset += pageSize) {
        const res = await yummyFetch<YummyApiListItem[]>(
          `/users/${yummyUserId}/lists/${listId}?offset=${offset}&limit=${pageSize}`,
          { cookie },
        )
        if (!res.ok) {
          // 401 — сессия истекла (важный сигнал); остальные — сеть/структура
          return {
            ok: false,
            items,
            status: res.status,
            error: res.error?.error ?? `Сайт ответил ${res.status || 'сетевая ошибка'}`,
          }
        }
        const page = Array.isArray(res.data) ? res.data : []
        for (const raw of page) {
          const mapped = mapListItem(raw, listId)
          if (mapped && !seen.has(`${mapped.animeId}:${listId}`)) {
            seen.add(`${mapped.animeId}:${listId}`)
            items.push(mapped)
          }
        }
        if (page.length < pageSize) break
      }
    }
    return { ok: true, items, status: 200, error: null }
  },
}

/**
 * Из Set-Cookie строк сайта собрать ПОЛНЫЙ Cookie-загололовок сессии.
 * Сессия сайта может состоять из нескольких cookie — храним все.
 */
function buildCookieHeader(setCookies: string[]): string | null {
  const pairs: string[] = []
  const seen = new Set<string>()
  for (const line of setCookies) {
    const [pair] = line.split(';')
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name || !value || seen.has(name)) continue
    seen.add(name)
    pairs.push(`${name}=${value}`)
  }
  return pairs.length > 0 ? pairs.join('; ') : null
}
