/**
 * Anime Companion — серверное чтение библиотеки сайта (6 списков) с TTL-кэшем.
 *
 * Тот же путь, что у рекомендаций и /api/yummy/library (сервер-авторитетно):
 *   loadWebSession → fetchProfile → числовой userId → fetchUserList × 6 (порядок 0,1,2,3,5,4).
 * TTL 60 с (как libCache у /api/recs) — без фонового поллинга, обновление по факту запроса.
 * Любая ошибка → { ok:false, reason } — честная причина, ничего не выдумываем.
 */
import {
  fetchProfile,
  fetchUserList,
  parseLibraryItems,
  parseProfile,
} from '@/lib/sites/yummy/web-auth'
import { loadWebSession } from '@/lib/sites/yummy/web-session'
import {
  YUMMY_LIST_NAMES,
  type YummyLibraryList,
  type YummyListId,
} from '@/lib/avc/types'

export interface LibrarySnapshot {
  /** Числовой userId сайта (владелец библиотеки) */
  accountKey: string
  lists: YummyLibraryList[]
  /** ISO-время последнего успешного чтения (участвует в ключе кэша карты вкусов) */
  lastSync: string
}

export type LibraryResult =
  | { ok: true; snapshot: LibrarySnapshot }
  | { ok: false; reason: string }

const LIB_TTL = 60 * 1000
let cache: { snapshot: LibrarySnapshot; at: number } | null = null

/** Инвалидировать кэш библиотеки (логаут/смена аккаунта — по образцу recs) */
export function clearCompanionLibraryCache(): void {
  cache = null
}

/** Прочитать библиотеку (кэш 60 с). Сайт/сессия недоступны → честная причина. */
export async function loadLibrary(): Promise<LibraryResult> {
  if (cache && cache.at + LIB_TTL > Date.now()) {
    return { ok: true, snapshot: cache.snapshot }
  }

  const session = await loadWebSession()
  if (!session) {
    return {
      ok: false,
      reason:
        'Войдите в аккаунт YummyAnime — библиотека (Смотрю, Любимые, оценки) хранится в вашем аккаунте на сайте',
    }
  }

  const profile = await fetchProfile(session.cookie)
  if (profile.status === 401 || profile.status === 403) {
    cache = null
    return { ok: false, reason: 'Сессия YummyAnime истекла — войдите заново' }
  }
  if (profile.status !== 200) {
    return {
      ok: false,
      reason:
        profile.status === 0
          ? 'Сайт YummyAnime недоступен — попробуйте позже'
          : `Сайт ответил ошибкой (HTTP ${profile.status}) — попробуйте позже`,
    }
  }
  const numericId = parseProfile(profile.body)?.userId?.match(/^(\d+)$/)?.[1] ?? null
  if (!numericId) {
    return { ok: false, reason: 'Не удалось определить id пользователя для чтения библиотеки' }
  }

  const order: YummyListId[] = [0, 1, 2, 3, 5, 4] // Любимые последними, как на сайте
  const settled = await Promise.all(
    order.map(async (listId) => ({
      listId,
      ...(await fetchUserList(session.cookie, numericId, listId)),
    })),
  )

  const lists: YummyLibraryList[] = []
  for (const s of settled) {
    if (s.status === 200) {
      const items = parseLibraryItems(s.body)
      lists.push({ listId: s.listId, name: YUMMY_LIST_NAMES[s.listId], count: items.length, items })
    }
  }
  if (lists.length === 0) {
    return { ok: false, reason: 'Ни один список библиотеки не прочитан' }
  }

  const snapshot: LibrarySnapshot = { accountKey: numericId, lists, lastSync: new Date().toISOString() }
  cache = { snapshot, at: Date.now() }
  return { ok: true, snapshot }
}
