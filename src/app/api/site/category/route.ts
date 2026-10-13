/**
 * GET /api/site/category?genre=slug&page=N — страница жанр-категории каталога
 * (/catalog/category/{slug}). База Компаса настроений (Anime Companion, ТЗ §8)
 * и общий доступ к жанрам каталога.
 *
 * Демо-фолбэка нет: пустой/неизвестный жанр → 404, остальное → 500 (честно).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SLUG_RE = /^[a-z0-9-]{1,64}$/

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const genre = (sp.get('genre') ?? '').trim().toLowerCase()
  if (!SLUG_RE.test(genre)) {
    return NextResponse.json(
      { error: 'Параметр genre обязателен: слаг жанра 1..64 символов [a-z0-9-]' },
      { status: 400 },
    )
  }

  let page = 1
  const pageRaw = sp.get('page')
  if (pageRaw !== null) {
    const n = Number(pageRaw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
      return NextResponse.json({ error: 'Страница должна быть целым числом 1..500' }, { status: 400 })
    }
    page = n
  }

  try {
    const data = await getAdapter().getCategoryPage(genre, page)
    return NextResponse.json(data)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Не удалось загрузить жанр'
    // Пустая/неизвестная категория (сайт отдал 404 или ноль карточек) → 404
    if (message === 'Жанр не найден или пуст' || /HTTP 404/.test(message)) {
      return NextResponse.json({ error: 'Жанр не найден или пуст' }, { status: 404 })
    }
    if (message === 'Некорректная страница' || message === 'Некорректный слаг жанра') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    return NextResponse.json({ error: `Жанр недоступен: ${message}` }, { status: 500 })
  }
}
