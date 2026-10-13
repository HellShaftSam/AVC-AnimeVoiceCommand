/**
 * Внутренняя разовая миграция EXE (только при AVC_ELECTRON=1).
 *
 * Зачем: в 1.3.1 в упакованную БД случайно попали артефакты песочницы —
 * тестовая Yummy-сессия (приложение выглядело «уже вошедшим», кнопки «Войти» не было),
 * устаревший micDeviceId (capture не мог открыть микрофон — «таймаут 15 с») и
 * тестовые вкладки/история. Эта очистка выполняется ОДИН раз на версию приложения:
 *   1-й запуск 1.3.2 → чистит старые артефакты (в т.ч. в уже существующем avc.db
 *   пользователя) и ставит маркер exeSanitizedVersion;
 *   последующие запуски → no-op (реальные входы/вкладки пользователя не трогаются).
 *
 * POST /api/maintenance { version } -> { cleaned: {...}, sanitized: boolean }
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const MARKER_KEY = 'exeSanitizedVersion'

export async function POST(req: NextRequest) {
  // Endpoint только для встроенного сервера EXE; извне (браузер/сеть) — запрещён
  if (process.env.AVC_ELECTRON !== '1') {
    return NextResponse.json({ error: 'not available' }, { status: 404 })
  }
  try {
    const { version } = (await req.json()) as { version?: string }
    const v = String(version || '').slice(0, 32)
    if (!v) return NextResponse.json({ error: 'version required' }, { status: 400 })

    const marker = await db.appSetting.findUnique({ where: { key: MARKER_KEY } })
    if (marker && marker.value === v) {
      return NextResponse.json({ sanitized: false, cleaned: {}, version: v })
    }

    const yummySessions = await db.yummySession.deleteMany({})
    const tabSessions = await db.tabSession.deleteMany({})
    const history = await db.commandHistoryEntry.deleteMany({})
    await db.appSetting.upsert({
      where: { key: 'micDeviceId' },
      create: { key: 'micDeviceId', value: JSON.stringify('') },
      update: { value: JSON.stringify('') },
    })
    await db.appSetting.upsert({
      where: { key: MARKER_KEY },
      create: { key: MARKER_KEY, value: v },
      update: { value: v },
    })

    return NextResponse.json({
      sanitized: true,
      version: v,
      cleaned: {
        yummySessions: yummySessions.count,
        tabSessions: tabSessions.count,
        history: history.count,
        micDeviceId: 'reset',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка обслуживания БД' },
      { status: 500 },
    )
  }
}
