/**
 * GET /api/site/suggest?q=<строка> — живой поиск по мере ввода (ТЗ: «пишу Н —
 * все на Н, пишу На — все на На… по приоритету букв»).
 *
 * - q >= 3 символов: поиск сайта /api/search + ранжирование (префикс → начало
 *   слова → вхождение, внутри уровня алфавит).
 * - q 1-2 символа: сайт ищет только от 3 (minimum query length = 3) — фильтр
 *   по локальному индеку популярных тайтлов (getSuggestIndex, кэш 10 мин),
 *   честная пометка mode:'index' для бейджа «популярные тайтлы».
 * - Пусто: mode:'empty'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter, rankCards } from '@/lib/sites/yummy/adapter'

export const dynamic = 'force-dynamic'

const MAX_ITEMS = 60

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) {
    return NextResponse.json({ query: q, items: [], mode: 'empty' })
  }
  const adapter = getAdapter()
  try {
    if (q.length >= 3) {
      const items = rankCards(await adapter.searchAnime(q), q).slice(0, MAX_ITEMS)
      return NextResponse.json({ query: q, items, mode: 'site' })
    }
    // Короткий запрос (1-2 буквы): локальный индекс + ранжирование
    const index = await adapter.getSuggestIndex()
    const items = rankCards(index, q).slice(0, MAX_ITEMS)
    return NextResponse.json({ query: q, items, mode: 'index' })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка подсказок' },
      { status: 500 },
    )
  }
}
