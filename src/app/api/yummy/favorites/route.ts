/**
 * GET /api/yummy/favorites — избранное пользователя YummyAnime.
 *
 * Спецификация (секции 13/15/16): доступ к аутентифицированным данным сайта
 * выполняется постоянной браузерной сессией Electron (main-процесс), cookie в
 * Next.js API не передаются. В веб-режиме — честная причина недоступности.
 * В EXE-сборке UI берёт избранное напрямую через IPC (window.avcElectron).
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    available: false,
    items: [],
    reason: 'Избранное живёт в постоянной сессии сайта — доступно в EXE-сборке',
    lastSync: null,
  })
}
