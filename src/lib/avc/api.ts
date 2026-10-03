/**
 * Anime Voice Controller — клиент API (thin client).
 *
 * АУТЕНТИФИКАЦИЯ (спецификация «Production-Ready YummyAnime Authentication»):
 *   - EXE: сессия сайта живёт в постоянном браузерном профиле Electron
 *     (partition 'persist:yummyanime') и не покидает главный процесс;
 *     снимки аккаунта/избранного приходят через IPC-мост window.avcElectron
 *     (НЕ-секретные данные — секция 15).
 *   - Web (превью в браузере, БЕЗ оболочки): вход выполняется формой
 *     логин+пароль, сервер Next.js отправляет их напрямую на сервер сайта
 *     (POST /api/profile/login), хранит cookie-сессию ТОЛЬКО на сервере
 *     (db/yummy-session.json, 0600, вне git) и выполняет все действия
 *     аккаунта с ней. Пароль нигде не хранится; клиенту отдаются только
 *     НЕ-секретные снимки.
 * Cookie/пароли/токены через ЭТОТ слой не передаются никогда.
 *
 * Публичные данные сайта (поиск/каталог/детали) идут через Next API как раньше.
 */
import type {
  VoiceAliasRow,
  YummyAccountSnapshot,
  YummyAnimeActionRequest,
  YummyAnimeActionResponse,
  YummyAuthSelfTestReport,
  YummyFavoritesResult,
} from './types'

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

// --- IPC-мост Electron (создаётся preload'ом оболочки) -----------------------

/** Контракт preload-моста EXE-сборки. Все методы возвращают НЕ-секретные данные. */
export interface AvcElectronBridge {
  platform: 'electron'
  getAccountState(refresh?: boolean): Promise<YummyAccountSnapshot>
  openLoginWindow(): Promise<YummyAccountSnapshot>
  verifyAuthentication(): Promise<YummyAccountSnapshot>
  logout(): Promise<YummyAccountSnapshot>
  getFavorites(refresh?: boolean): Promise<YummyFavoritesResult>
  resetYummySession(): Promise<{ ok: boolean; backupPath: string | null; message: string }>
  runAuthSelfTest(): Promise<YummyAuthSelfTestReport>
  /** РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное) */
  animeAction(req: YummyAnimeActionRequest): Promise<YummyAnimeActionResponse>
  onAccountChanged(cb: (snap: YummyAccountSnapshot) => void): () => void
  /** Статусы входа из main-процесса (капча/ошибка/успех) для toast */
  onAuthStatus?(cb: (msg: string) => void): () => void
}

/** Есть ли мост EXE-сборки (в обычном браузере отсутствует) */
export function getElectronBridge(): AvcElectronBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { avcElectron?: AvcElectronBridge }).avcElectron
  return bridge && bridge.platform === 'electron' ? bridge : null
}

const WEB_UNAVAILABLE: YummyAccountSnapshot = {
  state: 'unavailable',
  user: null,
  lastSync: null,
  source: 'no-session',
  message: 'Постоянная сессия YummyAnime живёт в EXE-сборке.',
}

const WEB_LOGIN_HINT =
  'Войдите в аккаунт YummyAnime — списки, оценки и избранное хранятся в вашем аккаунте на сайте'

/** Ответ POST /api/yummy/login */
export interface WebLoginResult {
  ok: boolean
  snapshot?: YummyAccountSnapshot
  message?: string
  captchaRequired?: boolean
}

export const avcApi = {
  /**
   * Состояние аккаунта YummyAnime.
   * EXE — через IPC (сессия в main-процессе);
   * Web — живая проверка серверной сессии сайта (GET /api/yummy/account).
   */
  async yummyAccount(refresh = false): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getAccountState(refresh)
    try {
      const res = await jsonFetch('/api/yummy/account')
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as YummyAccountSnapshot
    } catch {
      return {
        state: 'unavailable',
        user: null,
        lastSync: null,
        source: 'error',
        message: 'Не удалось проверить аккаунт — сервер недоступен',
      }
    }
  },

  /**
   * Вход в аккаунт YummyAnime логином и паролем (режим превью, без EXE).
   * Пароль отправляется сервером приложения напрямую на сервер сайта и
   * нигде не хранится. EXE использует окно сайта (openLoginWindow).
   */
  async yummyLogin(login: string, password: string): Promise<WebLoginResult> {
    try {
      const res = await jsonFetch('/api/yummy/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      })
      const body = (await res.json()) as WebLoginResult
      return body
    } catch {
      return { ok: false, message: 'Сервер недоступен — попробуйте позже' }
    }
  },

  /** Открыть окно входа на реальный сайт (только EXE). Резолв после закрытия окна. */
  async openLoginWindow(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (!bridge) {
      return {
        ...WEB_UNAVAILABLE,
        message: 'В веб-режиме входите формой ниже — пароль уйдёт прямо на сервер сайта.',
      }
    }
    return bridge.openLoginWindow()
  },

  /** Полная проверка аутентификации через сайт (verifyAuthentication) */
  async verifyAuthentication(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.verifyAuthentication()
    return avcApi.yummyAccount(true)
  },

  /** Выход ЧЕРЕЗ САЙТ (сайт инвалидирует сессию), затем локальное подтверждение */
  async yummyLogout(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.logout()
    try {
      const res = await jsonFetch('/api/yummy/login', { method: 'DELETE' })
      if (!res.ok) throw new Error(await readError(res))
      const body = (await res.json()) as { snapshot?: YummyAccountSnapshot }
      return body.snapshot ?? { state: 'loggedOut', user: null, lastSync: null, source: 'live', message: null }
    } catch {
      return { state: 'loggedOut', user: null, lastSync: null, source: 'error', message: 'Выход выполнен локально' }
    }
  },

  /**
   * Избранное с сайта. EXE — через IPC (данные сессии main-процесса);
   * web — через серверную сессию сайта (GET /api/yummy/favorites).
   */
  async yummyFavorites(refresh = false): Promise<YummyFavoritesResult> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getFavorites(refresh)
    try {
      const res = await jsonFetch('/api/yummy/favorites')
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as YummyFavoritesResult
    } catch {
      return {
        available: false,
        items: [],
        reason: WEB_LOGIN_HINT,
        lastSync: null,
      }
    }
  },

  /**
   * РЕАЛЬНОЕ действие аккаунта YummyAnime (список/оценка/избранное).
   * EXE — same-origin внутри постоянной сессии сайта (main-процесс);
   * web — POST /api/yummy/action (серверная сессия сайта) с верификацией
   * чтением серверного HTML страницы тайтла.
   */
  async animeAction(req: YummyAnimeActionRequest): Promise<YummyAnimeActionResponse> {
    const bridge = getElectronBridge()
    if (bridge?.animeAction) return bridge.animeAction(req)
    try {
      const res = await jsonFetch('/api/yummy/action', {
        method: 'POST',
        body: JSON.stringify(req),
      })
      const body = (await res.json()) as YummyAnimeActionResponse
      return body
    } catch {
      return {
        ok: false,
        httpStatus: 0,
        verification: 'unconfirmed',
        state: null,
        message: 'Сервер недоступен — действие не выполнено',
      }
    }
  },

  /** Диагностический selftest аутентификации (только EXE; web → null) */
  async authSelfTest(): Promise<YummyAuthSelfTestReport | null> {
    const bridge = getElectronBridge()
    if (!bridge) return null
    return bridge.runAuthSelfTest()
  },

  /** Сброс постоянной сессии сайта (backup + явное подтверждение в UI, секция 22) */
  async resetYummySession(): Promise<{ ok: boolean; backupPath: string | null; message: string } | null> {
    const bridge = getElectronBridge()
    if (!bridge) return null
    return bridge.resetYummySession()
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
