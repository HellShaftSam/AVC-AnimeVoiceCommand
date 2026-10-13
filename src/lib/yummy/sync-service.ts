/**
 * YummyAnimeSyncService (Task 17, спека #11-#23, #39-#42) — серверная
 * синхронизация с РЕАЛЬНЫМ сайтом при помошщи YummyAccountAdapter.
 *
 * Принципы (строго):
 *  - Remote-first: сайт — источник истины, SQLite — только UI-кэш (#10);
 *  - БЕЗ агрессивного поллинга (#12): синхронизация только по явным
 *    триггерам (запуск, логин, открытие закладок, ручной refresh);
 *  - TTL-кэш (#14): profile 5 мин, avatar 30 мин, lists 2 мин;
 *  - Дедупликация одновременных запросов (#16-#17): одинаковый ресурс
 *    синхронизируется в один полёт (in-flight collapse);
 *  - Content-hash (#23): если hash не изменился — кэш не трогаем, UI не дёргаем;
 *  - Backoff (#26): 5с → 15с → 30с → 60с → 5мин (макс);
 *  - Offline (#25): сетевые ошибки НЕ стирают кэш;
 *  - Метрики (#39): длительности, requests/min, cache hits — для диагностики;
 *  - Request budget (#40): обычный refresh не чаще 1 раза за TTL;
 *    force (ручной/логин) обходит TTL, но тоже дедуплицируется.
 *
 * Безопасность: cookie сессии хранится ТОЛЬКО в таблице YummySession
 * (транспорт для серверных запросов), никогда не возвращается клиенту и
 * не пишется в логи (спека #30, #37).
 */
import { createHmac } from 'crypto'
import { db } from '@/lib/db'
import {
  YummyAccountAdapter,
  YummyAuthState,
  YummyProfileSnapshot,
  YummyRemoteListItem,
} from './account-adapter'
import { ensureJar, readJarId } from './jar'

// --- TTL (спека #14, настраиваемые дефолты) -------------------------------------

const TTL_MS = {
  profile: 5 * 60 * 1000, // аккаунт/профиль: 5 минут
  avatar: 30 * 60 * 1000, // аватар: 30 минут
  lists: 2 * 60 * 1000, // закладки: 2 минуты
} as const

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 5 * 60_000] // спека #26

export type YummyResource = 'profile' | 'lists'

export interface YummySyncOutcome<T> {
  ok: boolean
  fromCache: boolean
  stale: boolean // true = отдали кэш, т.к. сеть/сайт недоступны (#25)
  data: T | null
  error: string | null
  lastSync: number | null // epoch ms
  durationMs: number | null
  changed: boolean // hash отличался — UI можно обновить (#23-#24)
}

// --- in-flight дедупликация (#16-#17) ---------------------------------------------

const inFlight = new Map<string, Promise<unknown>>()

function collapse<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>
  const p = run().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

interface SessionRow {
  id: string
  cookieName: string
  cookieValue: string
  yummyUserId: number | null
  yummyNickname: string | null
  avatarUrl: string | null
  authState: string
}

async function loadSession(jarId: string): Promise<SessionRow | null> {
  const row = await db.yummySession.findUnique({ where: { id: jarId } })
  if (!row) return null
  return {
    id: row.id,
    cookieName: row.cookieName,
    cookieValue: row.cookieValue,
    yummyUserId: row.yummyUserId,
    yummyNickname: row.yummyNickname,
    avatarUrl: row.avatarUrl,
    authState: row.authState,
  }
}

function sessionCookieHeader(row: SessionRow | null): string | null {
  // cookieValue хранит ПОЛНЫЙ заголовок Cookie (name=value; name2=value2) —
  // сессия сайта может состоять из нескольких cookie (см. account-adapter)
  if (!row || !row.cookieValue) return null
  return row.cookieValue.includes('=') ? row.cookieValue : null
}

// --- sync meta (TTL/hash/backoff/метрики) ------------------------------------------

interface SyncMeta {
  lastSync: number | null
  contentHash: string | null
  failCount: number
  lastError: string | null
  requests: number
  cacheHits: number
  lastDurationMs: number | null
}

const metaCache = new Map<string, SyncMeta>()

async function loadMeta(jarId: string, resource: YummyResource): Promise<SyncMeta> {
  const key = `${jarId}:${resource}`
  const cached = metaCache.get(key)
  if (cached) return cached
  const row = await db.yummySyncMeta.findUnique({ where: { id: key } })
  const meta: SyncMeta = {
    lastSync: row?.lastSync ? row.lastSync.getTime() : null,
    contentHash: row?.contentHash ?? null,
    failCount: row?.failCount ?? 0,
    lastError: row?.lastError ?? null,
    requests: row?.requests ?? 0,
    cacheHits: row?.cacheHits ?? 0,
    lastDurationMs: row?.lastDuration ?? null,
  }
  metaCache.set(key, meta)
  return meta
}

async function saveMeta(jarId: string, resource: YummyResource, meta: SyncMeta): Promise<void> {
  const key = `${jarId}:${resource}`
  metaCache.set(key, meta)
  await db.yummySyncMeta.upsert({
    where: { id: key },
    create: {
      id: key,
      lastSync: meta.lastSync ? new Date(meta.lastSync) : null,
      contentHash: meta.contentHash,
      failCount: meta.failCount,
      lastError: meta.lastError,
      requests: meta.requests,
      cacheHits: meta.cacheHits,
      lastDuration: meta.lastDurationMs,
    },
    update: {
      lastSync: meta.lastSync ? new Date(meta.lastSync) : null,
      contentHash: meta.contentHash,
      failCount: meta.failCount,
      lastError: meta.lastError,
      requests: meta.requests,
      cacheHits: meta.cacheHits,
      lastDuration: meta.lastDurationMs,
    },
  })
}

function backoffRemainingMs(meta: SyncMeta): number {
  if (meta.failCount === 0) return 0
  const idx = Math.min(meta.failCount - 1, BACKOFF_MS.length - 1)
  const wait = BACKOFF_MS[idx]
  const elapsed = meta.lastSync ? Date.now() - meta.lastSync : Infinity
  return Math.max(0, wait - elapsed)
}

function hashContent(parts: (string | number | null)[]): string {
  return createHmac('sha256', 'avc-yummy-hash').update(parts.join('|')).digest('hex').slice(0, 32)
}

function hashProfile(p: YummyProfileSnapshot): string {
  return hashContent([p.id, p.nickname, p.avatarUrl])
}

function hashLists(items: YummyRemoteListItem[]): string {
  // hash(animeId:listId:date) по всем элементам (#23)
  const norm = items
    .map((i) => `${i.animeId}:${i.listId}:${i.siteDate ?? 0}`)
    .sort()
    .join(',')
  return hashContent([norm])
}

// --- публичный сервис ----------------------------------------------------------------

export const YummySyncService = {
  TTL_MS,

  /** Есть ли у этого браузера серверная сессия сайта (быстро, без сети) */
  async hasSession(): Promise<boolean> {
    const jarId = await readJarId()
    if (!jarId) return false
    const row = await loadSession(jarId)
    return !!(row && row.cookieValue)
  },

  /**
   * Проверка авторизации по РЕАЛЬНОМУ сайту (спека #4, #51: Authentication →
   * первый приоритет стартовой синхронизации). TTL профиля; сеть не блокирует UI.
   */
  async checkAuth(force = false): Promise<
    YummySyncOutcome<YummyProfileSnapshot> & {
      state: YummyAuthState
      wasLoggedIn: boolean
    }
  > {
    const jarId = await ensureJar()
    return collapse(`${jarId}:auth-check`, () => this._checkAuth(jarId, force))
  },

  async _checkAuth(
    jarId: string,
    force = false,
  ): Promise<
    YummySyncOutcome<YummyProfileSnapshot> & {
      state: YummyAuthState
      wasLoggedIn: boolean
    }
  > {
    const started = Date.now()
    const row = await loadSession(jarId)
    const hadCookie = !!(row && row.cookieValue)
    const wasLoggedIn = row?.authState === 'logged_in'
    const meta = await loadMeta(jarId, 'profile')

    // неудачная попытка не делает кэш «свежим» — иначе transient-сбой
    // заблокирует повторную проверку на весь TTL
    const fresh = meta.failCount === 0 && !!meta.lastSync && Date.now() - meta.lastSync < TTL_MS.profile
    if (!force && fresh && row?.authState) {
      meta.cacheHits += 1
      await saveMeta(jarId, 'profile', meta)
      return {
        ok: true,
        fromCache: true,
        stale: false,
        state: row.authState as YummyAuthState,
        wasLoggedIn,
        data:
          row.authState === 'logged_in' && row.yummyUserId
            ? {
                id: row.yummyUserId,
                nickname: row.yummyNickname ?? '',
                avatarUrl: row.avatarUrl,
                profileUrl: YummyAccountAdapter.profilePageUrl(row.yummyUserId),
              }
            : null,
        error: null,
        lastSync: meta.lastSync,
        durationMs: null,
        changed: false,
      }
    }

    // Backoff после серий неудач (спека #26)
    const wait = backoffRemainingMs(meta)
    if (wait > 0 && !force && row && row.cookieValue) {
      return {
        ok: false,
        fromCache: true,
        stale: true,
        state: row.authState as YummyAuthState,
        wasLoggedIn,
        data: null,
        error: `Сайт недоступен, повтор через ${Math.ceil(wait / 1000)} с`,
        lastSync: meta.lastSync,
        durationMs: null,
        changed: false,
      }
    }

    const cookie = sessionCookieHeader(row)
    const check = await YummyAccountAdapter.checkAuth(cookie)

    // Сеть недоступна: не стираем сессию (спека #25)
    if (check.state === 'unknown') {
      meta.failCount = Math.min(meta.failCount + 1, 99)
      meta.lastError = 'Сайт недоступен'
      meta.lastSync = Date.now()
      meta.lastDurationMs = Date.now() - started
      await saveMeta(jarId, 'profile', meta)
      return {
        ok: false,
        fromCache: !!row,
        stale: true,
        state: (row?.authState as YummyAuthState) ?? 'unknown',
        wasLoggedIn,
        data: null,
        error: 'Сайт недоступен — показаны кэшированные данные',
        lastSync: meta.lastSync,
        durationMs: meta.lastDurationMs,
        changed: false,
      }
    }

    meta.failCount = 0
    meta.lastError = null
    meta.lastSync = Date.now()
    meta.lastDurationMs = Date.now() - started
    meta.requests += 1

    if (check.authenticated && check.profile) {
      const newHash = hashProfile(check.profile)
      const changed = newHash !== meta.contentHash
      meta.contentHash = newHash
      await db.yummySession.upsert({
        where: { id: jarId },
        create: {
          id: jarId,
          cookieName: row?.cookieName ?? '',
          cookieValue: row?.cookieValue ?? '',
          yummyUserId: check.profile.id,
          yummyNickname: check.profile.nickname,
          avatarUrl: check.profile.avatarUrl,
          authState: 'logged_in',
          lastCheckAt: new Date(),
        },
        update: {
          yummyUserId: check.profile.id,
          yummyNickname: check.profile.nickname,
          avatarUrl: check.profile.avatarUrl,
          authState: 'logged_in',
          lastCheckAt: new Date(),
        },
      })
      await saveMeta(jarId, 'profile', meta)
      return {
        ok: true,
        fromCache: false,
        stale: false,
        state: 'logged_in',
        wasLoggedIn,
        data: check.profile,
        error: null,
        lastSync: meta.lastSync,
        durationMs: meta.lastDurationMs,
        changed,
      }
    }

    // 401: аноним (cookie истёк/отозван сайтом)
    const newState: YummyAuthState = hadCookie ? 'session_expired' : 'logged_out'
    if (row) {
      await db.yummySession.update({
        where: { id: jarId },
        data: { authState: newState, lastCheckAt: new Date() },
      })
    } else {
      await db.yummySession.upsert({
        where: { id: jarId },
        create: {
          id: jarId,
          cookieName: '',
          cookieValue: '',
          authState: newState,
          lastCheckAt: new Date(),
        },
        update: { authState: newState, lastCheckAt: new Date() },
      })
    }
    await saveMeta(jarId, 'profile', meta)
    return {
      ok: true,
      fromCache: false,
      stale: false,
      state: newState,
      wasLoggedIn,
      data: null,
      error: null,
      lastSync: meta.lastSync,
      durationMs: meta.lastDurationMs,
      // UI-уведомление только при переходе logged_in → session_expired (#27)
      changed: wasLoggedIn && newState === 'session_expired',
    }
  },

  /**
   * Синхронизация закладок/списков с реального сайта (trigger D/H: открытие
   * панели, действие с закладкой, ручной refresh). TTL 2 мин; hash-детект.
   */
  async syncLists(force = false): Promise<YummySyncOutcome<YummyRemoteListItem[]>> {
    const jarId = await readJarId()
    if (!jarId) {
      return {
        ok: false,
        fromCache: false,
        stale: false,
        data: null,
        error: 'not_authenticated',
        lastSync: null,
        durationMs: null,
        changed: false,
      }
    }
    return collapse(`${jarId}:lists-sync`, () => this._syncLists(jarId, force))
  },

  async _syncLists(jarId: string, force: boolean): Promise<YummySyncOutcome<YummyRemoteListItem[]>> {
    const started = Date.now()
    if (!jarId) {
      return {
        ok: false,
        fromCache: false,
        stale: false,
        data: null,
        error: 'not_authenticated',
        lastSync: null,
        durationMs: null,
        changed: false,
      }
    }
    const row = await loadSession(jarId)
    if (!row || !row.cookieValue || row.yummyUserId === null) {
      return {
        ok: false,
        fromCache: false,
        stale: false,
        data: null,
        error: 'not_authenticated',
        lastSync: null,
        durationMs: null,
        changed: false,
      }
    }

    const meta = await loadMeta(jarId, 'lists')
    const fresh = meta.failCount === 0 && !!meta.lastSync && Date.now() - meta.lastSync < TTL_MS.lists

    if (!force && fresh) {
      meta.cacheHits += 1
      await saveMeta(jarId, 'lists', meta)
      const cached = await this.readListCache(jarId)
      return {
        ok: true,
        fromCache: true,
        stale: false,
        data: cached,
        error: null,
        lastSync: meta.lastSync,
        durationMs: null,
        changed: false,
      }
    }

    const cookie = sessionCookieHeader(row)
    const res = await YummyAccountAdapter.getLists(cookie, row.yummyUserId)
    meta.requests += 1
    meta.lastSync = Date.now()
    meta.lastDurationMs = Date.now() - started

    if (!res.ok) {
      if (res.status === 401) {
        // Сессия истекла — фиксируем, кэш НЕ стираем (#25, #27)
        await db.yummySession.update({
          where: { id: jarId },
          data: { authState: 'session_expired', lastCheckAt: new Date() },
        })
        meta.failCount += 1
        meta.lastError = 'Сессия истекла'
        await saveMeta(jarId, 'lists', meta)
        const cached = await this.readListCache(jarId)
        return {
          ok: false,
          fromCache: cached.length > 0,
          stale: cached.length > 0,
          data: cached.length > 0 ? cached : null,
          error: 'session_expired',
          lastSync: meta.lastSync,
          durationMs: meta.lastDurationMs,
          changed: false,
        }
      }
      // Сеть/сайт: backoff, кэш остаётся (#25, #26)
      meta.failCount = Math.min(meta.failCount + 1, 99)
      meta.lastError = res.error
      await saveMeta(jarId, 'lists', meta)
      const cached = await this.readListCache(jarId)
      return {
        ok: false,
        fromCache: cached.length > 0,
        stale: true,
        data: cached.length > 0 ? cached : null,
        error: `${res.error ?? 'Сайт недоступен'} — показан кэш`,
        lastSync: meta.lastSync,
        durationMs: meta.lastDurationMs,
        changed: false,
      }
    }

    meta.failCount = 0
    meta.lastError = null
    const newHash = hashLists(res.items)
    const changed = newHash !== meta.contentHash
    meta.contentHash = newHash

    // Обновляем кэш только при изменении (спека #23: если hash тот же — ничего)
    if (changed) {
      await this.writeListCache(jarId, res.items)
    }
    await saveMeta(jarId, 'lists', meta)
    return {
      ok: true,
      fromCache: false,
      stale: false,
      data: res.items,
      error: null,
      lastSync: meta.lastSync,
      durationMs: meta.lastDurationMs,
      changed,
    }
  },

  /** Чтение UI-кэша списков из SQLite (offline display, спека #10, #25) */
  async readListCache(jarId: string): Promise<YummyRemoteListItem[]> {
    const rows = await db.yummyListCache.findMany({
      where: { sessionId: jarId },
      orderBy: [{ listId: 'asc' }, { siteDate: 'desc' }],
    })
    return rows.map((r) => ({
      animeId: r.animeId,
      animeUrl: r.animeUrl ?? String(r.animeId),
      title: r.title,
      poster: r.poster,
      listId: r.listId,
      year: r.year,
      rating: r.rating,
      siteDate: r.siteDate,
    }))
  },

  async writeListCache(jarId: string, items: YummyRemoteListItem[]): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.yummyListCache.deleteMany({ where: { sessionId: jarId } })
      // порциями, чтобы не раздуть стек параметров
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100)
        await tx.yummyListCache.createMany({
          data: chunk.map((i2) => ({
            sessionId: jarId,
            animeId: i2.animeId,
            animeUrl: i2.animeUrl,
            title: i2.title,
            poster: i2.poster,
            listId: i2.listId,
            year: i2.year,
            rating: i2.rating,
            siteDate: i2.siteDate,
          })),
        })
      }
    })
  },

  /** Сохранить сессию после успешного логина (полный Cookie-заголовок сайта) */
  async saveLoginSession(
    jarId: string,
    profile: YummyProfileSnapshot,
    sessionCookieHeader: string,
  ): Promise<void> {
    await db.yummySession.upsert({
      where: { id: jarId },
      create: {
        id: jarId,
        cookieName: '',
        cookieValue: sessionCookieHeader,
        yummyUserId: profile.id,
        yummyNickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        authState: 'logged_in',
        lastCheckAt: new Date(),
      },
      update: {
        cookieName: '',
        cookieValue: sessionCookieHeader,
        yummyUserId: profile.id,
        yummyNickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        authState: 'logged_in',
        lastCheckAt: new Date(),
      },
    })
    // Логин → полная синхронизация аккаунта (спека #13-B): сбрасываем TTL/бэкофф
    for (const resource of ['profile', 'lists'] as const) {
      const meta = await loadMeta(jarId, resource)
      meta.lastSync = null
      meta.failCount = 0
      meta.lastError = null
      meta.contentHash = null
      await saveMeta(jarId, resource, meta)
    }
  },

  /**
   * Выход: штатный logout на сайте + удаление сессии и её кэша.
   * Кэш списков стираем осознанно (user-initiated), не из-за сети (#25).
   */
  async logout(): Promise<{ ok: boolean; error: string | null }> {
    const jarId = await readJarId()
    if (!jarId) return { ok: true, error: null }
    const row = await loadSession(jarId)
    const cookie = sessionCookieHeader(row)
    let error: string | null = null
    if (cookie) {
      const siteOk = await YummyAccountAdapter.logout(cookie)
      if (!siteOk) error = 'Сайт не подтвердил выход — сессия очищена локально'
    }
    await db.yummyListCache.deleteMany({ where: { sessionId: jarId } })
    await db.yummySyncMeta.deleteMany({ where: { id: { startsWith: `${jarId}:` } } })
    metaCache.clear()
    await db.yummySession.deleteMany({ where: { id: jarId } })
    return { ok: true, error }
  },

  /** Диагностика (спека #48): метрики без чувствительных данных */
  async diagnostics(): Promise<{
    hasSession: boolean
    authState: YummyAuthState | 'none'
    lastCheckAt: string | null
    resources: {
      resource: YummyResource
      lastSync: string | null
      lastDurationMs: number | null
      requests: number
      cacheHits: number
      failCount: number
      lastError: string | null
    }[]
    cacheItems: number
    adapterVersion: string
  }> {
    const jarId = await readJarId()
    const adapterVersion = YummyAccountAdapter.version
    if (!jarId) {
      return {
        hasSession: false,
        authState: 'none',
        lastCheckAt: null,
        resources: [],
        cacheItems: 0,
        adapterVersion,
      }
    }
    const row = await loadSession(jarId)
    const profileMeta = await loadMeta(jarId, 'profile')
    const listsMeta = await loadMeta(jarId, 'lists')
    const cacheItems = (await db.yummyListCache.findMany({ where: { sessionId: jarId } })).length
    const fmt = (t: number | null) => (t ? new Date(t).toISOString() : null)
    return {
      hasSession: !!(row && row.cookieValue),
      authState: row ? (row.authState as YummyAuthState) : 'none',
      lastCheckAt: row?.lastCheckAt ? row.lastCheckAt.toISOString() : null,
      resources: [
        {
          resource: 'profile',
          lastSync: fmt(profileMeta.lastSync),
          lastDurationMs: profileMeta.lastDurationMs,
          requests: profileMeta.requests,
          cacheHits: profileMeta.cacheHits,
          failCount: profileMeta.failCount,
          lastError: profileMeta.lastError,
        },
        {
          resource: 'lists',
          lastSync: fmt(listsMeta.lastSync),
          lastDurationMs: listsMeta.lastDurationMs,
          requests: listsMeta.requests,
          cacheHits: listsMeta.cacheHits,
          failCount: listsMeta.failCount,
          lastError: listsMeta.lastError,
        },
      ],
      cacheItems,
      adapterVersion,
    }
  },
}
