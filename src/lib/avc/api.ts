/**
 * Anime Voice Controller — клиент API (thin client).
 *
 * Аккаунт: РЕАЛЬНАЯ сессия YummyAnime (сайт — источник истины). Локального
 * аккаунта и локальной библиотеки больше нет — есть только:
 *   /api/yummy/account    — состояние аккаунта (профиль с сайта)
 *   /api/yummy/session    — мост cookie-сессии из Electron-webview / выход
 *   /api/yummy/favorites  — избранное с сайта
 *   /api/aliases          — глобальные алиасы озвучек
 *
 * Правила ошибок: ошибки сервера → throw Error({error}); сетевые сбои аккаунта
 * не бросаются — приходят как snapshot с state='unavailable' (offline behavior).
 */
import type { VoiceAliasRow, YummyAccountSnapshot, YummyFavoritesResult } from './types'

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
  /**
   * Состояние аккаунта YummyAnime. refresh=true — принудительная проверка,
   * минуя TTL-кэш (кнопки «Проверить», возврат с сайта после входа).
   */
  async yummyAccount(refresh = false): Promise<YummyAccountSnapshot> {
    const res = await jsonFetch(`/api/yummy/account${refresh ? '?refresh=1' : ''}`)
    if (!res.ok) throw new Error(await readError(res))
    return (await res.json()) as YummyAccountSnapshot
  },

  /**
   * Мост сессии: передать cookie yummyani.me серверному адаптеру
   * (в Electron это делает главный процесс из persistent-профиля webview).
   * Возвращает снимок аккаунта сразу после сохранения — сайт проверяет сессию.
   */
  async syncYummySession(cookie: string): Promise<YummyAccountSnapshot> {
    const res = await jsonFetch('/api/yummy/session', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    })
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { account: YummyAccountSnapshot }
    return body.account
  },

  /** Выход: сайт уведомляется (best-effort), локальная сессия стирается */
  async yummyLogout(): Promise<void> {
    const res = await jsonFetch('/api/yummy/session', { method: 'DELETE' })
    if (!res.ok) throw new Error(await readError(res))
  },

  /** Избранное с сайта (available=false — честная причина, а не выдуманные данные) */
  async yummyFavorites(refresh = false): Promise<YummyFavoritesResult> {
    const res = await jsonFetch(`/api/yummy/favorites${refresh ? '?refresh=1' : ''}`)
    if (!res.ok) throw new Error(await readError(res))
    return (await res.json()) as YummyFavoritesResult
  },

  /** Пользовательские алиасы озвучек (глобальные) */
  async aliases(): Promise<VoiceAliasRow[]> {
    const res = await jsonFetch('/api/aliases')
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { aliases?: VoiceAliasRow[] }
    return body.aliases ?? []
  },

  /** Добавить алиас озвучки. */
  async addAlias(
    targetName: string,
    alias: string,
    targetType: string = 'voice',
  ): Promise<VoiceAliasRow> {
    const res = await jsonFetch('/api/aliases', {
      method: 'POST',
      body: JSON.stringify({ targetType, targetName, alias }),
    })
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
