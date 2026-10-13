/**
 * GET /api/companion/characters?malId=N — персонажи тайтла через AniList GraphQL.
 *
 * СПОЙЛЕР-ГВАРДИЯ (ТЗ §3): запрос забирает ТОЛЬКО имя/постер/роль/сэйю —
 * НИКАКИХ описаний персонажей. Ответ нормируется до
 * { name, image, role, voiceActor } — спойлерные поля физически не доходят
 * до клиента.
 *
 * Честная деградация: AniList недоступен/лимит/тайтла нет → 200 с
 * { available:false, reason, characters:[] } — фича молча не работает,
 * но ничего не ломает и не выдумывает. Кэш 6 ч (Map ≤ 64, старые вытесняются).
 */
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'
const TIMEOUT_MS = 12000
const CACHE_TTL = 6 * 60 * 60 * 1000
const CACHE_MAX = 64

interface CharacterDto {
  name: string
  image: string | null
  role: string
  voiceActor: string | null
}

interface CacheEntry {
  data: CharacterDto[]
  reason: string | null
  available: boolean
  expires: number
}
const cache = new Map<string, CacheEntry>()

// Спойлер-гвардия: в query НЕТ полей description/about/gender/age — только безопасные.
// ВНИМАНИЕ: язык сэйю НЕ фильтруем — в enum StaffLanguage AniList НЕТ RUSSIAN
// (интроспекция 2026-10-14: JAPANESE/ENGLISH/...), voiceActors без аргумента
// возвращает всех (японские первыми по сортировке) → берём первого.
const QUERY = `
query ($malId: Int) {
  Media(idMal: $malId, type: ANIME) {
    characters(perPage: 16, sort: [ROLE, RELEVANCE, ID]) {
      edges {
        role
        node {
          name { full }
          image { large }
        }
        voiceActors {
          name { full }
        }
      }
    }
  }
}
`

interface GqlEdge {
  role?: string | null
  node?: { name?: { full?: string | null } | null; image?: { large?: string | null } | null } | null
  voiceActors?: Array<{ name?: { full?: string | null } | null }> | null
}

function roleLabel(role: string | null | undefined): string {
  if (role === 'MAIN') return 'Главная роль'
  if (role === 'SUPPORTING') return 'Второстепенная роль'
  if (role === 'BACKGROUND') return 'Эпизодическая роль'
  return 'Роль'
}

/** AniList GraphQL POST (тот же стиль, что lib/recs/anilist.ts). Ошибка → throw */
async function gql(query: string, variables: Record<string, number>): Promise<unknown> {
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
    const json = (await res.json()) as { data?: unknown; errors?: unknown }
    if (!json.data) throw new Error('anilist пустой ответ')
    return json.data
  } finally {
    clearTimeout(t)
  }
}

function extractCharacters(data: unknown): CharacterDto[] {
  const media = (
    data as { Media?: { characters?: { edges?: GqlEdge[] | null } | null } | null } | null
  )?.Media
  if (!media) return []
  const edges = media.characters?.edges ?? []
  const out: CharacterDto[] = []
  for (const edge of edges) {
    const name = edge.node?.name?.full?.trim()
    if (!name) continue
    out.push({
      name,
      image: edge.node?.image?.large ?? null,
      role: roleLabel(edge.role),
      voiceActor: edge.voiceActors?.[0]?.name?.full?.trim() ?? null,
    })
  }
  return out
}

export async function GET(req: NextRequest) {
  const malIdRaw = req.nextUrl.searchParams.get('malId')
  const malId = Number(malIdRaw)
  if (malIdRaw === null || !Number.isFinite(malId) || !Number.isInteger(malId) || malId < 1) {
    return NextResponse.json(
      { error: 'Параметр malId обязателен (целое число > 0)' },
      { status: 400 },
    )
  }

  const key = String(malId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) {
    return NextResponse.json({ available: hit.available, reason: hit.reason, characters: hit.data })
  }

  try {
    const data = await gql(QUERY, { malId })
    const found = (
      data as { Media?: unknown } | null
    )?.Media
    const characters = extractCharacters(data)
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    if (!found) {
      // Тайтла с таким MAL ID нет в AniList (GraphQL отвечает Media: null, не ошибкой)
      const result = { available: false, reason: 'Аниме с таким MAL ID не найдено в AniList', characters: [] as CharacterDto[] }
      cache.set(key, { data: result.characters, available: result.available, reason: result.reason, expires: Date.now() + CACHE_TTL })
      return NextResponse.json(result)
    }
    const result = {
      available: true,
      reason:
        characters.length === 0
          ? 'Персонажи для этого тайтла пока не заведены в AniList'
          : null,
      characters,
    }
    cache.set(key, { data: result.characters, available: result.available, reason: result.reason, expires: Date.now() + CACHE_TTL })
    return NextResponse.json(result)
  } catch {
    // Честная деградация: внешний источник недоступен — не падаем и не выдумываем
    return NextResponse.json({ available: false, reason: 'AniList недоступен', characters: [] })
  }
}
