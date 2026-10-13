/**
 * PUT /api/yummy/fav {animeId, fav: boolean} — «Любимые» аккаунта YummyAnime.
 * fav=true → PUT /api/anime/{id}/list/fav (добавить), false → DELETE (убрать).
 */
import { NextRequest, NextResponse } from 'next/server'
import { yummyFavDelete, yummyFavPut } from '@/lib/sites/yummy/account'
import { getYummySession } from '@/lib/sites/yummy/session'

export const runtime = 'nodejs'

export async function PUT(req: NextRequest) {
  let body: { animeId?: unknown; fav?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const animeId = typeof body.animeId === 'number' ? Math.trunc(body.animeId) : NaN
  const fav = body.fav
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'Нужен animeId' }, { status: 400 })
  }
  if (typeof fav !== 'boolean') {
    return NextResponse.json({ error: 'Нужен булев fav' }, { status: 400 })
  }

  const session = await getYummySession()
  if (!session) {
    return NextResponse.json({ error: 'Сначала войдите в аккаунт YummyAnime' }, { status: 401 })
  }

  const res = fav
    ? await yummyFavPut(session.cookies, animeId)
    : await yummyFavDelete(session.cookies, animeId)
  if (!res.ok) {
    const status = res.code === 'auth' ? 401 : 502
    return NextResponse.json({ error: res.message, code: res.code }, { status })
  }
  return NextResponse.json({ ok: true, animeId, fav })
}
