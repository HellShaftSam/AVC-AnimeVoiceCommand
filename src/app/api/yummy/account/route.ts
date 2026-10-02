/**
 * GET /api/yummy/account — состояние аккаунта YummyAnime.
 *
 * АРХИТЕКТУРА (спецификация «Production-Ready Authentication», секции 3/15/16):
 *   Сессия сайта живёт ТОЛЬКО в постоянном браузерном профиле Electron-оболочки
 *   (partition 'persist:yummyanime'). Cookie не пересекают границу рендерера и
 *   не передаются в Next.js API — поэтому сервер не может и не должен знать
 *   состояние сессии.
 *
 *   - EXE-сборка: UI получает снимок через IPC (window.avcElectron), этот роут
 *     не используется для аутентифицированных данных.
 *   - Веб-режим (браузер без оболочки): честно сообщаем, что аккаунт
 *     доступен только в EXE. Ничего не выдумываем.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    state: 'unavailable',
    user: null,
    lastSync: null,
    source: 'no-session',
    message:
      'Сессия YummyAnime живёт в EXE-сборке (постоянный профиль сайта). В веб-режиме аккаунт недоступен.',
  })
}
