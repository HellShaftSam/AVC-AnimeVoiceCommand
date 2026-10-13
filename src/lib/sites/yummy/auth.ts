/**
 * YummyAnime auth — серверный помощник входа в аккаунт сайта.
 *
 * Реальный контракт сайта (реверс build.min.js v3.0.308):
 *   POST /api/profile/login  {login, password, recaptcha_response?}
 *     → 200 {response: {id, nickname, avatars:{small,big,full}, ...}} + Set-Cookie сессии
 *     → 401 {error, error_title, error_code, error_name}
 *   GET  /api/profile        → {response: {...}} (по cookie-сессии)
 *   POST /api/profile/logout → выход
 *
 * Пароль используется только в момент запроса и НИКОГДА не сохраняется и
 * не логируется. Хранится только cookie-строка сессии (YummySession в БД).
 */

const SITE = 'https://old.yummyani.me'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AVC/1.1.0 Chrome/126.0 Safari/537.36'
const TIMEOUT_MS = 15000

export interface YummyProfile {
  id: number | null
  nickname: string
  avatar: string
}

export type YummyAuthResult =
  | { ok: true; profile: YummyProfile; cookies: string }
  | { ok: false; code: 'invalid_credentials' | 'site_error' | 'site_unavailable' | 'bad_answer'; message: string }

/** Нормализуем ответ сайта в безопасный снимок профиля (контакта с сырым объектом нет) */
function normalizeProfile(raw: unknown): YummyProfile {
  const r = (raw ?? {}) as Record<string, unknown>
  const avatars = (r.avatars ?? {}) as Record<string, unknown>
  const nickname =
    typeof r.nickname === 'string' && r.nickname
      ? r.nickname
      : typeof r.login === 'string'
        ? r.login
        : 'Аккаунт YummyAnime'
  const avatar =
    (typeof avatars.full === 'string' && avatars.full) ||
    (typeof avatars.big === 'string' && avatars.big) ||
    (typeof avatars.small === 'string' && avatars.small) ||
    ''
  const id = typeof r.id === 'number' ? r.id : null
  return { id, nickname, avatar }
}

/** Собрать "Cookie: a=b; c=d" из массива set-cookie заголовков */
function cookieStringFromSetCookie(setCookies: string[]): string {
  const pairs: string[] = []
  for (const line of setCookies) {
    const [pair] = line.split(';') // только name=value, атрибуты не нужны
    if (pair && pair.includes('=')) pairs.push(pair.trim())
  }
  // dedupe по имени
  const map = new Map<string, string>()
  for (const p of pairs) {
    const eq = p.indexOf('=')
    map.set(p.slice(0, eq), p.slice(eq + 1))
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

interface YummyApiEnvelope {
  response?: unknown
  error?: unknown
  error_title?: unknown
  error_code?: unknown
}

/**
 * Единый fetch к JSON API сайта с таймаутом и классификацией ошибок.
 * Никогда не бросает наружу необработанные исключения — всегда структурированный результат.
 */
async function yummyApi(
  path: string,
  init: { method: string; body?: unknown; cookies?: string },
): Promise<
  | { kind: 'ok'; json: YummyApiEnvelope; setCookies: string[] }
  | { kind: 'http'; status: number; json: YummyApiEnvelope | null }
  | { kind: 'unavailable' }
  | { kind: 'bad_answer' }
> {
  try {
    const res = await fetch(`${SITE}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
        Referer: `${SITE}/login`,
        Origin: SITE,
        ...(init.cookies ? { Cookie: init.cookies } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })

    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []

    const text = await res.text()
    let json: YummyApiEnvelope | null = null
    try {
      json = JSON.parse(text) as YummyApiEnvelope
    } catch {
      json = null // HTML/пусто — сайт отдал не API-ответ
    }

    if (!res.ok) {
      return { kind: 'http', status: res.status, json }
    }
    if (!json) return { kind: 'bad_answer' }
    return { kind: 'ok', json, setCookies }
  } catch {
    // AbortError / сеть / DNS — сайт недоступен
    return { kind: 'unavailable' }
  }
}

function siteErrorMessage(kind: 'http' | 'unavailable' | 'bad_answer', status?: number): string {
  switch (kind) {
    case 'http':
      return status === 0
        ? 'Сайт недоступен'
        : `Сайт вернул ошибку HTTP ${status ?? ''}`.trim()
    case 'unavailable':
      return 'Сайт YummyAnime недоступен — проверьте интернет'
    case 'bad_answer':
      return 'Сайт вернул некорректный ответ (не JSON) — возможно, изменилось API'
  }
}

/** Вход в аккаунт YummyAnime */
export async function yummyLogin(login: string, password: string): Promise<YummyAuthResult> {
  const l = login.trim()
  if (!l || !password) {
    return { ok: false, code: 'invalid_credentials', message: 'Введите логин и пароль' }
  }

  const res = await yummyApi('/api/profile/login', {
    method: 'POST',
    body: { login: l, password },
  })

  if (res.kind === 'ok') {
    if (res.json.response) {
      return {
        ok: true,
        profile: normalizeProfile(res.json.response),
        cookies: cookieStringFromSetCookie(res.setCookies),
      }
    }
    // Сайт вернул 200, но с error-конвертом
    const msg =
      typeof res.json.error === 'string' && res.json.error
        ? res.json.error
        : siteErrorMessage('bad_answer')
    return { ok: false, code: 'invalid_credentials', message: msg }
  }

  if (res.kind === 'http') {
    const err = typeof res.json?.error === 'string' ? res.json.error : null
    const title = typeof res.json?.error_title === 'string' ? res.json.error_title : null
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: 'invalid_credentials',
        message: err || title || 'Неверный логин или пароль',
      }
    }
    return {
      ok: false,
      code: res.status === 404 ? 'bad_answer' : 'site_error',
      message:
        err ||
        title ||
        siteErrorMessage('http', res.status),
    }
  }

  return {
    ok: false,
    code: res.kind === 'unavailable' ? 'site_unavailable' : 'bad_answer',
    message: siteErrorMessage(res.kind),
  }
}

/** Проверить сохранённую сессию (GET /api/profile по cookie) */
export async function yummyMe(
  cookies: string,
): Promise<{ valid: boolean; profile?: YummyProfile; reason?: 'expired' | 'unavailable' }> {
  if (!cookies) return { valid: false, reason: 'expired' }
  const res = await yummyApi('/api/profile', { method: 'GET', cookies })
  if (res.kind === 'ok' && res.json.response) {
    const profile = normalizeProfile(res.json.response)
    // анонимный/пустой профиль = сессия не действует
    if (profile.nickname === 'Аккаунт YummyAnime' && profile.id === null) {
      return { valid: false, reason: 'expired' }
    }
    return { valid: true, profile }
  }
  if (res.kind === 'unavailable') return { valid: false, reason: 'unavailable' }
  return { valid: false, reason: 'expired' }
}

/** Выход из аккаунта сайта (best-effort: локальную сессию удалим в любом случае) */
export async function yummyLogout(cookies: string): Promise<void> {
  if (!cookies) return
  await yummyApi('/api/profile/logout', { method: 'POST', cookies })
}
