/**
 * История просмотров (Persistent Watch History, мастер-промпт №1).
 *
 * GET    /api/watch-history?limit=200        — список записей (свежие сверху)
 * GET    /api/watch-history?animeId=123      — все серии конкретного аниме
 * PUT    /api/watch-history                  — upsert прогресса (по animeId+episode)
 * DELETE /api/watch-history?animeId=123      — убрать аниме из истории (все серии)
 * DELETE /api/watch-history?animeId=123&episode=6 — убрать одну серию
 * DELETE /api/watch-history                  — очистить всю видимую историю
 *
 * Область видимости: у анонима — общая история устройства (userId=null);
 * у залогиненного — своя история плюс общая история устройства.
 * Пароли/токены не хранятся и не логируются.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getSessionUserId } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** Порог завершённости серии: >= 90% длительности = просмотрено */
const COMPLETION_THRESHOLD = 0.9

function clampNum(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

function parseId(raw: string | null): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const limit = Math.min(500, parseInt(sp.get('limit') ?? '300', 10) || 300)
  const animeId = parseId(sp.get('animeId'))
  const userId = await getSessionUserId(req)
  const scope: Prisma.WatchHistoryEntryWhereInput = userId
    ? { OR: [{ userId }, { userId: null }] }
    : { userId: null }
  try {
    const items = await db.watchHistoryEntry.findMany({
      where: { ...scope, ...(animeId ? { animeId } : {}) },
      orderBy: { lastWatchedAt: 'desc' },
      take: limit,
    })
    return NextResponse.json({ items })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка чтения истории просмотров' },
      { status: 500 },
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>
    const animeId = Math.trunc(clampNum(b.animeId, 0, 2 ** 31))
    const episodeNumber = Math.trunc(clampNum(b.episodeNumber, 0, 100000))
    if (!animeId || !episodeNumber) {
      return NextResponse.json({ error: 'Нужны animeId и episodeNumber' }, { status: 400 })
    }
    const userId = await getSessionUserId(req)
    const title = String(b.animeTitle ?? 'Без названия').slice(0, 300)
    const position = clampNum(b.lastPositionSec, 0, 360000)
    const duration = clampNum(b.durationSec, 0, 360000)
    const percent =
      duration > 0 ? clampNum(Math.round((position / duration) * 1000) / 10, 0, 100) : 0
    // Завершённость: явный флаг (событие ended) ИЛИ порог 90% (fallback)
    const completed =
      b.completed === true || (duration > 0 && position / duration >= COMPLETION_THRESHOLD)
    const data = {
      animeTitle: title,
      animeSlug: typeof b.animeSlug === 'string' ? b.animeSlug.slice(0, 300) : null,
      poster: typeof b.poster === 'string' ? b.poster.slice(0, 500) : null,
      episodeId: Number.isFinite(Number(b.episodeId)) ? Math.trunc(Number(b.episodeId)) : null,
      episodeTitle: typeof b.episodeTitle === 'string' ? b.episodeTitle.slice(0, 300) : null,
      lastPositionSec: Math.round(position * 10) / 10,
      durationSec: Math.round(duration * 10) / 10,
      watchedPercent: percent,
      completed,
      lastDub: typeof b.lastDub === 'string' ? b.lastDub.slice(0, 200) : null,
      lastQuality: typeof b.lastQuality === 'string' ? b.lastQuality.slice(0, 50) : null,
      lastKnownUrl: typeof b.lastKnownUrl === 'string' ? b.lastKnownUrl.slice(0, 1000) : null,
    }
    // userId входит в составной unique, но nullable — upsert-by-unique в Prisma
    // требует не-null: делаем findFirst + create/update вручную
    const existing = await db.watchHistoryEntry.findFirst({
      where: {
        siteId: 'yummyanime',
        userId: userId ?? null,
        animeId,
        episodeNumber,
      },
      select: { id: true },
    })
    const item = existing
      ? await db.watchHistoryEntry.update({ where: { id: existing.id }, data })
      : await db.watchHistoryEntry.create({
          data: {
            siteId: 'yummyanime',
            userId: userId ?? null,
            animeId,
            episodeNumber,
            ...data,
          },
        })
    return NextResponse.json({ item })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка записи истории просмотров' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const animeId = parseId(sp.get('animeId'))
  const episode = parseId(sp.get('episode'))
  const userId = await getSessionUserId(req)
  // Чистим ровно ту область, которую пользователь видит в GET
  const scope: Prisma.WatchHistoryEntryWhereInput = userId
    ? { OR: [{ userId }, { userId: null }] }
    : { userId: null }
  try {
    const removed = await db.watchHistoryEntry.deleteMany({
      where: {
        ...scope,
        ...(animeId ? { animeId } : {}),
        ...(animeId && episode ? { episodeNumber: episode } : {}),
      },
    })
    return NextResponse.json({ ok: true, removed: removed.count })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка очистки истории просмотров' },
      { status: 500 },
    )
  }
}
