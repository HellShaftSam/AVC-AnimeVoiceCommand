/**
 * Серверный прокси к API плеера aksor: GET /api/site/player-source?url=<iframe url>
 *
 * ЗАЧЕМ: player.aksor.tv/api/video/{id} отдаёт карту качеств
 * {qualities: {q360..q4k: url|null}}, но БЕЗ CORS-заголовков — из браузера
 * приложения её не прочитать (мастер-промпт №6, реверс Task 14-a-1).
 * Читаем сервером и кэшируем в памяти (TTL 10 минут: список качеств у серии
 * стабилен, экономим запросы к плееру).
 *
 * Смена качества выполняется на клиенте через player_set_source (см. executor).
 * Пароли/токены не логируются; проксируется только этот конкретный ресурс.
 */
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { data: unknown; ts: number }>()

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url') ?? ''
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return NextResponse.json({ error: 'Некорректный url' }, { status: 400 })
  }
  // проксируем ТОЛЬКО страницы видео aksor — никаких произвольных SSRF
  if (target.hostname !== 'player.aksor.tv' || !/^\/video\/[a-f0-9]+\/?$/.test(target.pathname)) {
    return NextResponse.json(
      { error: 'Поддерживаются только видео player.aksor.tv' },
      { status: 400 },
    )
  }

  const cacheKey = target.pathname
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json(hit.data as Record<string, unknown>)
  }

  try {
    const videoId = target.pathname.split('/').filter(Boolean)[1]
    const res = await fetch(`https://player.aksor.tv/api/video/${videoId}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: `https://player.aksor.tv${target.pathname}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Плеер ответил ${res.status}` }, { status: 502 })
    }
    const data = (await res.json()) as unknown
    cache.set(cacheKey, { data, ts: Date.now() })
    if (cache.size > 200) {
      // простая защита от роста: выкидываем самые старые
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 50)
      for (const [k] of oldest) cache.delete(k)
    }
    return NextResponse.json(data as Record<string, unknown>)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка запроса к плееру' },
      { status: 502 },
    )
  }
}
