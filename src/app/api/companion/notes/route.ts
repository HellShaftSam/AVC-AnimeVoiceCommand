/**
 * /api/companion/notes — Хроники зрителя (заметки/цитаты/моменты/впечатления).
 *
 *   GET  ?q&kind&animeId&limit&offset → { items: NoteDto[], total }
 *   POST {kind, animeId, slug, title, poster?, episode?, text, positionSec?, durationSec?, tags?}
 *        → { item: NoteDto }
 *
 * Изоляция аккаунтов: accountKey = числовой userId сайта либо 'anon' (гость).
 * Поиск q — регистронезависимый по text/title/tags: SQLite LIKE чувствителен
 * к регистру кириллицы, поэтому фильтруем в JS по нижнему регистру (выборка
 * ограничена 2000 свежих записей — для локальных Хроник этого достаточно).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  isNoteKind,
  normalizeNoteInput,
  noteToDto,
  resolveAccountKey,
} from '@/lib/companion/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SEARCH_SCAN_LIMIT = 2000

export async function GET(req: NextRequest) {
  try {
    const acc = await resolveAccountKey()
    const sp = req.nextUrl.searchParams

    // --- фильтры (некорректные значения — честный 400, а не тихое игнорирование)
    const kindRaw = sp.get('kind')
    let kind: string | null = null
    if (kindRaw !== null && kindRaw !== '') {
      if (!isNoteKind(kindRaw)) {
        return NextResponse.json(
          { error: 'Неизвестный тип записи (kind: note | quote | moment | impression)' },
          { status: 400 },
        )
      }
      kind = kindRaw
    }

    let animeId: number | null = null
    const animeIdRaw = sp.get('animeId')
    if (animeIdRaw !== null && animeIdRaw !== '') {
      const n = Number(animeIdRaw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: 'animeId должен быть целым числом > 0' }, { status: 400 })
      }
      animeId = n
    }

    let limit = 30
    const limitRaw = sp.get('limit')
    if (limitRaw !== null) {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: 'limit должен быть целым числом ≥ 1' }, { status: 400 })
      }
      limit = Math.min(n, 100)
    }

    let offset = 0
    const offsetRaw = sp.get('offset')
    if (offsetRaw !== null) {
      const n = Number(offsetRaw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return NextResponse.json({ error: 'offset должен быть целым числом ≥ 0' }, { status: 400 })
      }
      offset = n
    }

    const q = (sp.get('q') ?? '').trim()

    const where = {
      accountKey: acc.accountKey,
      ...(kind ? { kind } : {}),
      ...(animeId !== null ? { animeId } : {}),
    }

    // --- текстовый поиск: регистронезависимый (кириллица) фильтр в JS
    if (q !== '') {
      const rows = await db.viewerNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: SEARCH_SCAN_LIMIT,
      })
      const ql = q.toLowerCase()
      const filtered = rows.filter(
        (r) =>
          r.text.toLowerCase().includes(ql) ||
          r.title.toLowerCase().includes(ql) ||
          r.tags.toLowerCase().includes(ql),
      )
      return NextResponse.json({
        items: filtered.slice(offset, offset + limit).map(noteToDto),
        total: filtered.length,
      })
    }

    const [total, rows] = await Promise.all([
      db.viewerNote.count({ where }),
      db.viewerNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ])
    return NextResponse.json({ items: rows.map(noteToDto), total })
  } catch (e) {
    return NextResponse.json(
      { error: `Хроники недоступны: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
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

  const normalized = normalizeNoteInput(body)
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 })
  }

  try {
    const acc = await resolveAccountKey()
    const row = await db.viewerNote.create({
      data: { accountKey: acc.accountKey, ...normalized.value },
    })
    return NextResponse.json({ item: noteToDto(row) })
  } catch (e) {
    return NextResponse.json(
      { error: `Не удалось сохранить запись: ${e instanceof Error ? e.message : 'ошибка базы данных'}` },
      { status: 500 },
    )
  }
}
