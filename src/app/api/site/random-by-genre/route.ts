/**
 * Случайное аниме по жанру (мастер-промпт №7).
 * GET /api/site/random-by-genre?genre=<slug> → { card: AnimeCard }
 *
 * Slug — из /catalog/category/{slug} (словарь алиасов: src/lib/voice/genre-aliases.ts).
 * Неизвестный slug → сайт отдаёт пустую страницу → 404 «жанр не найден».
 * Рандом с окном исключений — в адаптере (getRandomByGenre).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const genre = (req.nextUrl.searchParams.get('genre') ?? '').trim()
  if (!genre) {
    return NextResponse.json({ error: 'Не указан жанр' }, { status: 400 })
  }
  try {
    const adapter = getAdapter()
    const card = await adapter.getRandomByGenre(genre)
    if (!card) {
      return NextResponse.json(
        { error: 'Не удалось найти аниме этого жанра' },
        { status: 404 },
      )
    }
    return NextResponse.json({ card })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка поиска случайного аниме' },
      { status: 500 },
    )
  }
}
