/**
 * Release Meta API — даты выхода/трейлеры/расписание анонсов.
 *
 *   GET /api/site/release-meta?ids=29420,30794   (батч, до 40 — секция «Анонсы»)
 *   GET /api/site/release-meta?ids=28895         (одиночный — страница аниме)
 *
 * Источники: сайт (даты/статус/трейлеры) → AniList (частичные даты, точное
 * время серий, резервный трейлер) → Jikan (резерв). Сервер кэширует 3–6 ч,
 * клиент может смело вызывать при открытии страницы.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getReleaseMeta, getReleaseMetaBatch } from '@/lib/sites/yummy/release-meta'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('ids') ?? ''
  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 40)

  if (ids.length === 0) {
    return NextResponse.json({ error: 'Нужен параметр ids (числовые id через запятую)' }, { status: 400 })
  }

  try {
    if (ids.length === 1) {
      const meta = await getReleaseMeta(ids[0])
      return NextResponse.json({ items: { [ids[0]]: meta } })
    }
    const items = await getReleaseMetaBatch(ids)
    return NextResponse.json({ items })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Не удалось получить метаданные выхода' },
      { status: 500 },
    )
  }
}
