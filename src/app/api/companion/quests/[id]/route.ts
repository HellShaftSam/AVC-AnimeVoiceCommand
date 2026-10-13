/**
 * DELETE /api/companion/quests/[id] — архивировать пользовательскую цель
 * (мягкое удаление: строка остаётся, исчезает из активных). Только владелец;
 * чужая/несуществующая цель → 404.
 */
import { NextRequest, NextResponse } from 'next/server'
import { resolveAccountKey } from '@/lib/companion/data'
import { archiveQuest } from '@/lib/companion/quests'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: 'Некорректный id цели' }, { status: 400 })
  }
  try {
    const acc = await resolveAccountKey()
    const archived = await archiveQuest(acc.accountKey, id)
    if (!archived) {
      return NextResponse.json({ error: 'Цель не найдена' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: `Не удалось архивировать цель: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}
