/**
 * GET /api/yummy/account — состояние аккаунта YummyAnime (реальная сессия сайта).
 *
 *   GET /api/yummy/account             → с учётом TTL-кэша
 *   GET /api/yummy/account?refresh=1   → принудительная проверка (секция 41)
 *
 * Ответ: YummyAccountSnapshot { state, user, lastSync, source, message }.
 * Секреты (cookie) наружу не отдаются (секция 37).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get('refresh') === '1'
  try {
    const snapshot = await getAdapter().getAccountState({ refresh })
    return NextResponse.json(snapshot)
  } catch (e) {
    return NextResponse.json(
      {
        state: 'unavailable',
        user: null,
        lastSync: null,
        source: 'error',
        message: e instanceof Error ? e.message : 'Ошибка проверки аккаунта',
      },
      { status: 500 },
    )
  }
}
