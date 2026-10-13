/**
 * POST /api/site/enrich { ids: number[] } — пакетные данные деталей
 * (год, статус, рейтинг, время следующей серии, серии вышло/всего).
 *
 * Используется фильтрами каталога (годы/статус — ТЗ «выбирать несколько
 * вариантов»): сайт фильтров не имеет, метаданные добираются из деталей,
 * каждая из которых кэширована адаптером (LRU, TTL 5 мин).
 *
 * Кап 120 id за запрос (защита от перегрузки сайта); пул параллелизма 6.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_IDS = 120

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Ожидается JSON с полем ids' }, { status: 400 })
  }
  const idsRaw = (body as { ids?: unknown })?.ids
  if (!Array.isArray(idsRaw)) {
    return NextResponse.json({ error: 'Поле ids обязательно (массив чисел)' }, { status: 400 })
  }
  const ids = idsRaw
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length === 0) return NextResponse.json({ items: {} })
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Слишком много id (${ids.length}): максимум ${MAX_IDS} за запрос` },
      { status: 400 },
    )
  }
  try {
    const items = await getAdapter().getEnrichment(ids)
    return NextResponse.json({ items })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка обогащения' },
      { status: 500 },
    )
  }
}
