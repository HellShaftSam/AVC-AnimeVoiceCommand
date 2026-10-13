/**
 * Anime Voice Controller — серверные хелперы аутентификации (nodejs runtime).
 *
 * Прототип: scrypt-хеши паролей + подписанная HMAC-cookie сессии (avt_session).
 * Формат токена: `{userId}.{expiryMs}.{hmacSHA256(userId.expiryMs, SECRET)}`.
 */
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

export const SESSION_COOKIE = 'avt_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 дней

const AUTH_SECRET = process.env.AUTH_SECRET ?? 'avc-dev-secret-2024'

// ---------------------------------------------------------------------------
// Пароли (scrypt со случайной солью)
// ---------------------------------------------------------------------------

/** scrypt-хеш пароля, формат `salt:hex` */
export function hashPassword(pw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex')
    crypto.scrypt(pw, salt, 64, (err, derived) => {
      if (err) reject(err)
      else resolve(`${salt}:${derived.toString('hex')}`)
    })
  })
}

/** Постоянное сравнение хешей */
export function verifyPassword(pw: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [salt, hex] = stored.split(':')
    if (!salt || !hex) return resolve(false)
    crypto.scrypt(pw, salt, 64, (err, derived) => {
      if (err) return resolve(false)
      const candidate = derived.toString('hex')
      const a = Buffer.from(candidate, 'hex')
      const b = Buffer.from(hex, 'hex')
      resolve(a.length === b.length && crypto.timingSafeEqual(a, b))
    })
  })
}

// ---------------------------------------------------------------------------
// Сессии (подписанная HMAC-строка в cookie)
// ---------------------------------------------------------------------------

/** `{userId}.{expiryMs}.{hmac}` */
export function createSessionToken(userId: string): string {
  const expiry = Date.now() + SESSION_TTL_MS
  const payload = `${userId}.${expiry}`
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex')
  return `${payload}.${sig}`
}

/** Возвращает userId или null (неверная подпись / истёк срок) */
export function parseSessionToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, expiry, sig] = parts
  const expected = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${userId}.${expiry}`)
    .digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  if (!Number.isFinite(Number(expiry)) || Number(expiry) < Date.now()) return null
  return userId
}

/** userId из cookie `avt_session` (или null) */
export function getSessionUserId(req: NextRequest): string | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  return parseSessionToken(token)
}

/** Текущий пользователь по cookie-сессии (или null) */
export async function getCurrentUser(
  req: NextRequest,
): Promise<{ id: string; username: string } | null> {
  const userId = getSessionUserId(req)
  if (!userId) return null
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  })
  return user
}

/** Параметры cookie сессии (для NextResponse.cookies.set) */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }
}
