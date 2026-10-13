/**
 * GET /api/yummy/lists — реальные закладки/списки YummyAnime (Task 17).
 *
 * Trigger D (открытие закладок) / H (изменение закладки на сайте).
 * TTL 2 мин; hash-детект изменений; офлайн → кэш + stale (спека #25).
 * ?force=1 — ручной refresh (спека #41), дедуплицируется на сервере.
 *
 * Ответ: {ok, authenticated, items, fromCache, stale, changed, lastSync,
 *         durationMs, error}
 */
import { NextRequest, NextResponse } from 'next/server'
import { YummySyncService } from '@/lib/yummy/sync-service'
import { ensureYummyTables } from '@/lib/yummy/migrate'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  await ensureYummyTables().catch(() => undefined)
  const force = req.nextUrl.searchParams.get('force') === '1'
  try {
    const outcome = await YummySyncService.syncLists(force)
    if (outcome.error === 'not_authenticated') {
      return NextResponse.json({
        ok: false,
        authenticated: false,
        items: [],
        fromCache: false,
        stale: false,
        changed: false,
        error: null,
        lastSync: null,
        durationMs: null,
      })
    }
    return NextResponse.json({
      ok: outcome.ok,
      authenticated: true,
      items: outcome.data ?? [],
      fromCache: outcome.fromCache,
      stale: outcome.stale,
      changed: outcome.changed,
      error: outcome.error,
      lastSync: outcome.lastSync,
      durationMs: outcome.durationMs,
    })
  } catch (e) {
    // Офлайн/сбой БД — не крэшимся (спека #26), причину пишем в лог
    console.error(
      '[YummyAnime][lists] sync failed:',
      e instanceof Error ? e.message : String(e),
    )
    return NextResponse.json({
      ok: false,
      authenticated: true,
      items: [],
      fromCache: true,
      stale: true,
      changed: false,
      error: 'Не удалось синхронизировать закладки',
      lastSync: null,
      durationMs: null,
    })
  }
}
