'use client'
/**
 * Player Bridge — реальный двусторонний postMessage-протокол плеера Aksor
 * (Kodik-совместимый движок; формат подтверждён разбором бандла плеера
 * /assets/index-*.js: валидатор di() и диспетчер te()).
 *
 * КОМАНДЫ (родитель → iframe, обычные объекты, НЕ JSON-строки):
 *   {key:'player_play'}                          — запустить воспроизведение
 *   {key:'player_pause'}                         — пауза
 *   {key:'player_seek', value:<абс. секунда>}    — перемотка (плеер сам клампит к длительности)
 *   {key:'player_set_volume', value:{volume?:0..2, muted?:boolean}}
 *   {key:'player_set_source', value:{url, ...}}  — смена источника (резерв)
 *
 * СОБЫТИЯ (iframe → родитель, window.parent.postMessage):
 *   {key:'player_play'} | {key:'player_pause'} | {key:'player_video_started'}
 *   {key:'kodik_player_video_ended'}
 *   {key:'kodik_player_time_update', value:<сек>}      (после 1-й секунды)
 *   {key:'kodik_player_duration_update', value:<сек>}
 *   {key:'player_volume_change', value:{muted:boolean, volume:0..2}}
 *
 * АВТОЗАПУСК ГОЛОСОМ (баг «серия не запускается сама»):
 *   Браузеры разрешают play() со звуком внутри кросс-доменного iframe, только если
 *   топ-окно имеет «липкую» пользовательскую активацию (navigator.userActivation
 *   .hasStickyActivation — не истекает до конца жизни страницы), а iframe помечен
 *   allow="autoplay". Голосовая сессия ВСЕГДА начинается с жеста пользователя
 *   (кнопка микрофона, Ctrl+Space, клик «Разрешить» в запросе браузера) — этого
 *   одного клика достаточно, чтобы все последующие команды player_play, отправленные
 *   программно (в т.ч. по голосу), исполнялись без единого касания мыши.
 *   Если активации ещё нет — остаётся честный оверлей с подсказкой.
 */
import type { PlaybackContext } from './types'

// --- команды родитель → плеер ----------------------------------------------------

export type PlayerCommand =
  | { key: 'player_play' }
  | { key: 'player_pause' }
  | { key: 'player_seek'; value: number }
  | { key: 'player_set_volume'; value: { volume?: number; muted?: boolean } }

/** Активное окно iframe-плеера (региструет компонент Player) */
let activePlayerWindow: Window | null = null

export function registerPlayerWindow(win: Window | null): void {
  activePlayerWindow = win
}

export function playerWindowAvailable(): boolean {
  return activePlayerWindow !== null
}

/** Отправить команду в плеер. false — плеер не открыт (команда только в store). */
export function sendPlayerCommand(cmd: PlayerCommand): boolean {
  const win = activePlayerWindow
  if (!win) return false
  try {
    win.postMessage(cmd, '*')
    return true
  } catch {
    return false
  }
}

// --- события плеер → родитель -----------------------------------------------------

export type PlayerEvent =
  | { key: 'player_play' | 'player_pause' | 'player_video_started' | 'kodik_player_video_ended' }
  | { key: 'kodik_player_time_update' | 'kodik_player_duration_update'; value: number }
  | { key: 'player_volume_change'; value: { muted: boolean; volume: number } }

/** Строгий парсер входящих сообщений (зеркало валидатора di() плеера) */
export function parsePlayerEvent(data: unknown): PlayerEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.key !== 'string') return null
  switch (d.key) {
    case 'player_play':
    case 'player_pause':
    case 'player_video_started':
    case 'kodik_player_video_ended':
      return { key: d.key }
    case 'kodik_player_time_update':
    case 'kodik_player_duration_update':
      return typeof d.value === 'number' && Number.isFinite(d.value)
        ? { key: d.key, value: d.value }
        : null
    case 'player_volume_change': {
      const v = d.value
      if (typeof v !== 'object' || v === null) return null
      const val = v as Record<string, unknown>
      return {
        key: 'player_volume_change',
        value: {
          muted: val.muted === true,
          volume: typeof val.volume === 'number' && Number.isFinite(val.volume) ? val.volume : 0,
        },
      }
    }
    default:
      return null
  }
}

// --- громкость: store 0..100 ↔ плеер 0..2 (плеер поддерживает буст до 200%) -------

export function storeToPlayerVolume(v100: number): number {
  return Math.min(2, Math.max(0, v100 / 100))
}

export function playerToStoreVolume(v2: number): number {
  return Math.round(Math.min(1, Math.max(0, v2 / 2)) * 100)
}

/**
 * Протолкнуть громкость приложения в плеер (+ снять его собственный persist-мьют).
 *
 * Баг «плеер стартует на Mute»: Aksor хранит громкость/mute в СВОЁМ localStorage
 * (aksor-player-volume / aksor-player-muted, пишутся при КАЖДОЙ установке W()) и
 * восстанавливает их при каждом открытии серии. Один раз заглох — мьютится всегда.
 * pushPlayerVolume(volume>0) перезаписывает эту память: {volume, muted:false};
 * при volume===0 (пользователь сам замьютил) уважает выбор: {volume:0, muted:true}.
 * Вызывать при старте серии: по таймерам авто-старта (best-effort — плеер может
 * быть ещё не готов: его диспетчер делает if(!u) return) и ГАРАНТИРОВАННО по
 * первому событию от плеера (см. player.tsx) — там u уже точно существует.
 */
export function pushPlayerVolume(volume100: number): boolean {
  return sendPlayerCommand({
    key: 'player_set_volume',
    value: {
      volume: storeToPlayerVolume(volume100),
      muted: volume100 <= 0,
    },
  })
}

// --- пользовательская активация ---------------------------------------------------

/**
 * Есть ли «липкая» активация документа? Она появляется после ЛЮБОГО клика /
 * нажатия клавиши (например, кнопки микрофона) и не сбрасывается — этого
 * достаточно для легального play() со звуком в iframe с allow="autoplay".
 */
export function hasStickyActivation(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = (navigator as Navigator & { userActivation?: { hasStickyActivation?: boolean } })
    .userActivation
  return ua?.hasStickyActivation === true
}

/** Типизированный доступ к playback-состоянию (для подсказок в сообщениях) */
export type PlaybackSnapshot = Pick<
  PlaybackContext,
  'isPlaying' | 'currentTime' | 'duration' | 'volume'
>
