/**
 * Jar-хелперы (Task 17): привязка браузера ↔ серверной сессии YummyAnime.
 *
 * httpOnly cookie `avc_yummy_jar` = случайный id + HMAC-подпись. Значение
 * cookie сессии САЙТА хранится только в SQLite (YummySession) и никогда
 * не попадает в ответы API и логи (спека #30, #37).
 */
import { createHmac, randomBytes } from 'crypto'
import { cookies } from 'next/headers'

export const JAR_COOKIE = 'avc_yummy_jar'
export const JAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 год

function jarSecret(): string {
  return process.env.AUTH_SECRET ?? 'avc-dev-secret-2024'
}

export function signJarId(id: string): string {
  return createHmac('sha256', jarSecret()).update(id).digest('hex').slice(0, 24)
}

/** Jar id из httpOnly cookie (или null). Подпись защищает от подделки id. */
export async function readJarId(): Promise<string | null> {
  const jar = await cookies()
  const raw = jar.get(JAR_COOKIE)?.value
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const id = raw.slice(0, dot)
  return signJarId(id) === raw.slice(dot + 1) ? id : null
}

/** Вернуть существующий jar id или создать новый (с выставлением cookie). */
export async function ensureJar(): Promise<string> {
  const existing = await readJarId()
  if (existing) return existing
  const id = randomBytes(16).toString('hex')
  const jar = await cookies()
  jar.set(JAR_COOKIE, `${id}.${signJarId(id)}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: JAR_COOKIE_MAX_AGE,
  })
  return id
}
