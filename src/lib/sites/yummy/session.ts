/**
 * Серверный хелпер: cookie-сессия YummyAnime для приложения.
 * Используется API-роутами функций аккаунта (списки/избранное/оценки).
 * Локальный аккаунт удалён — сессия едина для приложения (ключ "default").
 * Старые записи под ключом локального userId подхватываются (миграция).
 */
import { db } from '@/lib/db'

export interface YummySessionInfo {
  key: string
  cookies: string
  /** снимок профиля из БД (JSON.parse) или null */
  profile: { id: number | null; nickname: string; avatar: string } | null
}

const SESSION_KEY = 'default'

/**
 * Прочитать сохранённую сессию сайта. null — аккаунт не привязан.
 * Живую проверку cookie здесь не делаем (дорого): сайт сам вернёт 401,
 * а UI уже умеет показывать «сессия истекла».
 */
export async function getYummySession(): Promise<YummySessionInfo | null> {
  let row: { id: string; cookies: string; profile: string } | null = null
  try {
    row = await db.yummySession.findFirst({
      where: { cookies: { not: '' } },
      select: { id: true, cookies: true, profile: true },
    })
  } catch {
    return null
  }
  if (!row || !row.cookies) return null
  let profile: YummySessionInfo['profile'] = null
  try {
    const p = JSON.parse(row.profile) as YummySessionInfo['profile']
    if (p && typeof p.nickname === 'string') profile = p
  } catch {
    profile = null
  }
  return { key: row.id === SESSION_KEY ? SESSION_KEY : row.id, cookies: row.cookies, profile }
}
