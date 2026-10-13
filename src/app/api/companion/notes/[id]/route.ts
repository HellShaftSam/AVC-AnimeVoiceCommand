/**
 * /api/companion/notes/[id] — конкретная запись Хроник (только владелец).
 *
 *   PATCH  {text?, tags?, episode?, kind?} → { item: NoteDto }
 *   DELETE → { ok: true }
 *
 * Запись другого аккаунта или несуществующая → 404 (без различения — не
 * раскрываем чужие id). accountKey = числовой userId сайта либо 'anon'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeNotePatch, noteToDto, resolveAccountKey } from '@/lib/companion/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: 'Некорректный id записи' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Ожидался JSON' }, { status: 400 })
  }
  const normalized = normalizeNotePatch(body)
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 })
  }

  try {
    const acc = await resolveAccountKey()
    const existing = await db.viewerNote.findUnique({ where: { id } })
    if (!existing || existing.accountKey !== acc.accountKey) {
      return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 })
    }
    const row = await db.viewerNote.update({ where: { id }, data: normalized.value })
    return NextResponse.json({ item: noteToDto(row) })
  } catch (e) {
    return NextResponse.json(
      { error: `Не удалось обновить запись: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: 'Некорректный id записи' }, { status: 400 })
  }
  try {
    const acc = await resolveAccountKey()
    const res = await db.viewerNote.deleteMany({ where: { id, accountKey: acc.accountKey } })
    if (res.count === 0) {
      return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: `Не удалось удалить запись: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}
