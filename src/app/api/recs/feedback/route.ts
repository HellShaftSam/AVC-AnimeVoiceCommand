/**
 * Обратная связь рекомендаций (ТЗ §15, лёгкие действия):
 *   POST   {animeId, action: 'hide'|'seen', title?} — отметить
 *   DELETE ?animeId=…  — отозвать отметку (кнопка «вернуть»; один клик не портит профиль)
 *
 * Отметки фильтруются ЖЁСТКО до ранжирования (как «известные» тайтлы).
 * Изоляция аккаунтов: accountKey = числовой userId сайта (профиль сессии).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchProfile, parseProfile } from '@/lib/sites/yummy/web-auth'
import { loadWebSession } from '@/lib/sites/yummy/web-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function accountKey(): Promise<string | null> {
  const session = await loadWebSession()
  if (!session) return null
  const profile = await fetchProfile(session.cookie)
  if (profile.status !== 200) return null
  const user = parseProfile(profile.body)
  return user?.userId?.match(/^(\d+)$/)?.[1] ?? null
}

export async function POST(req: NextRequest) {
  const key = await accountKey()
  if (!key) {
    return NextResponse.json({ ok: false, error: 'Нет активной сессии YummyAnime' }, { status: 401 })
  }
  let body: { animeId?: unknown; action?: unknown; title?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Некорректный JSON' }, { status: 400 })
  }
  const animeId = Number(body.animeId)
  const action = body.action
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ ok: false, error: 'animeId обязателен' }, { status: 400 })
  }
  if (action !== 'hide' && action !== 'seen') {
    return NextResponse.json({ ok: false, error: "action: 'hide' | 'seen'" }, { status: 400 })
  }
  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : ''
  await db.recFeedback.upsert({
    where: { accountKey_animeId_action: { accountKey: key, animeId, action } },
    create: { accountKey: key, animeId, action, title },
    update: { title },
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const key = await accountKey()
  if (!key) {
    return NextResponse.json({ ok: false, error: 'Нет активной сессии YummyAnime' }, { status: 401 })
  }
  const animeId = Number(req.nextUrl.searchParams.get('animeId'))
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ ok: false, error: 'animeId обязателен' }, { status: 400 })
  }
  await db.recFeedback.deleteMany({ where: { accountKey: key, animeId } })
  return NextResponse.json({ ok: true })
}
