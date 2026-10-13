/**
 * POST /api/yummy/logout — выход из РЕАЛЬНОГО аккаунта YummyAnime (Task 17).
 *
 * Штатный logout сайта (POST /api/profile/logout) + удаление сессии и
 * кэша списков. Локальные данные устройства (история просмотров, библиотека
 * локального профиля) НЕ стираются (спека #27).
 */
import { NextResponse } from 'next/server'
import { YummySyncService } from '@/lib/yummy/sync-service'
import { ensureYummyTables } from '@/lib/yummy/migrate'
import { invalidateRecsSnapshots } from '@/lib/recs/snapshot'
import { clearAnilistCache } from '@/lib/recs/anilist'

export const runtime = 'nodejs'

export async function POST() {
  await ensureYummyTables().catch(() => undefined)
  try {
    const res = await YummySyncService.logout()
    // Рекомендации аккаунт-специфичны: снапшоты и внешний кэш инвалидируются,
    // чтобы чужие/старые подборки не утекли в новую сессию (ТЗ §11, сценарий J)
    await invalidateRecsSnapshots().catch(() => undefined)
    clearAnilistCache()
    return NextResponse.json({ ok: true, warning: res.error })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Не удалось выйти — попробуйте ещё раз' },
      { status: 500 },
    )
  }
}
