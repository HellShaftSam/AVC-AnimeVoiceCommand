'use client'
/**
 * PlayerAutomationService — ЦЕНТРАЛЬНЫЙ сервис автоматизации плеера (Task 20).
 *
 * Ответственность (всё в одном месте, никаких разрозненных обработчиков):
 *   1. АВТОПЕРЕХОД на следующую серию — настоящая машина состояний
 *      (disabled/idle/watching/nearEnd/preparingNext/transitioning/
 *      waitingForNext/completed/noNextEpisode/error/cancelled).
 *   2. АВТОПРОПУСК ОПЕНИНГА/ЭНДИНГА — ТОЛЬКО по официальным интервалам САЙТА
 *      (API /api/anime/{id}/videos → skips.opening/skips.ending, тот же источник
 *      данных, что и кнопка «Пропустить» в плеере Kodik). Никаких угаданных
 *      таймингов вида «опенинг = первые 90 секунд»: нет данных сайта —
 *      автопропуск недоступен и честно помечается в диагностике.
 *   3. Идемпотентность: один ended → один переход; один интервал → один skip
 *      на серию (флаги живут до РЕАЛЬНОЙ смены серии, не сбрасываются timeupdate'ом).
 *   4. Верификация: переход считается завершённым только после фактической
 *      загрузки новой серии (серия/URL сменились + метаданные/старт от нового
 *      плеера); skip — после подтверждённого перемещения времени (эхо seek /
 *      time_update у цели).
 *   5. Ручные действия главнее: ручной выбор серии мгновенно отменяет
 *      готовящийся переход; клик по СОБСТВЕННОЙ кнопке «Пропустить» плеера
 *      (событие kodik_player_skip_button) помечает интервал выполненным.
 *
 * СОБЫТИЙНАЯ модель (без опроса DOM/плеера): время приходит из уже текущих
 * событий плеера в player.tsx (kodik_player_time_update у обоих семейств;
 * aksor шлёт timeupdate ~4 Гц, kodik — при увеличении + get_time-поллинг 1 Гц
 * во время воспроизведения). Единственный таймер — «страховка» конца серии
 * (2 с, активна ТОЛЬКО в зоне nearEnd, см. watchdog): если время остановилось
 * у конца, а событие ended потерялось, конец выводится из фактов.
 *
 * ВАЖНОЕ ОГРАНИЧЕНИЕ (честно): интервалы пропускаются через player_seek
 * postMessage — у плееров Kodik/aksor ВХОДЯЩЕГО skip-метода в postMessage-
 * протоколе НЕТ (проверено реверсом бандлов в Task 20). Интервалы — те же,
 * что использует сам сайт, расхождений в данных нет.
 */
import { toast } from '@/hooks/use-toast'
import { sendPlayerCommand, waitForSeekConfirmation } from './player-bridge'
import { useAvcStore } from './store'
import type { AppSettings, AutomationSnapshot, AutoNextState, CommandResult, SkipInterval } from './types'

// --- типы -----------------------------------------------------------------------

export type AutomationSettingKey = 'autoplayNext' | 'autoSkipOpening' | 'autoSkipEnding'

export type EpisodeOpenedSource = 'manual' | 'automation'

export type EndedSignal = 'player-event' | 'fallback-watchdog'

interface EpisodeAutomation {
  /** animeId:episode:videoId — идентичность серии для всех флагов */
  key: string
  animeId: number
  episode: number
  label: string
  opening: SkipInterval | null
  ending: SkipInterval | null
  openingExecuted: boolean
  endingExecuted: boolean
  /** число неудачных попыток автопропуска (>= MAX — больше не пытаемся) */
  openingFailures: number
  endingFailures: number
  /** skip-команда отправлена и верифицируется — защита от повторных send */
  openingPending: boolean
  endingPending: boolean
  /** пришла ли ЯВНАЯ пауза от плеера с последнего play (дискриминатор
   *  «пользователь поставил на паузу» vs «видео кончилось само») */
  explicitPauseSeen: boolean
  /** ended этой серии уже обработан (идемпотентность автоперехода) */
  endedHandled: boolean
  duration: number | null
}

interface Transition {
  id: number
  fromKey: string
  targetEpisode: number
  targetAnimeId: number
  startedAt: number
  attempts: number
  cancelled: boolean
}

const MAX_SKIP_FAILURES = 2
const TRANSITION_TIMEOUT_MS = 15000
const NEAR_END_WINDOW_SEC = 120
/** считаем «конец», если время дошло до этой дельты от длительности */
const END_EPSILON_SEC = 1.5

// --- сервис ---------------------------------------------------------------------

class PlayerAutomationService {
  private current: EpisodeAutomation | null = null
  private state: AutoNextState = 'disabled'
  private transition: Transition | null = null
  private transitionSeq = 0
  /** ended-обработка по ключу серии — вторая ступень дедупликации */
  private lastEndedKey: string | null = null
  private log: Array<{ ts: number; text: string }> = []
  private lastEvent: { text: string; ts: number } | null = null
  private listeners = new Set<() => void>()
  /** страховочный watchdog конца серии (активен ТОЛЬКО в зоне nearEnd) */
  private watchdog: number | null = null
  private watchdogLastTime = 0
  private watchdogStalls = 0
  private playNudgeTimer: number | null = null
  private playNudgedForEpisode: number | null = null
  /** доступность следующей серии (для диагностики; заполняется асинхронно) */
  private nextAvailable: boolean | null = null

  // --- подписка диагностики (debug-панель) ---------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  private pushLog(text: string): void {
    this.log = [{ ts: Date.now(), text }, ...this.log].slice(0, 60)
    this.lastEvent = { text, ts: Date.now() }
    this.notify()
  }

  private setState(s: AutoNextState): void {
    if (this.state === s) return
    this.state = s
    this.notify()
  }

  // --- служебное ------------------------------------------------------------------

  private settings(): { autoplayNext: boolean; autoSkipOpening: boolean; autoSkipEnding: boolean } {
    const s = useAvcStore.getState().settings
    return {
      autoplayNext: s.autoplayNext === true,
      autoSkipOpening: s.autoSkipOpening === true,
      autoSkipEnding: s.autoSkipEnding === true,
    }
  }

  private syncBaseState(): void {
    if (this.transition) return
    const { autoplayNext } = this.settings()
    if (!autoplayNext) {
      this.setState('disabled')
      return
    }
    if (!this.current) {
      this.setState('idle')
      return
    }
    if (this.state !== 'completed' && this.state !== 'nearEnd' && this.state !== 'watching') {
      this.setState('watching')
    }
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  /**
   * FallbackWatchdog (спека §4 — подтверждение конца, если событие ended
   * потерялось). Тикает раз в 2 с ТОЛЬКО пока позиция в зоне конца и плеер
   * «играет»: два подряд тика без продвижения времени при t ≥ duration−2 →
   * трактуем как конец. Как только время идёт/пауза/ended — останавливается.
   */
  private startWatchdog(): void {
    if (this.watchdog !== null) return
    this.watchdogLastTime = useAvcStore.getState().playback.currentTime
    this.watchdogStalls = 0
    this.watchdog = window.setInterval(() => {
      const cur = this.current
      if (!cur || cur.endedHandled || this.transition) {
        this.stopWatchdog()
        return
      }
      const pb = useAvcStore.getState().playback
      const dur = cur.duration ?? 0
      if (dur <= 0 || !pb.isPlaying) {
        this.stopWatchdog()
        return
      }
      const t = pb.currentTime
      if (t > this.watchdogLastTime + 0.01) {
        // время идёт — конец не наступил
        this.watchdogLastTime = t
        this.watchdogStalls = 0
        return
      }
      this.watchdogStalls += 1
      if (t >= dur - 2 && this.watchdogStalls >= 2) {
        this.pushLog('время стоит у конца без события ended — трактую как конец серии')
        this.stopWatchdog()
        this.notifyEnded('fallback-watchdog')
      }
    }, 2000)
  }

  private cancelPlayNudge(): void {
    if (this.playNudgeTimer !== null) {
      window.clearTimeout(this.playNudgeTimer)
      this.playNudgeTimer = null
    }
  }

  // --- события жизненного цикла серии ----------------------------------------------

  /**
   * Новая серия открыта через playEpisode (единая точка входа всех переходов).
   * source='automation' — навигацию совершили мы сами (не отменять её!).
   */
  notifyEpisodeOpened(info: {
    animeId: number
    episode: number
    videoId: number
    label: string
    opening: SkipInterval | null
    ending: SkipInterval | null
    source: EpisodeOpenedSource
  }): void {
    const key = `${info.animeId}:${info.episode}:${info.videoId}`
    // Повторное открытие той же серии — НОВАЯ сессия просмотра: её ended
    // обязан снова иметь право запустить автопереход (спека §20: флаги живут
    // до смены серии, а не «до первого ended за всё время»)
    if (key === this.lastEndedKey) this.lastEndedKey = null
    this.current = {
      key,
      animeId: info.animeId,
      episode: info.episode,
      label: info.label,
      opening: info.opening,
      ending: info.ending,
      openingExecuted: false,
      endingExecuted: false,
      openingFailures: 0,
      endingFailures: 0,
      openingPending: false,
      endingPending: false,
      explicitPauseSeen: false,
      endedHandled: false,
      duration: useAvcStore.getState().playback.duration || null,
    }
    this.stopWatchdog()
    this.cancelPlayNudge()
    this.playNudgedForEpisode = null
    this.nextAvailable = null
    void this.computeNextAvailability(info.animeId, info.episode)

    if (info.source === 'manual' && this.transition) {
      const t = this.transition
      t.cancelled = true
      this.transition = null
      if (t.targetAnimeId === info.animeId && t.targetEpisode === info.episode) {
        // пользователь сам открыл ту серию, к которой готовился автопереход
        this.setState('completed')
        this.pushLog(`пользователь сам открыл серию ${info.episode} (цель автоперехода совпала)`)
      } else {
        // РУЧНОЕ ДЕЙСТВИЕ ГЛАВНЕЕ (спека §9): мгновенная отмена готовящегося
        // перехода — автоматика больше НЕ уведёт пользователя на старую цель
        this.setState('cancelled')
        this.pushLog(
          `переход к серии ${t.targetEpisode} отменён: пользователь открыл серию ${info.episode}`,
        )
      }
    } else if (info.source === 'automation' && this.transition) {
      this.setState('waitingForNext')
    } else if (info.source === 'manual') {
      this.setState('watching')
    }

    const skipInfo = [
      info.opening ? `опенинг ${info.opening.start}–${info.opening.end}с` : null,
      info.ending ? `эндинг ${info.ending.start}–${info.ending.end}с` : null,
    ]
      .filter(Boolean)
      .join(', ')
    this.pushLog(
      `серия открыта (${info.source}): ${info.label || key}` +
        (skipInfo ? `; интервалы сайта: ${skipInfo}` : '; интервалов пропуска сайт не дал'),
    )
    this.syncBaseState()
  }

  /** Асинхронно уточнить доступность следующей серии (только для диагностики) */
  private async computeNextAvailability(animeId: number, episode: number): Promise<void> {
    try {
      const { fetchDetails, maxEpisodeOf } = await import('./executor')
      const details = await fetchDetails(animeId)
      if (!details || this.current?.animeId !== animeId) return
      const max = maxEpisodeOf(details)
      this.nextAvailable = max > 0 ? episode < max : null
      this.notify()
    } catch {
      this.nextAvailable = null
    }
  }

  /** Смена аниме/закрытие плеера — полное сбрасывание состояния серии */
  notifyAnimeChange(): void {
    if (this.transition) {
      this.transition.cancelled = true
      this.transition = null
      this.setState('cancelled')
      this.pushLog('переход отменён: сменилось аниме / плеер закрыт')
    }
    this.current = null
    this.stopWatchdog()
    this.cancelPlayNudge()
    this.syncBaseState()
    this.pushLog('аниме сменилось — состояние автоматизации сброшено')
  }

  /** Явная отмена (команда «отмена», выключение автоперехода во время перехода) */
  cancelPending(reason: string): void {
    if (!this.transition) return
    this.transition.cancelled = true
    this.transition = null
    this.setState('cancelled')
    this.pushLog(`переход отменён: ${reason}`)
  }

  // --- события времени --------------------------------------------------------------

  notifyDuration(d: number): void {
    if (this.current && Number.isFinite(d) && d > 0) this.current.duration = d
  }

  notifyUserSeek(t: number): void {
    if (!this.current) return
    // Пользователь перемотал. Флаги пропусков НЕ сбрасываем (спека §22):
    // если опенинг уже пропущен — при отмотке назад автопропуск не спамит.
    // Если интервал ещё не пропущен — обычная логика сработает на ближайшем
    // time_update (позиция внутри интервала → skip, один раз за серию).
    this.pushLog(`пользовательская перемотка на ${Math.round(t)}с`)
  }

  /**
   * Главный обработчик времени (player.tsx на каждое событие от АКТИВНОГО
   * iframe). Здесь: движок автопропуска + состояния машины автоперехода.
   */
  notifyTimeUpdate(t: number, duration: number, isPlaying: boolean): void {
    const cur = this.current
    if (!cur || !Number.isFinite(t)) return
    if (Number.isFinite(duration) && duration > 0) cur.duration = duration

    // 1) автомат пропусков (независим от autoplayNext)
    this.checkSkips(cur, t, isPlaying)

    // 2) машина автоперехода
    if (!this.transition) {
      const { autoplayNext } = this.settings()
      if (autoplayNext) {
        const dur = cur.duration ?? 0
        const endingStart = cur.ending?.start
        const near =
          (dur > 0 && t >= dur - NEAR_END_WINDOW_SEC) || (endingStart != null && t >= endingStart - 5)
        this.setState(near ? 'nearEnd' : 'watching')
      } else {
        this.setState('disabled')
      }
    }

    // 3) страховка конца серии
    const dur = cur.duration ?? 0
    if (dur > 0 && t >= dur - NEAR_END_WINDOW_SEC && isPlaying && !cur.endedHandled) {
      this.startWatchdog()
    }
  }

  /** Явная пауза от плеера (дискриминатор для fallback-детектора конца) */
  notifyPause(): void {
    if (this.current) this.current.explicitPauseSeen = true
    this.stopWatchdog()
  }

  /** Явный play/старт от плеера */
  notifyPlay(): void {
    if (this.current) this.current.explicitPauseSeen = false
  }

  // --- АВТОПРОПУСК (Feature B) -------------------------------------------------------

  private checkSkips(cur: EpisodeAutomation, t: number, isPlaying: boolean): void {
    // во время перехода и после конца серии пропуски бессмысленны и опасны
    // (команда уйдёт в УЖЕ НОВЫЙ iframe) — жёсткий guard
    if (this.transition || cur.endedHandled) return
    const st = this.settings()
    if (st.autoSkipOpening) this.maybeSkip(cur, 'opening', cur.opening, t, isPlaying)
    if (st.autoSkipEnding) this.maybeSkip(cur, 'ending', cur.ending, t, isPlaying)
  }

  private maybeSkip(
    cur: EpisodeAutomation,
    kind: 'opening' | 'ending',
    interval: SkipInterval | null,
    t: number,
    isPlaying: boolean,
  ): void {
    if (!interval) return // сайт не дал интервал → автопропуск НЕДОСТУПЕН (не гадаем)
    const executed = kind === 'opening' ? cur.openingExecuted : cur.endingExecuted
    const pending = kind === 'opening' ? cur.openingPending : cur.endingPending
    const failures = kind === 'opening' ? cur.openingFailures : cur.endingFailures
    if (executed || pending || failures >= MAX_SKIP_FAILURES) return
    if (!isPlaying) return // на паузе не пропускаем — пользователь управляет

    // Условие пропуска: фактическая позиция ВНУТРИ интервала САЙТА.
    // «Кнопка пропуска существует» ≠ «опенинг идёт сейчас» (спека §16).
    const inRange = t >= interval.start - 1.5 && t < interval.end - 0.5
    if (!inRange) return

    void this.executeSkip(cur, kind, interval)
  }

  private async executeSkip(
    cur: EpisodeAutomation,
    kind: 'opening' | 'ending',
    interval: SkipInterval,
  ): Promise<void> {
    // пессимистичная блокировка от повторной отправки
    if (kind === 'opening') cur.openingPending = true
    else cur.endingPending = true

    const target = interval.end
    const from = useAvcStore.getState().playback.currentTime
    this.pushLog(
      `автопропуск ${kind === 'opening' ? 'опенинга' : 'эндинга'}: ${Math.round(from)}с → ${target}с (интервал сайта)`,
    )
    sendPlayerCommand({ key: 'player_seek', value: target })

    // Верификация (спека §21): ждём подтверждения от плеера — эхо seek или
    // time_update у цели (±3 с: плеер мог клампнуть к длительности).
    const confirmed = await waitForSeekConfirmation(target, 2500)
    if (kind === 'opening') cur.openingPending = false
    else cur.endingPending = false

    // серия могла смениться, пока ждали подтверждение
    if (this.current !== cur) return

    if (confirmed) {
      if (kind === 'opening') cur.openingExecuted = true
      else cur.endingExecuted = true
      this.pushLog(
        `пропуск ${kind === 'opening' ? 'опенинга' : 'эндинга'} подтверждён (позиция ${Math.round(
          useAvcStore.getState().playback.currentTime,
        )}с)`,
      )
      this.notify()
      return
    }

    // не подтверждено: одна повторная попытка, затем честная остановка
    if (kind === 'opening') cur.openingFailures += 1
    else cur.endingFailures += 1
    const failures = kind === 'opening' ? cur.openingFailures : cur.endingFailures
    if (failures < MAX_SKIP_FAILURES) {
      this.pushLog('плеер не подтвердил пропуск — повторная попытка')
      window.setTimeout(() => {
        if (this.current !== cur) return
        const pb = useAvcStore.getState().playback
        this.maybeSkip(cur, kind, interval, pb.currentTime, pb.isPlaying)
      }, 700)
    } else {
      this.pushLog(
        `автопропуск ${kind === 'opening' ? 'опенинга' : 'эндинга'} не сработал (плеер не подтвердил) — воспроизведение продолжается без вмешательства`,
      )
      this.notify()
    }
  }

  /**
   * Пользователь нажал СОБСТВЕННУЮ кнопку «Пропустить» плеера Kodik
   * (kodik_player_skip_button, реверс Task 20). Спека §23: помечаем
   * соответствующий интервал выполненным — автопропуск не дублирует.
   */
  notifyPlayerSkipButton(title: string): void {
    const cur = this.current
    if (!cur) return
    const t = useAvcStore.getState().playback.currentTime
    const isOpeningWord = /опенинг|интро|заставк|opening/i.test(title)
    const isEndingWord = /эндинг|концовк|outro|ending/i.test(title)
    let which: 'opening' | 'ending' | 'both' = 'both'
    if (isOpeningWord && !isEndingWord) which = 'opening'
    else if (isEndingWord && !isOpeningWord) which = 'ending'
    else if (cur.opening && t >= cur.opening.start - 2 && t < cur.opening.end) which = 'opening'
    else if (cur.ending && t >= cur.ending.start - 2 && t < cur.ending.end) which = 'ending'

    if (which === 'opening' || which === 'both') cur.openingExecuted = true
    if (which === 'ending' || which === 'both') cur.endingExecuted = true
    this.pushLog(`пропуск кнопкой плеера («${title}») → помечено: ${which}`)
    this.notify()
  }

  // --- АВТОПЕРЕХОД (Feature A) ---------------------------------------------------------

  /**
   * Конец серии. signal='player-event' — реальное событие плеера
   * (kodik_player_video_ended, посылают ОБОИ семейства — проверено реверсом);
   * 'fallback-watchdog' — конец, выведенный из остановки времени у конца.
   */
  notifyEnded(signal: EndedSignal = 'player-event'): void {
    const cur = this.current
    if (!cur) return
    // --- идемпотентность (спека §5): один ended → один переход -------------------
    if (cur.endedHandled) return
    if (cur.key === this.lastEndedKey) return
    if (this.transition) return // переход уже выполняется
    cur.endedHandled = true
    this.lastEndedKey = cur.key
    this.stopWatchdog()

    const { autoplayNext } = this.settings()
    if (!autoplayNext) {
      this.setState('disabled')
      return
    }
    this.setState('preparingNext')
    this.pushLog(
      `конец серии ${cur.episode} (${signal === 'player-event' ? 'событие плеера' : 'fallback'}) — готовлю автопереход`,
    )
    void this.prepareAndNavigate(cur)
  }

  private async prepareAndNavigate(cur: EpisodeAutomation): Promise<void> {
    const pb0 = useAvcStore.getState().playback

    // Определение следующей серии (приоритет: адаптер сайта → матрица видео)
    const { fetchDetails, maxEpisodeOf, pickVideo, playEpisode } = await import('./executor')
    const details = await fetchDetails(cur.animeId)
    if (this.current !== cur) return // пока грузились — всё сменилось
    if (!details) {
      this.setState('error')
      this.pushLog('не удалось загрузить данные аниме — страница оставлена как есть')
      toast({ description: 'Автопереход: не удалось загрузить данные аниме' })
      return
    }
    const max = maxEpisodeOf(details)
    const nextEp = cur.episode + 1
    if (max > 0 && nextEp > max) {
      this.setState('noNextEpisode')
      this.pushLog(`серия ${cur.episode} — последняя доступная (${max}); автоперехода нет`)
      toast({ description: `Автопереход: это последняя серия (${max})` })
      return
    }
    const video = pickVideo(details, nextEp, pb0.currentDub)
    if (!video || !video.iframeUrl) {
      this.setState('noNextEpisode')
      this.pushLog(`серия ${nextEp} недоступна (нет видео для этой озвучки) — страница оставлена как есть`)
      toast({ description: `Автопереход: серия ${nextEp} ещё недоступна` })
      return
    }

    // Запуск перехода (идемпотентная guard-переменная)
    const t: Transition = {
      id: ++this.transitionSeq,
      fromKey: cur.key,
      targetEpisode: nextEp,
      targetAnimeId: cur.animeId,
      startedAt: Date.now(),
      attempts: 1,
      cancelled: false,
    }
    this.transition = t
    this.setState('transitioning')
    const runNavigate = (): Promise<CommandResult> => playEpisode(nextEp, 0, 'automation')
    let res = await runNavigate()

    if (t.cancelled || this.transition !== t) return // отменён во время навигации

    if (!res.success && t.attempts < 2) {
      t.attempts += 1
      this.pushLog(`переход не удался (${res.message}) — повторная попытка`)
      res = await runNavigate()
      if (t.cancelled || this.transition !== t) return
    }
    if (!res.success) {
      this.transition = null
      this.setState('error')
      this.pushLog(`переход к серии ${nextEp} не удался: ${res.message}`)
      toast({ description: `Автопереход не удался: ${res.message}` })
      return
    }

    // Верификация факта загрузки новой серии (спека §7)
    const verdict = await this.waitForTransition(t)
    if (verdict === 'cancelled') return // состояние уже выставлено отменой
    this.transition = null
    if (verdict === 'verified') {
      this.setState('completed')
      this.pushLog(`переход к серии ${nextEp} подтверждён`)
      this.confirmAutoplay(nextEp)
    } else {
      const s = useAvcStore.getState()
      const looksLoaded =
        s.playback.currentEpisode === nextEp && s.playback.animeId === cur.animeId
      this.setState(looksLoaded ? 'completed' : 'error')
      this.pushLog(
        looksLoaded
          ? `переход к серии ${nextEp}: навигация подтверждена, метаданные не дождались (таймаут)`
          : `переход к серии ${nextEp} не подтверждён за ${Math.round(TRANSITION_TIMEOUT_MS / 1000)}с — страница оставлена как есть`,
      )
      if (!looksLoaded) toast({ description: 'Автопереход: не подтвердилась загрузка серии' })
    }
    this.notify()
  }

  /**
   * Событийное ожидание подтверждения новой серии через подписку на store
   * (никаких while-поллингов). Фаза 1: серия/аниме совпадают. Фаза 2: от
   * НОВОГО плеера пришли метаданные (duration обновился) или время пошло, или
   * старт подтвердился (isPlaying).
   */
  private waitForTransition(t: Transition): Promise<'verified' | 'timeout' | 'cancelled'> {
    return new Promise((resolve) => {
      const store = useAvcStore
      const durationAtStart = store.getState().playback.duration
      let done = false
      const finish = (v: 'verified' | 'timeout' | 'cancelled'): void => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        unsub()
        resolve(v)
      }
      const timer = window.setTimeout(() => finish('timeout'), TRANSITION_TIMEOUT_MS)
      const check = (s: ReturnType<typeof store.getState>): void => {
        if (done) return
        if (t.cancelled || this.transition?.id !== t.id) {
          finish('cancelled')
          return
        }
        const epOk =
          s.playback.currentEpisode === t.targetEpisode && s.playback.animeId === t.targetAnimeId
        if (!epOk) return
        // фаза 2 — живые признаки новой серии
        const metaOk =
          (s.playback.duration > 0 && s.playback.duration !== durationAtStart) ||
          s.playback.currentTime > 0 ||
          s.playback.isPlaying
        if (metaOk) finish('verified')
      }
      const unsub = store.subscribe(check)
    })
  }

  /** После подтверждённого перехода: дождаться автозапуска (однократный nudge) */
  private confirmAutoplay(targetEpisode: number): void {
    this.cancelPlayNudge()
    this.playNudgeTimer = window.setTimeout(() => {
      this.playNudgeTimer = null
      const s = useAvcStore.getState()
      if (s.playback.currentEpisode !== targetEpisode) return
      if (s.playback.isPlaying) return
      // автозапуск не произошёл сам — ОДИН дожим (у player.tsx свои retry-таймеры;
      // спамить play() запрещено — спека §8)
      if (this.playNudgedForEpisode !== targetEpisode) {
        this.playNudgedForEpisode = targetEpisode
        this.pushLog('автозапуск новой серии не подтвердился — одиночный дожим play')
        sendPlayerCommand({ key: 'player_play' })
      }
    }, 2600)
  }

  // --- НАСТРОЙКИ (тумблеры плеера + голосовые команды) ---------------------------------

  /**
   * Применить тумблер автоматизации: мгновенно в рантайме + persist в БД.
   * НЕ перезагружает страницу/плеер и не влияет на текущее воспроизведение
   * (спека §30/§31).
   */
  applySetting(key: AutomationSettingKey, value: boolean): CommandResult {
    const st = useAvcStore.getState()
    const labels: Record<AutomationSettingKey, string> = {
      autoplayNext: 'Автопереход',
      autoSkipOpening: 'Автопропуск опенинга',
      autoSkipEnding: 'Автопропуск эндинга',
    }
    st.updateSettings({ [key]: value } as Partial<AppSettings>)

    // выключение автоперехода посреди готовящегося перехода — отмена (стабильно)
    if (key === 'autoplayNext' && !value) {
      this.cancelPending('выключен автопереход')
    }
    this.syncBaseState()
    this.pushLog(`${labels[key]}: ${value ? 'включено' : 'выключено'}`)

    // persist (fire-and-forget, как в settings-dialog); при ошибке — честный тост
    void fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
      })
      .catch(() => {
        toast({ description: 'Не удалось сохранить настройку в базе' })
      })

    return {
      success: true,
      message: `${labels[key]} ${value ? 'включён' : 'выключен'}`,
    }
  }

  /** Статус всех трёх тумблеров («автопереход включен?») */
  statusMessage(): string {
    const s = this.settings()
    return [
      `Автопереход ${s.autoplayNext ? 'включён' : 'выключен'}`,
      `автопропуск опенинга ${s.autoSkipOpening ? 'включён' : 'выключен'}`,
      `автопропуск эндинга ${s.autoSkipEnding ? 'включён' : 'выключен'}`,
    ].join(', ')
  }

  // --- ДИАГНОСТИКА ------------------------------------------------------------------------

  getSnapshot(): AutomationSnapshot {
    const cur = this.current
    const st = useAvcStore.getState()
    const s = this.settings()
    const t = st.playback.currentTime
    const dur = cur?.duration ?? (st.playback.duration > 0 ? st.playback.duration : null)
    const intervalInfo = (iv: SkipInterval | null, executed: boolean) => ({
      available: iv !== null,
      active: iv !== null && t >= iv.start - 1.5 && t < iv.end,
      executed,
      interval: iv,
    })
    return {
      autoNextState: this.state,
      autoNextEnabled: s.autoplayNext,
      autoSkipOpening: s.autoSkipOpening,
      autoSkipEnding: s.autoSkipEnding,
      episodeKey: cur?.key ?? null,
      episodeLabel: cur?.label ?? (st.playback.animeTitle ? String(st.playback.animeTitle) : null),
      duration: dur,
      currentTime: t,
      opening: intervalInfo(cur?.opening ?? null, cur?.openingExecuted ?? false),
      ending: intervalInfo(cur?.ending ?? null, cur?.endingExecuted ?? false),
      nextEpisodeAvailable: this.nextAvailable,
      transitionInProgress: this.transition !== null,
      transitionTarget: this.transition?.targetEpisode ?? null,
      lastEvent: this.lastEvent?.text ?? null,
      lastEventAt: this.lastEvent?.ts ?? null,
      log: this.log.slice(0, 24),
    }
  }
}

/** Синглтон сервиса (один на приложение — без дублирующих инстансов) */
export const playerAutomation = new PlayerAutomationService()

/** Порог конца серии — переиспользуется в диагностике/тестах ручной проверки */
export const AUTOMATION_END_EPSILON_SEC = END_EPSILON_SEC
