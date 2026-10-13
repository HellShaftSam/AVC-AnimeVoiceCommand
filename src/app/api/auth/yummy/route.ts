import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { yummyLogin, yummyLogout, yummyMe, type YummyProfile } from '@/lib/sites/yummy/auth'

export const runtime = 'nodejs'

/**
 * Авторизация в аккаунте YummyAnime (прокси на сайт).
 * Пароль проходит насквозь и не сохраняется; хранится только cookie-сессия сайта.
 * Локальный аккаунт удалён — сессия сайта едина для приложения (ключ "default").
 */

const SESSION_KEY = 'default'

/** Первая сессия сайта в БД (миграция старых сборок, где ключом был локальный userId) */
async function findAnySession() {
  const current = await db.yummySession.findUnique({ where: { id: SESSION_KEY } })
  if (current) return current
  return db.yummySession.findFirst()
}

/** Перенести сессию под единый ключ "default" (одноразовая миграция) */
async function migrateToDefault(id: string, cookies: string, profile: string) {
  await db.yummySession.delete({ where: { id } }).catch(() => {})
  await db.yummySession
    .upsert({
      where: { id: SESSION_KEY },
      create: { id: SESSION_KEY, cookies, profile },
      update: { cookies, profile },
    })
    .catch(() => {})
}

function parseProfile(json: string): YummyProfile | null {
  try {
    const p = JSON.parse(json) as YummyProfile
    return p && typeof p.nickname === 'string' ? p : null
  } catch {
    return null
  }
}

/** GET /api/auth/yummy → текущий сохранённый аккаунт (+ живая проверка cookie) */
export async function GET() {
  const row = await findAnySession()
  if (!row || !row.cookies) {
    return NextResponse.json({ connected: false })
  }

  const stored = parseProfile(row.profile)
  // Живая проверка: cookie может протухнуть — тогда честно сообщаем и чистим
  const me = await yummyMe(row.cookies)
  if (me.valid && me.profile) {
    const profileJson = JSON.stringify(me.profile)
    if (row.id !== SESSION_KEY) {
      await migrateToDefault(row.id, row.cookies, profileJson)
    } else if (profileJson !== row.profile) {
      await db.yummySession.update({
        where: { id: SESSION_KEY },
        data: { profile: profileJson },
      })
    }
    return NextResponse.json({ connected: true, profile: me.profile })
  }
  if (me.reason === 'unavailable') {
    // Сайт недоступен — показываем сохранённый снимок, не разлогиниваем
    return NextResponse.json({ connected: true, profile: stored, stale: true })
  }
  await db.yummySession.delete({ where: { id: row.id } }).catch(() => {})
  return NextResponse.json({ connected: false, expired: true })
}

/** POST /api/auth/yummy {login, password} → вход на сайт */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const { login, password } = (body ?? {}) as { login?: unknown; password?: unknown }
  if (typeof login !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Нужны login и password' }, { status: 400 })
  }

  const result = await yummyLogin(login, password)
  if (!result.ok) {
    // Дружелюбные коды для UI; message — человекочитаемый текст от сайта/прокси
    return NextResponse.json({ error: result.message, code: result.code }, { status: 401 })
  }

  const data = {
    cookies: result.cookies,
    profile: JSON.stringify(result.profile),
  }
  // Старые сессии (под ключом локального userId) замещаем единой сессией
  await db.yummySession.deleteMany({
    where: { id: { not: SESSION_KEY } },
  }).catch(() => {})
  await db.yummySession.upsert({
    where: { id: SESSION_KEY },
    create: { id: SESSION_KEY, ...data },
    update: data,
  })

  return NextResponse.json({ connected: true, profile: result.profile })
}

/** DELETE /api/auth/yummy → выход (logout на сайте + удаление сессии) */
export async function DELETE() {
  const row = await findAnySession()
  if (row?.cookies) {
    await yummyLogout(row.cookies) // best-effort, не блокирует выход
  }
  await db.yummySession.deleteMany({}).catch(() => {})
  return NextResponse.json({ connected: false })
}
