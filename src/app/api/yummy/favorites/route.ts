/**
 * GET /api/yummy/favorites — избранное пользователя с реального сайта.
 *
 *   GET /api/yummy/favorites            → с TTL-кэшем (2 минуты)
 *   GET /api/yummy/favorites?refresh=1  → принудительно
 *
 * Ответ: YummyFavoritesResult { available, items, reason, lastSync }.
 * Если сайт не отдал список — available:false с причиной (ничего не выдумываем).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get('refresh') === '1'
  try {
    const result = await getAdapter().getFavorites({ refresh })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      {
        available: false,
        items: [],
        reason: e instanceof Error ? e.message : 'Ошибка получения избранного',
        lastSync: null,
      },
      { status: 500 },
    )
  }
}
