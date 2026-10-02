/**
 * /api/yummy/session — мост сессии yummyani.me в серверный адаптер.
 *
 * POST   { cookie: string }  — сохранить cookie-строку (передаёт Electron-оболочка,
 *                              прочитав её из persistent-профиля webview после
 *                              входа пользователя НА РЕАЛЬНОМ сайте).
 * DELETE — выход: best-effort POST /api/profile/logout на сайте + локальная очистка.
 *
 * БЕЗОПАСНОСТЬ:
 *   - пароли не принимаются (только cookie) — вход всегда на реальном сайте;
 *   - cookie в ответе не возвращается и не логируется (секция 37);
 *   - пустые/мусорные значения отклоняются.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'
import {
  clearYummySession,
  getYummySessionSavedAt,
  setYummySessionCookie,
} from '@/lib/sites/yummy/session-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Признаки cookie-строки yummyani.me (грубая валидация без парсинга секретов) */
function looksLikeCookie(v: string): boolean {
  return v.length >= 8 && /=/.test(v) && /^[\x21-\x7E\s;]+$/.test(v)
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { cookie?: unknown }
    const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
    if (!cookie) {
      return NextResponse.json({ error: 'Поле cookie обязательно' }, { status: 400 })
    }
    if (!looksLikeCookie(cookie)) {
      return NextResponse.json(
        { error: 'Строка не похожа на cookie-набор (ожидается «name=value; ...»)' },
        { status: 400 },
      )
    }
    setYummySessionCookie(cookie)
    // Немедленная валидация на сайте (секция 13-B: после логина — полная синк)
    const snapshot = await getAdapter().getAccountState({ refresh: true })
    return NextResponse.json({ ok: true, savedAt: getYummySessionSavedAt(), account: snapshot })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка сохранения сессии' },
      { status: 500 },
    )
  }
}

export async function DELETE() {
  const logoutSent = await getAdapter().siteLogout().catch(() => false)
  clearYummySession()
  getAdapter().resetAccountCache()
  return NextResponse.json({ ok: true, logoutSent })
}
