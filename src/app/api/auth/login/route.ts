import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createSessionToken, sessionCookieOptions, verifyPassword } from '@/lib/auth'

export const runtime = 'nodejs'

/** POST /api/auth/login {username, password} → {user} | 401 */
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

  const user = await db.user.findUnique({ where: { username: username.trim() } })
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 })
  }

  const res = NextResponse.json({ user: { id: user.id, username: user.username } })
  res.cookies.set('avt_session', createSessionToken(user.id), sessionCookieOptions())
  return res
}
