/**
 * Рекомендации — типы контракта (слой lib/recs ↔ /api/recs ↔ UI).
 *
 * Принципы (ТЗ «Рекомендации», секции 3–8):
 *  - источник истины — РЕАЛЬНЫЙ аккаунт YummyAnime (сайт), локальный трекинг —
 *    дополнительный сигнал; ничего не выдумываем;
 *  - жёсткие исключения применяются ДО ранжирования;
 *  - оценки пользователя и рейтинг сайта никогда не смешиваются;
 *  - движок чистый и детерминированный: одинаковые входы → одинаковый выход.
 */

import type { AnimeCard } from '@/lib/avc/types'

// --- пользовательский сигнал ---------------------------------------------------

/** Нормализованный статус тайтла (сайт: списки 0..5 + избранное + оценка) */
export type RecKnownStatus =
  | 'watching' // 0 Смотрю
  | 'planned' // 1 В Планах
  | 'completed' // 2 Просмотрено
  | 'dropped' // 3 Брошено
  | 'favorite' // 4 Любимые (флаг поверх списка)
  | 'on_hold' // 5 Отложено

/** Элемент профиля: что пользователь сделал с тайтлом на самом деле */
export interface RecProfileEntry {
  animeId: number
  slug: string
  title: string
  poster: string | null
  status: RecKnownStatus
  /** Своя оценка 1..10 (сайт, user.rating); null — оценки нет. Никогда не 0! */
  ownRating: number | null
  /** Рейтинг сайта (community) — хранится отдельно, в профиль-веса не входит */
  siteRating: number | null
  isFavorite: boolean
  /** Источник записи: сайт (сервер-авторитетен) или локальный трекинг просмотра */
  source: 'site' | 'local-progress'
  /** Локальный трекинг: последняя открытая серия (для сигнала силы) */
  episode?: number | null
}

// --- метаданные кандидата --------------------------------------------------------

/**
 * Кандидат: карточка + жанры/студии из деталей (детали тянутся батчами с кэшем;
 * отсутствие метаданных — НЕ сильный негатив, компоненты честно дают 0).
 */
export interface RecCandidate extends AnimeCard {
  genres: string[]
  studios: string[]
  /** Внешний MAL ID (remote_ids сайта) — для AniList-сопоставления */
  malId?: number | null
  /** Откуда кандидат: франшиза позитивного тайтла / каталог / AniList */
  origin: 'franchise' | 'catalog' | 'anilist'
  /** Если origin=franchise: связь с родителем (текст сайта) и id родителя */
  franchiseParent?: { animeId: number; title: string; relation: string | null; order: number }
}

// --- профиль предпочтений ----------------------------------------------------------

/** Позитивный/негативный «якорь» вкуса с весом силы сигнала 0..1 */
export interface RecAnchor {
  entry: RecProfileEntry
  /** Сила сигнала (0..1): оценка/статус → вес по документированной таблице */
  strength: number
  /** true — негативный якорь (брошено/низкая оценка) */
  negative: boolean
  genres: string[]
  studios: string[]
}

/** Производный профиль предпочтений (не ручной список!) */
export interface RecProfile {
  /** null — нет аккаунта: персонализация невозможна (честно сообщаем) */
  accountKey: string | null
  anchors: RecAnchor[]
  /** Суммарная позитивная сила профиля: < 1 → cold start (общая подборка) */
  positiveEvidence: number
  /** Веса жанров: Map<жанр, вес> — позитивные и негативные РАЗДЕЛЬНО */
  genreWeights: Map<string, number>
  negativeGenreWeights: Map<string, number>
  /** Веса студий (позитивные) */
  studioWeights: Map<string, number>
  /** ID тайтлов, которые уже известны (любой список/избранное/локальный трекинг) */
  knownIds: Set<number>
  /** Слаги известных — для дедупликации альтернативных записей */
  knownSlugs: Set<string>
  /** ID, жёстко исключённые (брошено/ниже порога) — приоритетнее похожести */
  hardExcludedIds: Set<number>
  /** Франшизы позитивных якорей: parentId → макс. карточек франшизы в выдаче */
  franchiseParents: Map<number, { title: string; strength: number }>
}

// --- настройки движка (прозрачные, документированные) ------------------------------

export interface RecEngineSettings {
  /** Порог: своя оценка ниже → тайтл жёстко исключён (по умолчанию 5 из 10) */
  ratingThreshold: number
  /** Исключать уже известные (в любом списке/истории) тайтлы из выдачи */
  excludeKnown: boolean
  /** MMR-переранжирование против «двадцати одинаковых шоу» */
  diversity: boolean
  /** Внешние кандидаты AniList (экспериментально; движок работает и без него) */
  useAnilist: boolean
}

export const DEFAULT_REC_SETTINGS: RecEngineSettings = {
  ratingThreshold: 5,
  excludeKnown: true,
  diversity: true,
  useAnilist: false,
}

// --- веса сигналов (ТЗ §6.3; документированы в RECOMMENDATIONS_ALGORITHM.md) -------

/** Таблица сил сигналов по статусам (позитивные якоря) */
export const STATUS_STRENGTH: Record<RecKnownStatus, number> = {
  watching: 0.5, // умеренный позитив
  planned: 0.35, // слабо-умеренный
  completed: 0.3, // слабый (без оценки)
  favorite: 0.7, // позитив
  dropped: 0, // НЕ позитив; жёсткое исключение тайтла
  on_hold: 0.2,
}

/** Множитель позитивной силы от своей оценки (оценка >= threshold; шкала 1..10) */
export function ratingStrength(rating: number, threshold: number): number {
  // 10 → 1.0 (сильный), 7 → 0.65, threshold(5) → 0.15 (почти нейтрально)
  const lo = Math.max(1, Math.min(10, threshold))
  return Math.max(0.15, Math.min(1, (rating - lo + 1) / (11 - lo)))
}

// --- результат ---------------------------------------------------------------------

/** Одна рекомендация с объяснением (ТЗ §8: причина обязана следовать из данных) */
export interface RecCard {
  card: AnimeCard
  /** Компоненты 0..1 — держим раздельно для объяснимости */
  components: {
    similarity: number
    affinity: number
    franchise: number
    quality: number
  }
  /** Итог 0..100 */
  score: number
  /** Причины (макс. 2, только из реальных данных) */
  reasons: string[]
  /** true — попал в холодный старт (общая подборка, НЕ персональная) */
  discovery?: boolean
}

/** Полный ответ движка */
export interface RecResult {
  /** personalized | discovery | logged-out */
  mode: 'personalized' | 'discovery' | 'logged-out'
  items: RecCard[]
  /** Диагностика для UI (без секретов) */
  profileSummary: {
    anchors: number
    positiveAnchors: number
    negativeAnchors: number
    knownTitles: number
    candidates: number
    excludedKnown: number
    excludedDropped: number
    excludedLowRated: number
    excludedFeedback: number
    duplicatesRemoved: number
    topGenres: string[]
  }
  /** Сообщение для UI (холодный старт, гостевой режим) */
  message: string | null
}
