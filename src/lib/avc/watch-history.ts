'use client'
/**
 * WatchHistoryService — клиентский слой истории просмотров (мастер-промпт №1).
 *
 * ПРИНЦИПЫ:
 *  - Прогресс пишется ВО ВРЕМЯ воспроизведения (троттлинг FLUSH_INTERVAL_MS),
 *    а не только при закрытии приложения: рестарт браузера/вкладки ничего не теряет.
 *  - In-memory состояние + периодический flush → нет лишних дисковых записей.
 *  - Дополнительно flush: пауза, конец серии, смена серии/аниме, скрытие
 *    вкладки и pagehide (через navigator.sendBeacon — переживает закрытие).
 *  - Сервис не знает о вкладках: одна глобальная история, независимая от UI.
 *  - Завершённость: реальное событие ended (noteEnded) либо серверный порог 90%.
 *
 * Позиции для «Продолжи» резолвятся в executor'е (fuzzy по названию + history).
 */
import type { WatchHistoryEntryDto } from './types'

/** Период фонового сохранения прогресса во время воспроизведения */
const FLUSH_INTERVAL_MS = 5000
/** Не пишем шум: обновления реже этого смысла не имеют */
const MIN_POSITION_DELTA_SEC = 2

export interface WatchEpisodeInfo {
  animeId: number
  animeTitle: string
  animeSlug?: string | null
  poster?: string | null
  episodeNumber: number
  episodeId?: number | null
  episodeTitle?: string | null
  dub?: string | null
  quality?: string | null
  url?: string | null
}

/** Текущая (открытая) серия: метаданные + живая позиция */
interface TrackedEntry extends WatchEpisodeInfo {
  positionSec: number
  durationSec: number
  ended: boolean
  /** Позиция последнего flush (чтобы не флешить каждое time_update) */
  flushedAtSec: number
  dirty: boolean
}

let current: TrackedEntry | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null
let listenersBound = false

function payloadOf(e: TrackedEntry): Record<string, unknown> {
  return {
    animeId: e.animeId,
    animeTitle: e.animeTitle,
    animeSlug: e.animeSlug ?? null,
    poster: e.poster ?? null,
    episodeNumber: e.episodeNumber,
    episodeId: e.episodeId ?? null,
    episodeTitle: e.episodeTitle ?? null,
    lastPositionSec: Math.max(0, Math.round(e.positionSec * 10) / 10),
    durationSec: Math.max(0, Math.round(e.durationSec * 10) / 10),
    completed: e.ended,
    lastDub: e.dub ?? null,
    lastQuality: e.quality ?? null,
    lastKnownUrl: e.url ?? null,
  }
}

/** Отправить прогресс (fetch; для pagehide — sendBeacon) */
async function sendPayload(p: Record<string, unknown>, beacon = false): Promise<void> {
  const body = JSON.stringify(p)
  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      navigator.sendBeacon('/api/watch-history', new Blob([body], { type: 'application/json' }))
      return
    } catch {
      // sendBeacon недоступен — фолбэк на fetch ниже
    }
  }
  try {
    await fetch('/api/watch-history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
  } catch {
    // история не критична: сетевая ошибка не должна ронять воспроизведение
  }
}

/** Немедленно сохранить текущую серию (если есть что сохранять) */
export async function flushWatchProgress(beacon = false): Promise<void> {
  const e = current
  if (!e || !e.dirty) return
  e.dirty = false
  e.flushedAtSec = e.positionSec
  await sendPayload(payloadOf(e), beacon)
}

/** Гарантировать, что фоновый таймер существует */
function ensureTimer(): void {
  if (flushTimer !== null || typeof window === 'undefined') return
  flushTimer = setInterval(() => {
    void flushWatchProgress()
  }, FLUSH_INTERVAL_MS)
}

/** pagehide/visibilitychange → последний flush через sendBeacon */
function bindLifecycle(): void {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true
  const onHide = () => {
    const e = current
    if (e && e.dirty) void sendPayload(payloadOf(e), true)
  }
  window.addEventListener('pagehide', onHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHide()
  })
}

// --- публичный API ------------------------------------------------------------

/**
 * Открыта новая серия (или та же с обнулением). Сохраняет запись сразу
 * (смена серии — обязательный момент сохранения по спеке).
 */
export function noteEpisodeOpened(info: WatchEpisodeInfo, resumeSec = 0): void {
  current = {
    ...info,
    episodeId: info.episodeId ?? null,
    episodeTitle: info.episodeTitle ?? null,
    positionSec: Math.max(0, resumeSec),
    durationSec: 0,
    ended: false,
    flushedAtSec: -1,
    dirty: true,
  }
  ensureTimer()
  bindLifecycle()
  void flushWatchProgress()
}

/** Обновление позиции/длительности из событий плеера (троттлинг внутри) */
export function noteTimeUpdate(positionSec: number, durationSec: number): void {
  const e = current
  if (!e) return
  if (Number.isFinite(durationSec) && durationSec > 0) e.durationSec = durationSec
  if (!Number.isFinite(positionSec) || positionSec < 0) return
  e.positionSec = positionSec
  if (Math.abs(positionSec - e.flushedAtSec) >= MIN_POSITION_DELTA_SEC) e.dirty = true
}

/** Пауза — обязательная точка сохранения */
export function notePlaybackPaused(): void {
  void flushWatchProgress()
}

/** Реальный конец серии (событие ended от плеера) */
export function notePlaybackEnded(): void {
  const e = current
  if (!e) return
  e.ended = true
  e.dirty = true
  void flushWatchProgress()
}

/** Метаданные сменились (озвучка/качество/URL) — обновляем копию сервиса */
export function noteEpisodeMeta(patch: Partial<WatchEpisodeInfo>): void {
  if (!current) return
  Object.assign(current, patch)
  current.dirty = true
}

/** Сбросить трекинг (плеер закрыт, навигация прочь от аниме) */
export async function resetTracking(): Promise<void> {
  await flushWatchProgress()
  current = null
}

/** Полная история просмотров (свежие сверху) */
export async function fetchWatchHistory(limit = 300): Promise<WatchHistoryEntryDto[]> {
  try {
    const res = await fetch(`/api/watch-history?limit=${limit}`)
    if (!res.ok) return []
    const data = (await res.json()) as { items?: WatchHistoryEntryDto[] }
    return data.items ?? []
  } catch {
    return []
  }
}

/** История конкретного аниме (по его ID сайта) */
export async function fetchAnimeHistory(animeId: number): Promise<WatchHistoryEntryDto[]> {
  try {
    const res = await fetch(`/api/watch-history?animeId=${encodeURIComponent(String(animeId))}`)
    if (!res.ok) return []
    const data = (await res.json()) as { items?: WatchHistoryEntryDto[] }
    return data.items ?? []
  } catch {
    return []
  }
}

/** Убрать аниме из истории (все серии) */
export async function removeFromWatchHistory(animeId: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/watch-history?animeId=${encodeURIComponent(String(animeId))}`, {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}

/** Очистить всю историю просмотров */
export async function clearWatchHistory(): Promise<boolean> {
  try {
    const res = await fetch('/api/watch-history', { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}
