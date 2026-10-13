/**
 * /api/companion/quests — квесты и достижения Anime Companion.
 *
 *   GET  → { achievements, custom, available, reason }
 *   POST {title, metric, target} → { item }
 *
 * Достижения БЕЗ таблицы — детерминированный расчёт из реальных событий
 * (локальный трекинг + Хроники + библиотека сайта). Библиотека недоступна →
 * прогресс по ratings/favorites/completed-started = null + честная причина.
 */
import { NextRequest, NextResponse } from 'next/server'
import { resolveAccountKey } from '@/lib/companion/data'
import { computeQuests, createQuest, validateQuestInput } from '@/lib/companion/quests'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const acc = await resolveAccountKey()
    const result = await computeQuests(acc.accountKey)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: `Квесты недоступны: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Ожидался JSON' }, { status: 400 })
  }
  const normalized = validateQuestInput(body)
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 })
  }
  try {
    const acc = await resolveAccountKey()
    const row = await createQuest(acc.accountKey, normalized.value)
    return NextResponse.json({
      item: {
        id: row.id,
        title: row.title,
        metric: row.metric,
        target: row.target,
        archived: row.archived,
        createdAt: row.createdAt.toISOString(),
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: `Не удалось создать цель: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}
