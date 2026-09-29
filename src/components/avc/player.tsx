'use client'
/**
 * Player — iframe-плеер с overlay-управлением: prev/-10/play/+10/next,
 * громкость, полный экран. Один и тот же iframe сохраняется при переходе
 * в fullscreen (переключаются только CSS-классы контейнера).
 */
import { useEffect } from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { executeCommand } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

function ctrl(type: VoiceCommandType, params: Record<string, string | number | boolean> = {}): void {
  void executeCommand({ type, params, confidence: 1, label: '' })
}

export function Player() {
  const url = useAvcStore((s) => s.playerIframeUrl)
  const playerName = useAvcStore((s) => s.playerPlayerName)
  const fullscreen = useAvcStore((s) => s.playerFullscreen)
  const setFullscreen = useAvcStore((s) => s.setPlayerFullscreen)
  const isPlaying = useAvcStore((s) => s.playback.isPlaying)
  const volume = useAvcStore((s) => s.playback.volume)
  const executing = useAvcStore((s) => s.voiceStatus === 'executing')

  // Esc — выход из полного экрана
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, setFullscreen])

  const iconBtn =
    'h-11 w-11 rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-amber-300 focus-visible:ring-amber-400/60'

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
          'flex w-full items-center justify-center',
          fullscreen ? 'min-h-0 flex-1' : 'aspect-video',
        )}
      >
        {url ? (
          <iframe
            src={url}
            title={`Плеер${playerName ? ` — ${playerName}` : ''}`}
            className={cn('h-full w-full', fullscreen ? '' : 'aspect-video')}
            allow="autoplay; fullscreen; encrypted-media"
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
        <Button variant="ghost" size="icon" aria-label="Назад на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 10 })}>
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
        <Button variant="ghost" size="icon" aria-label="Вперёд на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 10 })}>
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Следующая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.NextEpisode)}>
          <SkipForward className="h-5 w-5" />
        </Button>

        <div className="ml-1 hidden min-w-0 items-center gap-2 sm:flex sm:w-36">
          <Volume2 className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
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
