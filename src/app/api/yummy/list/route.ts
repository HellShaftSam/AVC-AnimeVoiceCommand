/**
 * PUT  /api/yummy/list  {animeId, listId}   — добавить/сменить список сайта
 * DELETE /api/yummy/list?animeId=N          — убрать из списка
 * Требуется привязанный аккаунт YummyAnime.
 */
import { NextRequest, NextResponse } from 'next/server'
import { yummyListDelete, yummyListPut } from '@/lib/sites/yummy/account'
import { getYummySession } from '@/lib/sites/yummy/session'

export const runtime = 'nodejs'

function fail(res: { code: string; message: string }) {
  const status = res.code === 'auth' ? 401 : res.code === 'unavailable' ? 502 : 502
  return NextResponse.json({ error: res.message, code: res.code }, { status })
}

export async function PUT(req: NextRequest) {
  let body: { animeId?: unknown; listId?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const animeId = typeof body.animeId === 'number' ? Math.trunc(body.animeId) : NaN
  const listId = typeof body.listId === 'number' ? Math.trunc(body.listId) : NaN
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'Нужен animeId' }, { status: 400 })
  }
  if (!Number.isInteger(listId) || listId < 0 || listId > 5) {
    return NextResponse.json({ error: 'listId должен быть 0..5' }, { status: 400 })
  }

  const session = await getYummySession()
  if (!session) {
    return NextResponse.json({ error: 'Сначала войдите в аккаунт YummyAnime' }, { status: 401 })
  }

  const res = await yummyListPut(session.cookies, animeId, listId)
  if (!res.ok) return fail(res)
  return NextResponse.json({ ok: true, animeId, listId })
}

export async function DELETE(req: NextRequest) {
  const animeId = parseInt(req.nextUrl.searchParams.get('animeId') ?? '', 10)
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'Нужен animeId' }, { status: 400 })
  }
  const session = await getYummySession()
  if (!session) {
    return NextResponse.json({ error: 'Сначала войдите в аккаунт YummyAnime' }, { status: 401 })
  }
  const res = await yummyListDelete(session.cookies, animeId)
  if (!res.ok) return fail(res)
  return NextResponse.json({ ok: true, animeId })
}
