/**
 * GET /api/yummy/auth — состояние авторизации в РЕАЛЬНОМ аккаунте YummyAnime.
 *
 * Trigger A (запуск приложения) / C (открытие аккаунт-панели). TTL профиля
 * 5 мин; сеть недоступна → кэш + флаг stale (спека #25), крэша нет.
 *
 * ?force=1 — ручной refresh (кнопка «Проверить аккаунт»), обходит TTL,
 * но дедуплицируется на сервере (спека #41).
 */
import { NextRequest, NextResponse } from 'next/server'
import { YummySyncService } from '@/lib/yummy/sync-service'
import { ensureYummyTables } from '@/lib/yummy/migrate'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  await ensureYummyTables().catch(() => undefined)
  const force = req.nextUrl.searchParams.get('force') === '1'
  try {
    const outcome = await YummySyncService.checkAuth(force)
    return NextResponse.json({
      state: outcome.state,
      authenticated: outcome.state === 'logged_in',
      profile: outcome.data,
      fromCache: outcome.fromCache,
      stale: outcome.stale,
      changed: outcome.changed,
      error: outcome.error,
      lastSync: outcome.lastSync,
      durationMs: outcome.durationMs,
    })
  } catch (e) {
    // Никогда не крэшимся (спека #26)
    return NextResponse.json({
      state: 'unknown',
      authenticated: false,
      profile: null,
      fromCache: true,
      stale: true,
      changed: false,
      error: e instanceof Error ? 'Ошибка проверки авторизации' : 'Неизвестная ошибка',
      lastSync: null,
      durationMs: null,
    })
  }
}
