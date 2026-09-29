/**
 * Anime Voice Controller — клиент API аккаунтов/библиотеки/алиасов (Task 9-a).
 *
 * Чистый транспорт: только fetch + JSON + cookie-сессия (same-origin).
 * Никакого знания о store: после login/register/logout вызывающая сторона сама
 * обновляет состояние (page.tsx / AuthDialog).
 *
 * Правила ошибок:
 *   - ошибки сервера → throw Error(сообщение от сервера из {error});
 *   - ИСКЛЮЧЕНИЯ: putLibrary/addAlias возвращают null при 401 (не залогинен) —
 *     это ожидаемый сценарий, а не ошибка.
 */
import type { LibraryEntryDto, UserInfoDto, VoiceAliasRow, WatchStatus } from './types'

/** Тело PUT /api/library — все поля кроме animeId/title опциональны (partial update) */
export interface PutLibraryPayload {
  animeId: number
  title: string
  slug?: string | null
  poster?: string | null
  status?: WatchStatus
  favorite?: boolean
  episode?: number | null
  positionSec?: number | null
  totalEpisodes?: number | null
  currentDub?: string | null
}

/** Достать сообщение об ошибке из ответа сервера ({error} или статус) */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body && typeof body.error === 'string' && body.error.trim() !== '') {
      return body.error
    }
  } catch {
    // не JSON — используем статус
  }
  return `Ошибка сервера (${res.status})`
}

async function jsonFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
}

export const avcApi = {
  /** Текущий пользователь (null — не залогинен). Сетевые ошибки пробрасываются. */
  async me(): Promise<UserInfoDto | null> {
    const res = await jsonFetch('/api/auth/me')
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { user: UserInfoDto | null }
    return body.user ?? null
  },

  /** Вход. 401 → «Неверный логин или пароль». */
  async login(username: string, password: string): Promise<UserInfoDto> {
    const res = await jsonFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'Неверный логин или пароль' : await readError(res))
    }
    const body = (await res.json()) as { user: UserInfoDto }
    return body.user
  },

  /** Регистрация (409 «Имя уже занято» и прочие ошибки — throw). */
  async register(username: string, password: string): Promise<UserInfoDto> {
    const res = await jsonFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { user: UserInfoDto }
    return body.user
  },

  /** Выход (cookie очищается на сервере). */
  async logout(): Promise<void> {
    const res = await jsonFetch('/api/auth/logout', { method: 'POST' })
    if (!res.ok) throw new Error(await readError(res))
  },

  /** Библиотека пользователя (без сессии — пустой список). */
  async library(): Promise<LibraryEntryDto[]> {
    const res = await jsonFetch('/api/library')
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { entries?: LibraryEntryDto[] }
    return body.entries ?? []
  },

  /**
   * Создать/обновить запись библиотеки (upsert по (userId, animeId)).
   * 401 → null (не залогинен) — НЕ throw. Остальные ошибки — throw.
   */
  async putLibrary(p: PutLibraryPayload): Promise<LibraryEntryDto | null> {
    const res = await jsonFetch('/api/library', { method: 'PUT', body: JSON.stringify(p) })
    if (res.status === 401) return null
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { entry: LibraryEntryDto }
    return body.entry
  },

  /** Удалить запись библиотеки. true — удалено/отсутствовало, false — 401/ошибка. */
  async deleteLibraryEntry(animeId: number): Promise<boolean> {
    try {
      const res = await jsonFetch(`/api/library?animeId=${encodeURIComponent(String(animeId))}`, {
        method: 'DELETE',
      })
      return res.ok
    } catch {
      return false
    }
  },

  /** Пользовательские алиасы озвучек (без сессии — []). */
  async aliases(): Promise<VoiceAliasRow[]> {
    const res = await jsonFetch('/api/aliases')
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { aliases?: VoiceAliasRow[] }
    return body.aliases ?? []
  },

  /** Добавить алиас озвучки. 401 → null (не залогинен) — НЕ throw. */
  async addAlias(
    targetName: string,
    alias: string,
    targetType: string = 'voice',
  ): Promise<VoiceAliasRow | null> {
    const res = await jsonFetch('/api/aliases', {
      method: 'POST',
      body: JSON.stringify({ targetType, targetName, alias }),
    })
    if (res.status === 401) return null
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { alias: VoiceAliasRow }
    return body.alias
  },

  /** Удалить алиас по id. */
  async deleteAlias(id: string): Promise<boolean> {
    try {
      const res = await jsonFetch(`/api/aliases?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      return res.ok
    } catch {
      return false
    }
  },
}
