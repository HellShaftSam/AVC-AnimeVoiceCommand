'use client'
/**
 * Player — iframe-плеер с overlay-управлением: prev/-30/-10/play/+10/+30/next,
 * таймлайн (виртуальный), громкость + mute, полный экран.
 *
 * Особенности:
 *  - Один и тот же iframe сохраняется при переходе в fullscreen (меняются только
 *    CSS-классы контейнера).
 *  - Overlay «Нажмите, чтобы запустить»: браузеры блокируют автозапуск со звуком —
 *    один клик по overlay снимает его БЕЗ перезагрузки iframe (локальный state,
 *    сбрасывается при смене url).
 *  - postMessage best-effort (tryPost): шлём свои команды внутрь iframe на случай,
 *    если сторонний плеер их поддержит. Никогда не блокирует выполнение команды.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { executeCommand } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Секунды → «мм:сс» / «ч:мм:сс»; неизвестное значение → «--:--» */
function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--:--'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

export function Player() {
  const url = useAvcStore((s) => s.playerIframeUrl)
  const playerName = useAvcStore((s) => s.playerPlayerName)
  const fullscreen = useAvcStore((s) => s.playerFullscreen)
  const setFullscreen = useAvcStore((s) => s.setPlayerFullscreen)
  const isPlaying = useAvcStore((s) => s.playback.isPlaying)
  const volume = useAvcStore((s) => s.playback.volume)
  const currentTime = useAvcStore((s) => s.playback.currentTime)
  const duration = useAvcStore((s) => s.playback.duration)
  const executing = useAvcStore((s) => s.voiceStatus === 'executing')

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /** Overlay автозапуска: показывается для каждой новой серии, скрывается кликом */
  const [startOverlay, setStartOverlay] = useState(false)

  // Новая серия → снова показываем overlay автозапуска
  useEffect(() => {
    setStartOverlay(Boolean(url))
  }, [url])

  // Esc — выход из полного экрана
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, setFullscreen])

  /** postMessage внутрь iframe — best-effort, в try/catch (плеер может не поддерживать) */
  const tryPost = (msg: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    try {
      win.postMessage(JSON.stringify(msg), '*')
    } catch {
      // ignore — кросс-доменный iframe может запретить postMessage
    }
  }

  const ctrl = (
    type: VoiceCommandType,
    params: Record<string, string | number | boolean> = {},
  ): void => {
    // best-effort: попробуем донести команду до плеера напрямую
    const sec = Number(params.seconds ?? 0)
    switch (type) {
      case VoiceCommandType.SeekForward:
        tryPost({ type: 'avc-seek', seconds: sec || 10 })
        break
      case VoiceCommandType.SeekBackward:
        tryPost({ type: 'avc-seek', seconds: -(sec || 10) })
        break
      case VoiceCommandType.Play:
        tryPost({ type: 'avc-play' })
        break
      case VoiceCommandType.Pause:
        tryPost({ type: 'avc-pause' })
        break
      case VoiceCommandType.TogglePlayPause:
        tryPost(isPlaying ? { type: 'avc-pause' } : { type: 'avc-play' })
        break
      case VoiceCommandType.Mute:
        tryPost({ type: 'avc-volume', volume: 0 })
        break
      case VoiceCommandType.Unmute: {
        const st = useAvcStore.getState()
        tryPost({ type: 'avc-volume', volume: st.playback.volume > 0 ? st.playback.volume : 70 })
        break
      }
      case VoiceCommandType.SetVolume:
        tryPost({ type: 'avc-volume', volume: Number(params.volume ?? volume) })
        break
      default:
        break
    }
    void executeCommand({ type, params, confidence: 1, label: '' })
  }

  const iconBtn =
    'h-11 w-11 rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-amber-300 focus-visible:ring-amber-400/60'
  /** Кнопка ±30: иконка с маленьким бейджем «30» в углу */
  const seekBtn = cn(iconBtn, 'relative')

  return (
    <div
      className={cn(
        'flex flex-col bg-black',
        fullscreen
          ? 'fixed inset-0 z-50'
          : 'mx-auto w-full max-w-4xl overflow-hidden rounded-xl border border-zinc-800 shadow-[0_0_30px_rgba(0,0,0,0.5)]',
      )}
      role="region"
      aria-label="Видеоплеер"
    >
      <div
        className={cn(
          'relative flex w-full items-center justify-center',
          fullscreen ? 'min-h-0 flex-1' : 'aspect-video',
        )}
      >
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            title={`Плеер${playerName ? ` — ${playerName}` : ''}`}
            className={cn('h-full w-full', fullscreen ? '' : 'aspect-video')}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 text-zinc-600">
            <Play className="h-10 w-10" aria-hidden />
            <p className="max-w-xs px-4 text-center text-sm">
              Выберите серию — плеер появится здесь
            </p>
          </div>
        )}

        {/* Overlay автозапуска: браузеры блокируют автоплей со звуком.
            Клик снимает overlay локальным state — iframe НЕ перезагружается. */}
        {url && startOverlay && (
          <div
            className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center gap-4 bg-black/60 backdrop-blur-sm"
            onClick={() => {
              setStartOverlay(false)
              // best-effort: попросим плеер начать воспроизведение
              tryPost({ type: 'avc-play' })
            }}
            role="button"
            tabIndex={0}
            aria-label="Запустить серию"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setStartOverlay(false)
                tryPost({ type: 'avc-play' })
              }
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className={cn(
                'flex items-center justify-center rounded-full bg-amber-400 text-zinc-950 shadow-[0_0_40px_rgba(251,191,36,0.55)] transition-transform hover:scale-105',
                fullscreen ? 'h-28 w-28' : 'h-[88px] w-[88px]',
              )}
            >
              <Play className={fullscreen ? 'h-14 w-14' : 'h-11 w-11'} aria-hidden />
            </button>
            <div className="px-6 text-center">
              <p className="text-base font-semibold text-zinc-100 sm:text-lg">
                Нажмите, чтобы запустить
              </p>
              <p className="mt-1 text-xs text-zinc-400 sm:text-sm">
                Браузеры блокируют автозапуск со звуком — одного клика достаточно
              </p>
            </div>
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 px-3 py-2',
          fullscreen ? 'border-t border-zinc-800 bg-zinc-950/95' : 'bg-zinc-950/80',
        )}
      >
        <Button variant="ghost" size="icon" aria-label="Предыдущая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.PreviousEpisode)}>
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Назад на 30 секунд" title="Назад на 30 секунд" className={seekBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 30 })}>
          <RotateCcw className="h-5 w-5" />
          <span className="absolute bottom-0 right-0.5 text-[9px] font-bold leading-none text-zinc-500" aria-hidden>
            30
          </span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Назад на 10 секунд" title="Назад на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 10 })}>
          <RotateCcw className="h-5 w-5" />
        </Button>
        <Button
          size="icon"
          aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}
          className="h-12 w-12 rounded-full bg-amber-400 text-zinc-950 shadow-[0_0_18px_rgba(251,191,36,0.4)] hover:bg-amber-300"
          onClick={() => ctrl(VoiceCommandType.TogglePlayPause)}
        >
          {executing ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : isPlaying ? (
            <Pause className="h-6 w-6" />
          ) : (
            <Play className="h-6 w-6" />
          )}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 10 })}>
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Вперёд на 30 секунд" title="Вперёд на 30 секунд" className={seekBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 30 })}>
          <RotateCw className="h-5 w-5" />
          <span className="absolute bottom-0 right-0.5 text-[9px] font-bold leading-none text-zinc-500" aria-hidden>
            30
          </span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Следующая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.NextEpisode)}>
          <SkipForward className="h-5 w-5" />
        </Button>

        {/* Виртуальный таймлайн: currentTime / duration */}
        <div className="ml-1 hidden items-center gap-1 font-mono text-xs tabular-nums text-zinc-400 md:flex">
          <span className="text-zinc-200">{fmtTime(currentTime)}</span>
          <span className="text-zinc-600">/</span>
          <span>{fmtTime(duration > 0 ? duration : null)}</span>
        </div>

        <div className="ml-1 hidden min-w-0 items-center gap-2 sm:flex sm:w-32">
          <Button
            variant="ghost"
            size="icon"
            aria-label={volume > 0 ? 'Выключить звук' : 'Включить звук'}
            title={volume > 0 ? 'Выключить звук' : 'Включить звук'}
            className="h-9 w-9 shrink-0 rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-amber-300"
            onClick={() => ctrl(volume > 0 ? VoiceCommandType.Mute : VoiceCommandType.Unmute)}
          >
            {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-rose-400" />}
          </Button>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={1}
            aria-label="Громкость"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : volume
              if (typeof val === 'number') {
                useAvcStore.getState().patchPlayback({ volume: val })
              }
            }}
            className="w-full [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
          />
        </div>

        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
          className={iconBtn}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
        </Button>
      </div>
    </div>
  )
}
