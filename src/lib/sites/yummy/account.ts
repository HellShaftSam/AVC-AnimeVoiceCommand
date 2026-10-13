/**
 * YummyAnime account — функции аккаунта сайта (списки, избранное, оценки).
 *
 * Контракт реверсирован из бандла сайта (build.min.js v3.0.308) и подтверждён
 * живыми запросами к old.yummyani.me (записи без куки → 401 «нужно авторизоваться»,
 * то есть путь+метод существуют):
 *
 *   PUT    /api/anime/{id}/list        {list: 0..5}   — добавить/сменить список
 *   DELETE /api/anime/{id}/list                       — убрать из списка
 *   PUT    /api/anime/{id}/list/fav    (без тела)     — в «Любимые»
 *   DELETE /api/anime/{id}/list/fav                   — из «Любимых»
 *   PUT    /api/anime/{id}/rate        {rate: 1..10}  — оценить
 *   DELETE /api/anime/{id}/rate                       — убрать оценку
 *   GET    /api/users/{numericId}/lists/{0..5}        — элементы списка пользователя
 *
 * Списки сайта (id фиксированы, определены в бандле):
 *   0 «Смотрю», 1 «В Планах», 2 «Просмотрено», 3 «Брошено», 4 «Любимые», 5 «Отложено»
 * («Любимые» дублируются через /list/fav — на сайте это один и тот же список id=4.)
 *
 * Сессия: cookie-строка из YummySession (см. auth.ts). Пароль никогда не хранится.
 */

const SITE = 'https://old.yummyani.me'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AVC/1.2.1 Chrome/126.0 Safari/537.36'
const TIMEOUT_MS = 15000

/** Заголовки, которые сайт шлёт со ВСЕМИ API-запросами (реверс build.min.js) */
function apiHeaders(cookies: string, withBody: boolean): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': UA,
    Vary: 'json',
    Lang: 'ru',
    'X-Application': 'wawegr8j13it4rdw',
    Origin: SITE,
    Referer: `${SITE}/`,
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
  }
}

export type YummyAccountResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      code: 'auth' | 'bad_arguments' | 'not_found' | 'site_error' | 'unavailable' | 'bad_answer'
      message: string
    }

/** Разобрать конверт сайта: {response} | {error, error_code, error_title} */
async function request<T>(
  path: string,
  method: string,
  cookies: string,
  body?: unknown,
): Promise<YummyAccountResult<T>> {
  const withBody = body !== undefined
  try {
    const res = await fetch(`${SITE}${path}`, {
      method,
      headers: apiHeaders(cookies, withBody),
      body: withBody ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    const text = await res.text()
    let json: { response?: unknown; error?: unknown; error_title?: unknown; error_code?: unknown } | null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    if (res.ok && json && 'response' in json) {
      return { ok: true, data: json.response as T }
    }
    if (json && typeof json.error === 'string') {
      const code = typeof json.error_code === 'number' ? json.error_code : -1
      const kind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : code === 3
            ? 'bad_arguments'
            : code === 4
              ? 'not_found'
              : 'site_error'
      return { ok: false, code: kind, message: json.error }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'auth', message: 'Сессия сайта истекла — войдите заново' }
    }
    return {
      ok: false,
      code: 'bad_answer',
      message: `Сайт вернул неожиданный ответ (HTTP ${res.status})`,
    }
  } catch {
    return { ok: false, code: 'unavailable', message: 'Сайт YummyAnime недоступен' }
  }
}

// --- действия ----------------------------------------------------------------

/** Добавить аниме в список (0..5) или сменить список */
export function yummyListPut(
  cookies: string,
  animeId: number,
  listId: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/list`, 'PUT', cookies, { list: listId })
}

/** Убрать аниме из списка */
export function yummyListDelete(
  cookies: string,
  animeId: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/list`, 'DELETE', cookies)
}

/** Добавить в «Любимые» (PUT без тела — как в бандле сайта) */
export function yummyFavPut(
  cookies: string,
  animeId: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/list/fav`, 'PUT', cookies, {})
}

/** Убрать из «Любимых» */
export function yummyFavDelete(
  cookies: string,
  animeId: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/list/fav`, 'DELETE', cookies)
}

/** Поставить оценку 1..10 */
export function yummyRatePut(
  cookies: string,
  animeId: number,
  rate: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/rate`, 'PUT', cookies, { rate })
}

/** Убрать оценку */
export function yummyRateDelete(
  cookies: string,
  animeId: number,
): Promise<YummyAccountResult<unknown>> {
  return request(`/api/anime/${animeId}/rate`, 'DELETE', cookies)
}

// --- чтение ------------------------------------------------------------------

/** Карточка элемента списка пользователя (подмножество полей ответа сайта) */
export interface YummyListCard {
  animeId: number
  slug: string
  title: string
  poster: string | null
  year: number | null
  rating: number | null
  /** дата добавления в список (unix-секунды) */
  addedAt: number | null
  /** состояние списка/оценки у владельца */
  isFav: boolean
  listId: number | null
  listTitle: string | null
  userRating: number
}

interface ApiUserListCard {
  anime_id?: unknown
  anime_url?: unknown
  title?: unknown
  year?: unknown
  rating?: unknown
  poster?: { medium?: unknown } | unknown
  date?: unknown
  user?: {
    list?: { is_fav?: unknown; list?: { id?: unknown; title?: unknown } | null }
    rating?: unknown
  }
}

function normPoster(p: unknown): string | null {
  if (typeof p === 'string' && p) return p.startsWith('//') ? `https:${p}` : p
  // На сайте poster — объект {fullsize, big, medium, small, ...}
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>
    for (const k of ['medium', 'big', 'small', 'fullsize', 'huge']) {
      const v = o[k]
      if (typeof v === 'string' && v) return v.startsWith('//') ? `https:${v}` : v
    }
  }
  return null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseListCard(raw: ApiUserListCard): YummyListCard | null {
  const animeId = num(raw.anime_id)
  const slug = typeof raw.anime_url === 'string' ? raw.anime_url : null
  const title = typeof raw.title === 'string' ? raw.title : null
  if (animeId === null || !slug || !title) return null
  const poster = normPoster(raw.poster)
  const listObj = raw.user?.list?.list ?? null
  return {
    animeId,
    slug,
    title,
    poster,
    year: num(raw.year),
    rating: typeof raw.rating === 'object' && raw.rating !== null ? num((raw.rating as { average?: unknown }).average) : num(raw.rating),
    addedAt: num(raw.date),
    isFav: raw.user?.list?.is_fav === true,
    listId: num(listObj?.id),
    listTitle: typeof listObj?.title === 'string' ? listObj.title : null,
    userRating: typeof raw.user?.rating === 'number' ? raw.user.rating : 0,
  }
}

/**
 * Элементы списка пользователя (listId 0..5).
 * ВАЖНО: userId — числовой id (без префикса «id»), путь /api/users/{id}/lists/{n}.
 */
export async function yummyUserList(
  cookies: string,
  userId: number,
  listId: number,
): Promise<YummyAccountResult<YummyListCard[]>> {
  if (!Number.isInteger(userId) || userId <= 0 || listId < 0 || listId > 5) {
    return { ok: false, code: 'bad_arguments', message: 'Неверный userId или listId' }
  }
  const res = await request<unknown>(`/api/users/${userId}/lists/${listId}`, 'GET', cookies)
  if (!res.ok) return res
  if (!Array.isArray(res.data)) {
    return { ok: false, code: 'bad_answer', message: 'Сайт вернул список в неожиданном формате' }
  }
  const cards: YummyListCard[] = []
  for (const raw of res.data) {
    const card = parseListCard(raw as ApiUserListCard)
    if (card) cards.push(card)
  }
  return { ok: true, data: cards }
}

/** Расширенный снимок профиля: статистика просмотров для панели аккаунта */
export interface YummyProfileStats {
  nickname: string
  avatar: string
  id: number | null
  registerDate: number | null
  /** потрачено времени по типам (ТВ / п/ф / OVA...) */
  watches: Array<{ name: string; value: number; spentTime: number }>
}

export async function yummyProfileStats(
  cookies: string,
): Promise<YummyAccountResult<YummyProfileStats>> {
  const res = await request<Record<string, unknown>>('/api/profile', 'GET', cookies)
  if (!res.ok) return res
  const r = res.data ?? {}
  const avatars = (r.avatars ?? {}) as Record<string, unknown>
  const nickname =
    typeof r.nickname === 'string' && r.nickname ? r.nickname : 'Аккаунт YummyAnime'
  const avatar =
    normPoster(avatars.full) ?? normPoster(avatars.big) ?? normPoster(avatars.small) ?? ''
  const watchesRaw = Array.isArray((r.watches as { sum?: unknown })?.sum)
    ? ((r.watches as { sum: unknown[] }).sum as Array<Record<string, unknown>>)
    : []
  const watches = watchesRaw
    .map((w) => ({
      name: typeof w.name === 'string' ? w.name : '',
      value: num(w.value) ?? 0,
      spentTime: num(w.spent_time) ?? 0,
    }))
    .filter((w) => w.name !== '')
  return {
    ok: true,
    data: {
      nickname,
      avatar,
      id: num(r.id),
      registerDate: num(r.register_date),
      watches,
    },
  }
}

// --- метаданные списков (для UI) ---------------------------------------------

/** Описания списков сайта (реверс бандла: Rt=[...]) */
export const YUMMY_LISTS: ReadonlyArray<{ id: number; title: string; href: string }> = [
  { id: 0, title: 'Смотрю', href: 'watch_now' },
  { id: 1, title: 'В Планах', href: 'will' },
  { id: 2, title: 'Просмотрено', href: 'watched' },
  { id: 3, title: 'Брошено', href: 'lost' },
  { id: 4, title: 'Любимые', href: 'favourite' },
  { id: 5, title: 'Отложено', href: 'postpone' },
]
