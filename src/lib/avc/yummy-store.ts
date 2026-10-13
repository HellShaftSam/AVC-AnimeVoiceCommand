/**
 * YummyStore (Task 17) — клиентское состояние РЕАЛЬНОГО аккаунта YummyAnime.
 *
 * Remote-first (спека #10): сервер /api/yummy/* синхронизируется с сайтом,
 * store держит только UI-снимок (профиль, списки, статусы синхронизации).
 *
 * Триггеры синхронизации (спека #13, БЕЗ агрессивного поллинга #12):
 *   - startupAuthCheck(): запуск приложения (один раз, прогрессивно —
 *     кэш сразу, обновление асинхронно);
 *   - openBookmarks(): открытие панели закладок (TTL 2 мин на сервере);
 *   - manualRefresh(): кнопка «Синхронизировать» (force, спека #41);
 *   - logout(): выход.
 * Клиентский debounce 700 мс (#16): серия событий схлопывается в один fetch.
 */
import { create } from 'zustand'

export type YummyClientState =
  | 'unknown'
  | 'checking'
  | 'logged_out'
  | 'logged_in'
  | 'session_expired'

export interface YummyProfileDto {
  id: number
  nickname: string
  avatarUrl: string | null
  profileUrl: string
}

export interface YummyListItemDto {
  animeId: number
  animeUrl: string
  title: string
  poster: string | null
  listId: number
  year: number | null
  rating: number | null
  siteDate: number | null
}

interface AuthResponse {
  state: YummyClientState
  authenticated: boolean
  profile: YummyProfileDto | null
  fromCache: boolean
  stale: boolean
  changed: boolean
  error: string | null
  lastSync: number | null
}

interface ListsResponse {
  ok: boolean
  authenticated: boolean
  items: YummyListItemDto[]
  fromCache: boolean
  stale: boolean
  changed: boolean
  error: string | null
  lastSync: number | null
}

export interface YummyState {
  authState: YummyClientState
  checking: boolean
  profile: YummyProfileDto | null
  lists: YummyListItemDto[]
  listsStale: boolean
  listsSyncing: boolean
  listsError: string | null
  /** epoch ms последней успешной синхронизации списков (для UI «обновлено HH:MM») */
  listsLastSync: number | null
  /** уведомление о конце сессии (спека #27) — одноразовый флаг */
  sessionExpiredNotice: boolean
  startupDone: boolean

  syncAuth: (force?: boolean) => Promise<void>
  startupAuthCheck: () => Promise<void>
  openBookmarks: () => Promise<void>
  manualRefresh: () => Promise<void>
  login: (login: string, password: string) => Promise<{ ok: boolean; error?: string; captchaRequired?: boolean }>
  logout: () => Promise<void>
  clearExpiredNotice: () => void
}

// --- клиентский debounce (#16) -----------------------------------------------------

let authTimer: ReturnType<typeof setTimeout> | null = null
let listsTimer: ReturnType<typeof setTimeout> | null = null

function debounced(fn: () => void, ms: number, timer: 'auth' | 'lists') {
  const clear = timer === 'auth' ? () => (authTimer = null) : () => (listsTimer = null)
  const get = timer === 'auth' ? authTimer : listsTimer
  if (get) clearTimeout(get)
  const t = setTimeout(() => {
    clear()
    fn()
  }, ms)
  if (timer === 'auth') authTimer = t
  else listsTimer = t
}

const DEBOUNCE_MS = 700

export const useYummyStore = create<YummyState>()((set, get) => ({
  authState: 'unknown',
  checking: false,
  profile: null,
  lists: [],
  listsStale: false,
  listsSyncing: false,
  listsError: null,
  listsLastSync: null,
  sessionExpiredNotice: false,
  startupDone: false,

  /** Проверка авторизации (TTL 5 мин на сервере, дедуп на клиенте) */
  syncAuth: async (force = false) => {
    if (get().checking && !force) return
    set({ checking: true })
    try {
      const res = await fetch(`/api/yummy/auth${force ? '?force=1' : ''}`, {
        credentials: 'same-origin',
      })
      const body = (await res.json()) as AuthResponse
      const expiredNow = get().authState === 'logged_in' && body.state === 'session_expired'
      set((s) => ({
        authState: body.state,
        profile: body.profile ?? (body.authenticated ? s.profile : null),
        checking: false,
        // Переход logged_in → session_expired: одноразовое уведомление (#27)
        sessionExpiredNotice: expiredNow,
      }))
      if (expiredNow) {
        // Спека #27: «Сессия YummyAnime истекла. Войдите снова.»
        const { toast } = await import('@/hooks/use-toast')
        toast({
          description: 'Сессия YummyAnime истекла. Войдите снова.',
        })
      }
      if (body.state === 'logged_in' && (body.changed || !body.fromCache || get().lists.length === 0)) {
        // после подтверждения сессии подтягиваем закладки (точечно, не всё подряд)
        void get().openBookmarks()
      }
    } catch {
      // Офлайн: остаёмся в текущем состоянии, не крэшимся (#25)
      set({ checking: false, listsStale: true })
    }
  },

  /** Trigger A: запуск приложения — одна проверка, UI не блокируем */
  startupAuthCheck: async () => {
    if (get().startupDone) return
    set({ startupDone: true })
    debounced(() => void get().syncAuth(false), 300, 'auth')
  },

  /** Trigger D: пользователь открыл закладки (TTL 2 мин на сервере) */
  openBookmarks: async () => {
    const st = get()
    if (st.authState !== 'logged_in' || st.listsSyncing) return
    set({ listsSyncing: true })
    try {
      const res = await fetch('/api/yummy/lists', { credentials: 'same-origin' })
      const body = (await res.json()) as ListsResponse
      const expiredNow = get().authState === 'logged_in' && body.error === 'session_expired'
      set((s) => ({
        lists: body.items.length > 0 || body.ok ? body.items : s.lists,
        listsStale: body.stale,
        listsSyncing: false,
        listsError: body.error,
        listsLastSync: body.lastSync ?? s.listsLastSync,
        sessionExpiredNotice: expiredNow,
        authState: body.error === 'session_expired' ? 'session_expired' : s.authState,
      }))
      if (expiredNow) {
        const { toast } = await import('@/hooks/use-toast')
        toast({ description: 'Сессия YummyAnime истекла. Войдите снова.' })
      }
    } catch {
      set((s) => ({ listsSyncing: false, listsStale: true, listsError: 'Нет сети' }))
    }
  },

  /** Ручной refresh: обход TTL (спека #41), с клиентским debounce */
  manualRefresh: async () => {
    debounced(() => {
      void (async () => {
        set({ listsSyncing: true, checking: true })
        try {
          const [authRes, listsRes] = await Promise.all([
            fetch('/api/yummy/auth?force=1', { credentials: 'same-origin' }),
            fetch('/api/yummy/lists?force=1', { credentials: 'same-origin' }),
          ])
          const auth = (await authRes.json()) as AuthResponse
          const lists = (await listsRes.json()) as ListsResponse
          set((s) => ({
            authState: auth.state,
            profile: auth.profile ?? (auth.authenticated ? s.profile : null),
            checking: false,
            lists: lists.ok ? lists.items : s.lists,
            listsStale: lists.stale,
            listsSyncing: false,
            listsError: lists.error,
            listsLastSync: lists.lastSync ?? s.listsLastSync,
            sessionExpiredNotice:
              s.authState === 'logged_in' && auth.state === 'session_expired',
          }))
        } catch {
          set((s) => ({ checking: false, listsSyncing: false, listsStale: true }))
        }
      })()
    }, DEBOUNCE_MS, 'lists')
  },

  /** Вход: {login, password} → сервер пересылает один раз на сайт */
  login: async (login: string, password: string) => {
    try {
      const res = await fetch('/api/yummy/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      })
      const body = (await res.json()) as {
        ok: boolean
        profile?: YummyProfileDto
        error?: string
        captchaRequired?: boolean
      }
      if (!res.ok || !body.ok) {
        return {
          ok: false,
          error: body.error ?? 'Не удалось войти',
          captchaRequired: body.captchaRequired,
        }
      }
      set({
        authState: 'logged_in',
        profile: body.profile ?? null,
        sessionExpiredNotice: false,
        lists: [],
        listsError: null,
        listsStale: false,
      })
      // Trigger B: логин → полная синхронизация аккаунта
      void get().openBookmarks()
      return { ok: true }
    } catch {
      return { ok: false, error: 'Сервер приложения недоступен' }
    }
  },

  /** Выход: штатный logout сайта + очистка UI-состояния */
  logout: async () => {
    try {
      await fetch('/api/yummy/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      // даже при сбое сети очищаем локальное состояние — сессия на сервере удалится
    }
    set({
      authState: 'logged_out',
      profile: null,
      lists: [],
      listsStale: false,
      listsSyncing: false,
      listsError: null,
      listsLastSync: null,
      sessionExpiredNotice: false,
    })
  },

  clearExpiredNotice: () => set({ sessionExpiredNotice: false }),
}))

/** Форматирование «последняя синхронизация» для UI (спека #25) */
export function formatLastSync(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}
