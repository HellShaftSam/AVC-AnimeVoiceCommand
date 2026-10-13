/**
 * Anime Companion — квесты и достижения (ТЗ §17).
 *
 * Два вида целей, обе считаются ТОЛЬКО по реальным событиям:
 *  1. Статические достижения — БЕЗ таблицы: детерминированный расчёт при запросе
 *     из локального трекинга (WatchProgressEntry), Хроник (ViewerNote) и библиотеки сайта.
 *  2. Пользовательские цели (UserQuest) — title + metric + target; прогресс — те же счётчики.
 *
 * Библиотека сайта недоступна → метрики ratings/favorites/completed-started дают
 * progress=null (честное «нет данных»), локальные метрики считаются всегда.
 */
import { db } from '@/lib/db'
import type { UserQuest as UserQuestRow } from '@prisma/client'
import { loadLibrary } from './library'

// --- метрики ---------------------------------------------------------------------

export const QUEST_METRICS = ['episodes', 'titles', 'notes', 'ratings', 'favorites'] as const
export type QuestMetric = (typeof QUEST_METRICS)[number]

export type AnyQuestMetric = QuestMetric | 'completed-started'

/** Счётчики реальной активности. null = нет данных (библиотека сайта недоступна) */
export interface QuestCounters {
  /** Тайтлов в истории просмотра (WatchProgressEntry) */
  titles: number
  /** Сумма последних серий по тайтлам (локальный трекинг) */
  episodes: number
  /** Записей в Хрониках (ViewerNote) */
  notes: number
  /** Своих оценок в библиотеке (user.rating ≥ 1) */
  ratings: number | null
  /** Любимых (список 4 + флаг is_fav) */
  favorites: number | null
  /** Начатый тайтл доведён до «Просмотрено» (пересечение трекинга и списка 2) */
  completedStarted: number | null
}

export const QUEST_METRIC_LABELS: Record<AnyQuestMetric, string> = {
  episodes: 'серий',
  titles: 'тайтлов',
  notes: 'записей',
  ratings: 'оценок',
  favorites: 'любимых',
  'completed-started': 'завершённых',
}

// --- статические достижения --------------------------------------------------------

export interface AchievementDef {
  id: string
  title: string
  description: string
  metric: AnyQuestMetric
  target: number
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    id: 'first-step',
    title: 'Первый шаг',
    description: 'Открыть первое аниме в истории просмотра',
    metric: 'titles',
    target: 1,
  },
  {
    id: 'episodes-50',
    title: 'Пятьдесят серий',
    description: 'Просмотреть суммарно 50 серий по трекингу приложения',
    metric: 'episodes',
    target: 50,
  },
  {
    id: 'chronicler',
    title: 'Хроникёр',
    description: 'Сделать 5 записей в Хрониках',
    metric: 'notes',
    target: 5,
  },
  {
    id: 'critic',
    title: 'Критик',
    description: 'Поставить 3 своих оценки в библиотеке на сайте',
    metric: 'ratings',
    target: 3,
  },
  {
    id: 'collector',
    title: 'Коллекционер',
    description: 'Добавить 3 тайтла в Любимые',
    metric: 'favorites',
    target: 3,
  },
  {
    id: 'finisher',
    title: 'Завершитель',
    description: 'Довести начатый тайтл до статуса «Просмотрено»',
    metric: 'completed-started',
    target: 1,
  },
]

// --- чистая арифметика (тестируется без БД) ----------------------------------------

/**
 * Прогресс по счётчикам. ЧИСТАЯ функция — экспортирована для тестов.
 * counter=null (нет данных) → progress=null.
 */
export function computeProgressFromCounters(
  counters: QuestCounters,
  metric: AnyQuestMetric,
): number | null {
  switch (metric) {
    case 'titles':
      return counters.titles
    case 'episodes':
      return counters.episodes
    case 'notes':
      return counters.notes
    case 'ratings':
      return counters.ratings
    case 'favorites':
      return counters.favorites
    case 'completed-started':
      return counters.completedStarted
  }
}

// --- сбор счётчиков -----------------------------------------------------------------

/** Собрать счётчики реальной активности (1 батч: трекинг + хроники + библиотека) */
export async function collectCounters(accountKey: string): Promise<QuestCounters> {
  const [progressRows, notesCount, library] = await Promise.all([
    db.watchProgressEntry.findMany({
      where: { accountKey },
      select: { animeId: true, episode: true },
    }),
    db.viewerNote.count({ where: { accountKey } }),
    loadLibrary().catch(() => ({ ok: false as const, reason: 'Библиотека недоступна' })),
  ])

  const titles = progressRows.length
  const episodes = progressRows.reduce((sum, r) => sum + (r.episode ?? 0), 0)

  let ratings: number | null = null
  let favorites: number | null = null
  let completedStarted: number | null = null
  if (library.ok) {
    const ratedIds = new Set<number>()
    const favoriteIds = new Set<number>()
    const completedIds = new Set<number>()
    for (const list of library.snapshot.lists) {
      for (const item of list.items) {
        if (item.animeId === null) continue
        if (typeof item.ownRating === 'number' && item.ownRating >= 1) ratedIds.add(item.animeId)
        if (list.listId === 4 || item.isFavorite) favoriteIds.add(item.animeId)
        if (list.listId === 2) completedIds.add(item.animeId)
      }
    }
    ratings = ratedIds.size
    favorites = favoriteIds.size
    const startedIds = new Set(progressRows.map((r) => r.animeId))
    completedStarted = [...completedIds].filter((id) => startedIds.has(id)).length
  }

  return { titles, episodes, notes: notesCount, ratings, favorites, completedStarted }
}

// --- ответы -------------------------------------------------------------------------

export interface AchievementItem {
  id: string
  title: string
  description: string
  /** null — метрика зависит от библиотеки, которая сейчас недоступна */
  progress: number | null
  target: number
  done: boolean
}

export interface CustomQuestItem {
  id: string
  title: string
  metric: string
  /** null — метрика зависит от библиотеки, которая сейчас недоступна */
  progress: number | null
  target: number
  done: boolean
}

export interface QuestsResult {
  achievements: AchievementItem[]
  custom: CustomQuestItem[]
  available: boolean
  reason: string | null
}

export async function computeQuests(accountKey: string): Promise<QuestsResult> {
  const [counters, questRows] = await Promise.all([
    collectCounters(accountKey),
    db.userQuest
      .findMany({
        where: { accountKey, archived: false },
        orderBy: { createdAt: 'asc' },
        take: 100,
      })
      .catch(() => [] as UserQuestRow[]),
  ])

  const achievements: AchievementItem[] = ACHIEVEMENTS.map((a) => {
    const progress = computeProgressFromCounters(counters, a.metric)
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      progress,
      target: a.target,
      done: progress !== null && progress >= a.target,
    }
  })

  const custom: CustomQuestItem[] = questRows.map((q) => {
    const metric = (QUEST_METRICS as readonly string[]).includes(q.metric)
      ? (q.metric as QuestMetric)
      : null
    const progress = metric ? computeProgressFromCounters(counters, metric) : null
    return {
      id: q.id,
      title: q.title,
      metric: q.metric,
      progress,
      target: q.target,
      done: progress !== null && progress >= q.target,
    }
  })

  // Квесты работают всегда (локальные метрики); причина — только про недоступную библиотеку
  const libraryReason = libraryReasonOf(counters)
  return {
    achievements,
    custom,
    available: true,
    reason: libraryReason
      ? `${libraryReason} — прогресс по оценкам/любимым/завершённым сейчас не считается`
      : null,
  }
}

function libraryReasonOf(counters: QuestCounters): string | null {
  return counters.ratings === null && counters.favorites === null && counters.completedStarted === null
    ? 'Библиотека сайта недоступна'
    : null
}

// --- пользовательские цели -----------------------------------------------------------

export interface QuestInputValue {
  title: string
  metric: QuestMetric
  target: number
}

const QUEST_TITLE_MAX = 120
const QUEST_TARGET_MAX = 10000

/** Чистая валидация пользовательской цели (экспортирована для тестов) */
export function validateQuestInput(body: unknown): { ok: true; value: QuestInputValue } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Ожидался JSON-объект' }
  }
  const b = body as Record<string, unknown>

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (title.length < 1 || title.length > QUEST_TITLE_MAX) {
    return { ok: false, error: `Название цели обязательно (1..${QUEST_TITLE_MAX} символов)` }
  }

  if (typeof b.metric !== 'string' || !(QUEST_METRICS as readonly string[]).includes(b.metric)) {
    return { ok: false, error: `metric должен быть одним из: ${QUEST_METRICS.join(', ')}` }
  }

  const target = typeof b.target === 'number' ? b.target : typeof b.target === 'string' && b.target.trim() !== '' ? Number(b.target) : NaN
  if (!Number.isFinite(target) || !Number.isInteger(target) || target < 1 || target > QUEST_TARGET_MAX) {
    return { ok: false, error: `target должен быть целым числом 1..${QUEST_TARGET_MAX}` }
  }

  return { ok: true, value: { title, metric: b.metric as QuestMetric, target } }
}

/** Создать пользовательскую цель (значение должно пройти validateQuestInput) */
export async function createQuest(accountKey: string, value: QuestInputValue): Promise<UserQuestRow> {
  return db.userQuest.create({ data: { accountKey, title: value.title, metric: value.metric, target: value.target } })
}

/** Архивировать (мягкое удаление) свою цель; false — не найдена у этого аккаунта */
export async function archiveQuest(accountKey: string, id: string): Promise<boolean> {
  const res = await db.userQuest.updateMany({
    where: { id, accountKey },
    data: { archived: true },
  })
  return res.count > 0
}
