import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createSessionToken, hashPassword, sessionCookieOptions } from '@/lib/auth'

export const runtime = 'nodejs'

const USERNAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ.\-]{3,24}$/

/** POST /api/auth/register {username, password} → {user:{id,username}} */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Нужны username и password' }, { status: 400 })
  }
  const name = username.trim()
  if (!USERNAME_RE.test(name)) {
    return NextResponse.json(
      { error: 'Имя: 3–24 символа, буквы/цифры/_.- (можно кириллицу)' },
      { status: 400 },
    )
  }
  if (password.length < 4) {
    return NextResponse.json({ error: 'Пароль: минимум 4 символа' }, { status: 400 })
  }

  const existing = await db.user.findUnique({ where: { username: name } })
  if (existing) {
    return NextResponse.json({ error: 'Имя уже занято' }, { status: 409 })
  }

  const passwordHash = await hashPassword(password)
  const user = await db.user.create({
    data: { username: name, passwordHash },
    select: { id: true, username: true },
  })

  const res = NextResponse.json({ user })
  res.cookies.set('avt_session', createSessionToken(user.id), sessionCookieOptions())
  return res
}
