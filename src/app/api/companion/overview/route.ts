/**
 * GET /api/companion/overview — агрегат «Обзор» хаба Anime Companion.
 *
 * accountKey — серверная сессия сайта (числовой userId) либо 'anon' (гость).
 * Один батч Prisma-запросов + библиотека сайта с TTL-кэшем (см. lib/companion).
 */
import { NextResponse } from 'next/server'
import { resolveAccountKey } from '@/lib/companion/data'
import { getOverview } from '@/lib/companion/overview'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const acc = await resolveAccountKey()
    const overview = await getOverview(acc.accountKey)
    return NextResponse.json({ ...overview, accountReason: acc.reason })
  } catch (e) {
    return NextResponse.json(
      { error: `Обзор недоступен: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}
