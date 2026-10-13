/**
 * Anime Companion — агрегат «Обзор» для хаба (ТЗ §7).
 *
 * Один батч параллельных запросов (без N+1): счётчики заметок, незаконченные
 * тайтлы локального трекинга, «продолжить watching», последние 5 записей Хроник.
 * Счётчики библиотеки (Смотрю/Любимые/Просмотрено) — только если библиотека
 * сайта доступна; иначе null + честная причина (ничего не выдумываем).
 */
import { db } from '@/lib/db'
import type { WatchProgressItem } from '@/lib/avc/types'
import { noteToDto, truncateText, type NoteDto } from './data'
import { loadLibrary } from './library'

export interface OverviewCounts {
  /** Все записи Хроник */
  notes: number
  /** Закладки моментов (kind='moment') */
  moments: number
  /** Список 0 «Смотрю» с сайта; null — библиотека недоступна */
  watching: number | null
  /** Список 4 «Любимые»; null — библиотека недоступна */
  favorites: number | null
  /** Список 2 «Просмотрено»; null — библиотека недоступна */
  completed: number | null
  /** Незаконченные: episodesTotal и episode известны и episode < episodesTotal */
  unfinished: number
}

export interface OverviewResult {
  accountKey: string
  counts: OverviewCounts
  /** Причина недоступности библиотеки (watching/favorites/completed = null) */
  libraryReason: string | null
  /** Самый свежий трекинг с открытой серией — для кнопки «Продолжить» */
  continueItem: WatchProgressItem | null
  /** Последние 5 записей Хроник (текст обрезан до 160 символов — превью) */
  recentNotes: NoteDto[]
}

const RECENT_NOTES_PREVIEW_LEN = 160

function toProgressItem(row: {
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  episodesTotal: number | null
  dubbing: string | null
  updatedAt: Date
}): WatchProgressItem {
  return {
    animeId: row.animeId,
    slug: row.slug,
    title: row.title,
    poster: row.poster,
    episode: row.episode,
    episodesTotal: row.episodesTotal,
    dubbing: row.dubbing,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getOverview(accountKey: string): Promise<OverviewResult> {
  const [notesCount, momentsCount, progressRows, continueRow, recentRows, library] =
    await Promise.all([
      db.viewerNote.count({ where: { accountKey } }),
      db.viewerNote.count({ where: { accountKey, kind: 'moment' } }),
      db.watchProgressEntry.findMany({
        where: { accountKey },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      db.watchProgressEntry.findFirst({
        where: { accountKey, episode: { not: null } },
        orderBy: { updatedAt: 'desc' },
      }),
      db.viewerNote.findMany({
        where: { accountKey },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      loadLibrary().catch(() => ({
        ok: false as const,
        reason: 'Не удалось прочитать библиотеку сайта',
      })),
    ])

  // Сравнение двух колонок SQLite через Prisma не выражается — считаем по строкам
  // (трекинг ограничен take:200, для локальной БД это дёшево)
  const unfinished = progressRows.filter(
    (r) => r.episodesTotal !== null && r.episode !== null && r.episode < r.episodesTotal,
  ).length

  let watching: number | null = null
  let favorites: number | null = null
  let completed: number | null = null
  let libraryReason: string | null = null
  if (library.ok) {
    for (const list of library.snapshot.lists) {
      const n = list.items.length
      if (list.listId === 0) watching = n
      else if (list.listId === 4) favorites = n
      else if (list.listId === 2) completed = n
    }
  } else {
    libraryReason = library.reason
  }

  return {
    accountKey,
    counts: {
      notes: notesCount,
      moments: momentsCount,
      watching,
      favorites,
      completed,
      unfinished,
    },
    libraryReason,
    continueItem: continueRow ? toProgressItem(continueRow) : null,
    recentNotes: recentRows.map((r) => ({ ...noteToDto(r), text: truncateText(r.text, RECENT_NOTES_PREVIEW_LEN) })),
  }
}
