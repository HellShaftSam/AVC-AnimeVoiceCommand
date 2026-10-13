/**
 * GET /api/companion/taste — карта вкусов (Anime Companion, ТЗ §9).
 *
 * Только реальные сигналы: Любимые (список 4) + свои оценки ≥7 с сайта.
 * Нет данных → пустые массивы + available:true + подсказка. Библиотека
 * недоступна → available:false + причина. Кэш результата 60 с.
 */
import { NextResponse } from 'next/server'
import { resolveAccountKey } from '@/lib/companion/data'
import { getTaste } from '@/lib/companion/taste'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const acc = await resolveAccountKey()
    const taste = await getTaste(acc.accountKey)
    return NextResponse.json(taste)
  } catch (e) {
    return NextResponse.json(
      { error: `Карта вкусов недоступна: ${e instanceof Error ? e.message : 'ошибка'}` },
      { status: 500 },
    )
  }
}
