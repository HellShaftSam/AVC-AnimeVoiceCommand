import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import type { LibraryEntryDto, UserInfoDto, WatchStatus } from '@/lib/avc/types'

export const runtime = 'nodejs'

const WATCH_STATUSES: readonly WatchStatus[] = [
  'watching',
  'planned',
  'completed',
  'dropped',
  'on_hold',
]

type LibraryRow = {
  animeId: number
  title: string
  slug: string | null
  poster: string | null
  status: string
  favorite: boolean
  episode: number | null
  positionSec: number | null
  totalEpisodes: number | null
  currentDub: string | null
  updatedAt: Date
}

function toDto(row: LibraryRow): LibraryEntryDto {
  return {
    animeId: row.animeId,
    title: row.title,
    slug: row.slug,
    poster: row.poster,
    status: (WATCH_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as WatchStatus)
      : 'watching',
    favorite: row.favorite,
    episode: row.episode,
    positionSec: row.positionSec,
    totalEpisodes: row.totalEpisodes,
    currentDub: row.currentDub,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** GET /api/library → {user, entries[]} (updatedAt desc); без сессии — {user:null, entries:[]} */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) return NextResponse.json({ user: null, entries: [] })

  const rows = await db.userLibraryEntry.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
  })
  return NextResponse.json({ user: user satisfies UserInfoDto, entries: rows.map(toDto) })
}

interface LibraryPutBody {
  animeId?: unknown
  title?: unknown
  slug?: unknown
  poster?: unknown
  status?: unknown
  favorite?: unknown
  episode?: unknown
  positionSec?: unknown
  totalEpisodes?: unknown
  currentDub?: unknown
}

/** PUT /api/library — upsert по (userId, animeId); непереданные поля сохраняются */
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) return NextResponse.json({ error: 'Требуется вход' }, { status: 401 })

  let body: LibraryPutBody
  try {
    body = (await req.json()) as LibraryPutBody
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }

  const animeId = Number(body.animeId)
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'animeId обязателен (целое число)' }, { status: 400 })
  }
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    return NextResponse.json({ error: 'title обязателен' }, { status: 400 })
  }
  if (body.status !== undefined) {
    const ok =
      typeof body.status === 'string' &&
      (WATCH_STATUSES as readonly string[]).includes(body.status)
    if (!ok) {
      return NextResponse.json(
        { error: 'status: watching|planned|completed|dropped|on_hold' },
        { status: 400 },
      )
    }
  }

  // Только переданные поля попадают в update (upsert: непереданные сохраняются)
  const createData: Prisma.UserLibraryEntryUncheckedCreateInput = {
    userId: user.id,
    animeId,
    title: body.title.trim(),
  }
  const updateData: Prisma.UserLibraryEntryUncheckedUpdateInput = {
    title: body.title.trim(),
  }
  const setOpt = <K extends keyof Prisma.UserLibraryEntryUncheckedCreateInput>(
    key: K,
    value: Prisma.UserLibraryEntryUncheckedCreateInput[K],
  ) => {
    createData[key] = value
    ;(updateData as Record<string, unknown>)[key as string] = value
  }

  if (body.slug !== undefined) setOpt('slug', body.slug === null ? null : String(body.slug))
  if (body.poster !== undefined)
    setOpt('poster', body.poster === null ? null : String(body.poster))
  if (body.status !== undefined) setOpt('status', body.status as string)
  if (body.favorite !== undefined) setOpt('favorite', Boolean(body.favorite))
  if (body.episode !== undefined)
    setOpt(
      'episode',
      body.episode === null || body.episode === '' ? null : Number(body.episode) || null,
    )
  if (body.positionSec !== undefined)
    setOpt(
      'positionSec',
      body.positionSec === null || body.positionSec === '' ? null : Number(body.positionSec),
    )
  if (body.totalEpisodes !== undefined)
    setOpt(
      'totalEpisodes',
      body.totalEpisodes === null || body.totalEpisodes === ''
        ? null
        : Number(body.totalEpisodes) || null,
    )
  if (body.currentDub !== undefined)
    setOpt('currentDub', body.currentDub === null ? null : String(body.currentDub))

  const entry = await db.userLibraryEntry.upsert({
    where: { userId_animeId: { userId: user.id, animeId } },
    create: createData,
    update: updateData,
  })

  return NextResponse.json({ entry: toDto(entry) })
}

/** DELETE /api/library?animeId=123 → {ok:true}; без сессии — 401 */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) return NextResponse.json({ error: 'Требуется вход' }, { status: 401 })

  const animeId = Number(req.nextUrl.searchParams.get('animeId'))
  if (!Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ error: 'animeId обязателен' }, { status: 400 })
  }

  await db.userLibraryEntry.deleteMany({
    where: { userId: user.id, animeId },
  })
  return NextResponse.json({ ok: true })
}
