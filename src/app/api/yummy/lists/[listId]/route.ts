/**
 * GET /api/yummy/lists/[listId] — элементы одного списка аккаунта YummyAnime.
 * listId: 0 «Смотрю», 1 «В Планах», 2 «Просмотрено», 3 «Брошено», 4 «Любимые», 5 «Отложено».
 * Требуется привязанный аккаунт YummyAnime (cookie-сессия в БД).
 */
import { NextRequest, NextResponse } from 'next/server'
import { yummyUserList } from '@/lib/sites/yummy/account'
import { getYummySession } from '@/lib/sites/yummy/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_LIST_IDS = new Set([0, 1, 2, 3, 4, 5])

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ listId: string }> },
) {
  const { listId } = await params
  const id = parseInt(listId, 10)
  if (!VALID_LIST_IDS.has(id)) {
    return NextResponse.json({ error: 'Неверный номер списка (0..5)' }, { status: 400 })
  }

  const session = await getYummySession()
  if (!session) {
    return NextResponse.json(
      { error: 'Сначала войдите в аккаунт YummyAnime' },
      { status: 401 },
    )
  }
  const userId = session.profile?.id ?? null
  if (userId === null) {
    return NextResponse.json(
      { error: 'Неизвестен id профиля — войдите в аккаунт YummyAnime заново' },
      { status: 401 },
    )
  }

  const res = await yummyUserList(session.cookies, userId, id)
  if (!res.ok) {
    const status = res.code === 'auth' ? 401 : res.code === 'unavailable' ? 502 : 502
    return NextResponse.json(
      { error: res.message, code: res.code },
      { status },
    )
  }
  return NextResponse.json({ listId: id, items: res.data })
}
