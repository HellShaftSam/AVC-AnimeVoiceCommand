/**
 * GET /api/yummy/diagnostics — диагностика аккаунт-интеграции (спека #48).
 *
 * Показывает: состояние авторизации, последние синхронизации по ресурсам,
 * длительности, количество исходящих запросов, cache hits, ошибки, размер
 * кэша, версию адаптера (#46). БЕЗ cookie/токенов/паролей (спека #37).
 */
import { NextResponse } from 'next/server'
import { YummySyncService } from '@/lib/yummy/sync-service'
import { ensureYummyTables } from '@/lib/yummy/migrate'

export const runtime = 'nodejs'

export async function GET() {
  await ensureYummyTables().catch(() => undefined)
  try {
    const d = await YummySyncService.diagnostics()
    return NextResponse.json(d)
  } catch {
    return NextResponse.json({
      hasSession: false,
      authState: 'none',
      lastCheckAt: null,
      resources: [],
      cacheItems: 0,
      adapterVersion: 'unknown',
    })
  }
}
