/**
 * PUT /api/yummy/rate {animeId, rate: number|null} — оценка аккаунта YummyAnime.
 * rate 1..10 → PUT /api/anime/{id}/rate, null → DELETE (оценка снята).
 */
import { NextRequest, NextResponse } from 'next/server'
import { yummyRateDelete, yummyRatePut } from '@/lib/sites/yummy/account'
import { getYummySession } from '@/lib/sites/yummy/session'

export const runtime = 'nodejs'

export async function PUT(req: NextRequest) {
  let body: { animeId?: unknown; rate?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const animeId = typeof body.animeId === 'number' ? Math.trunc(body.animeId) : NaN
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'Нужен animeId' }, { status: 400 })
  }

  const session = await getYummySession()
  if (!session) {
    return NextResponse.json({ error: 'Сначала войдите в аккаунт YummyAnime' }, { status: 401 })
  }

  let res
  if (body.rate === null) {
    res = await yummyRateDelete(session.cookies, animeId)
  } else {
    const rate = typeof body.rate === 'number' ? Math.round(body.rate) : NaN
    if (!Number.isInteger(rate) || rate < 1 || rate > 10) {
      return NextResponse.json({ error: 'Оценка должна быть числом 1..10 или null' }, { status: 400 })
    }
    res = await yummyRatePut(session.cookies, animeId, rate)
  }
  if (!res.ok) {
    const status = res.code === 'auth' ? 401 : 502
    return NextResponse.json({ error: res.message, code: res.code }, { status })
  }
  return NextResponse.json({ ok: true, animeId, rate: body.rate ?? null })
}
