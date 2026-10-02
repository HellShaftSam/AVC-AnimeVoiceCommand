/**
 * Anime Voice Controller — клиент API (thin client).
 *
 * АУТЕНТИФИКАЦИЯ (спецификация «Production-Ready YummyAnime Authentication»):
 *   Сессия сайта живёт ТОЛЬКО в постоянном браузерном профиле Electron
 *   (partition 'persist:yummyanime') и не покидает главный процесс:
 *     - EXE: снимки аккаунта/избранного приходят через IPC-мост
 *       window.avcElectron (НЕ-секретные данные — секция 15);
 *     - Web (браузер без оболочки): честные «недоступно» ответы без выдумок.
 *   Cookie/пароли/токены через этот слой НЕ передаются никогда.
 *
 * Публичные данные сайта (поиск/каталог/детали) идут через Next API как раньше.
 */
import type {
  VoiceAliasRow,
  YummyAccountSnapshot,
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
  message:
    'Постоянная сессия YummyAnime живёт в EXE-сборке. В веб-режиме состояние аккаунта недоступно.',
}

export const avcApi = {
  /**
   * Состояние аккаунта YummyAnime (Electron-first).
   * refresh=true — принудительная проверка на сайте (минуя кеш сервиса).
   */
  async yummyAccount(refresh = false): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getAccountState(refresh)
    return WEB_UNAVAILABLE
  },

  /** Открыть окно входа на реальный сайт (только EXE). Резолв после закрытия окна. */
  async openLoginWindow(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (!bridge) {
      return {
        ...WEB_UNAVAILABLE,
        message: 'Вход выполняется в окне сайта — доступно в EXE-сборке.',
      }
    }
    return bridge.openLoginWindow()
  },

  /** Полная проверка аутентификации через сайт (verifyAuthentication) */
  async verifyAuthentication(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.verifyAuthentication()
    return WEB_UNAVAILABLE
  },

  /** Выход ЧЕРЕЗ САЙТ (сайт инвалидирует сессию), затем локальное подтверждение */
  async yummyLogout(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.logout()
    return {
      ...WEB_UNAVAILABLE,
      state: 'loggedOut',
      message: 'Веб-режим: аккаунт YummyAnime не подключён.',
    }
  },

  /**
   * Избранное с сайта. EXE — через IPC (данные сессии main-процесса);
   * web — честная недоступность (available=false с причиной).
   */
  async yummyFavorites(refresh = false): Promise<YummyFavoritesResult> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getFavorites(refresh)
    return {
      available: false,
      items: [],
      reason: 'Избранное живёт в постоянной сессии сайта — доступно в EXE-сборке',
      lastSync: null,
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
