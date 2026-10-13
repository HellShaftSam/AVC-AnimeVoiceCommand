/**
 * Рекомендации — опциональный внешний источник кандидатов (AniList GraphQL).
 *
 * Правила из ТЗ §5.4:
 *  - это ДОПОЛНИТЕЛЬНЫЙ сигнал кандидатов/метаданных, НЕ замена библиотеке
 *    YummyAnime и НЕ авторитетное знание о вкусах пользователя;
 *  - ID YummyAnime ≠ ID AniList: сопоставление ТОЛЬКО через внешний MAL ID
 *    (remote_ids с сайта) — человекопроверяемо и без угадывания;
 *  - претендент обязан найтись в каталоге YummyAnime, иначе не показывается;
 *  - API недоступен/лимит → пустой результат, движок работает без него;
 *  - без аккаунта AniList, уважение лимитов (90 req/min) и кэш 6 ч.
 *
 * Экспериментально: выключено по умолчанию (настройка в UI вкладки).
 */

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'
const TIMEOUT_MS = 12000
const CACHE_TTL = 6 * 60 * 60 * 1000
const CACHE_MAX = 50

interface CacheEntry {
  data: AnilistRecItem[]
  expires: number
}
const cache = new Map<string, CacheEntry>()

export interface AnilistRecItem {
  /** MAL ID рекомендованного тайтла AniList */
  malId: number | null
  title: string
  /** Название для поиска по сайту (romaji/english — что есть) */
  searchTitle: string
}

interface AniListMedia {
  idMal: number | null
  recommendations?: {
    nodes?: Array<{
      mediaRecommendation?: {
        idMal: number | null
        title?: { romaji?: string | null; english?: string | null }
      } | null
    }> | null
  } | null
}

async function gql<T>(query: string, variables: unknown): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (res.status === 429) throw new Error('anilist rate limit')
    if (!res.ok) throw new Error(`anilist HTTP ${res.status}`)
    const json = (await res.json()) as { data?: T; errors?: unknown }
    if (!json.data) throw new Error('anilist пустой ответ')
    return json.data
  } finally {
    clearTimeout(t)
  }
}

const QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: ANIME) {
      idMal
      recommendations(perPage: 6, sort: RATING_DESC) {
        nodes {
          mediaRecommendation {
            idMal
            title { romaji english }
          }
        }
      }
    }
  }
}
`

/**
 * Получить рекомендации AniList для набора MAL ID (батч одним запросом).
 * Возвращает сплющенный список рекомендованных тайтлов (без дублей).
 * Любая ошибка → [] (фича деградирует честно, не падает).
 */
export async function fetchAnilistRecommendations(malIds: number[]): Promise<AnilistRecItem[]> {
  const ids = malIds.filter((n) => Number.isInteger(n) && n > 0).slice(0, 50)
  if (ids.length === 0) return []
  const key = ids.slice().sort((a, b) => a - b).join(',')
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data
  try {
    const data = await gql<{ Page: { media: AniListMedia[] } }>(QUERY, { ids })
    const out: AnilistRecItem[] = []
    const seen = new Set<string>()
    for (const media of data.Page?.media ?? []) {
      for (const node of media.recommendations?.nodes ?? []) {
        const rec = node.mediaRecommendation
        if (!rec) continue
        const title = rec.title?.romaji ?? rec.title?.english ?? null
        if (!title) continue
        const norm = title.trim().toLowerCase()
        if (seen.has(norm)) continue
        seen.add(norm)
        out.push({
          malId: typeof rec.idMal === 'number' ? rec.idMal : null,
          title,
          searchTitle: title,
        })
      }
    }
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    cache.set(key, { data: out, expires: Date.now() + CACHE_TTL })
    return out
  } catch {
    // Честная деградация: внешний источник недоступен — кандидатов от него нет
    return []
  }
}

/** Очистить кэш (логаут/смена аккаунта — инвалидация внешних кандидатов) */
export function clearAnilistCache(): void {
  cache.clear()
}
