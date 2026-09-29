'use client'
/**
 * VoicePanel — нижняя левая панель: кнопка микрофона (push-to-talk),
 * статус голоса, режим микрофона, тестовый ввод команд, последний результат.
 */
import { useState } from 'react'
import { Loader2, Mic, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { executeText } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { VoiceApi } from '@/lib/avc/use-voice'
import { cn } from '@/lib/utils'

function statusLine(status: string, message: string): string {
  switch (status) {
    case 'listening':
      return 'Слушаю...'
    case 'recognizing':
      return 'Распознаю...'
    case 'executing':
      return `Выполняю: ${message}`
    case 'error':
      return message || 'Ошибка'
    default:
      return '🎤 Готов'
  }
}

export function VoicePanel({ voice }: { voice: VoiceApi }) {
  const voiceStatus = useAvcStore((s) => s.voiceStatus)
  const voiceMessage = useAvcStore((s) => s.voiceMessage)
  const voiceMode = useAvcStore((s) => s.settings.voiceMode)
  const lastExecuted = useAvcStore((s) => s.lastExecuted)
  const [testText, setTestText] = useState('')

  const listening = voiceStatus === 'listening'
  const pushToTalk = voiceMode === 'push-to-talk'

  const micHandlers = pushToTalk
    ? {
        onPointerDown: () => void voice.startPushToTalk(),
        onPointerUp: () => voice.stopPushToTalkAndProcess(),
        onPointerLeave: () => {
          if (listening) voice.stopPushToTalkAndProcess()
        },
      }
    : { onClick: () => voice.toggleAlwaysListening() }

  const submitTest = (e: React.FormEvent) => {
    e.preventDefault()
    const t = testText.trim()
    if (!t) return
    setTestText('')
    void executeText(t, 'text')
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          {...micHandlers}
          disabled={!voice.isMicSupported}
          aria-label={
            pushToTalk
              ? 'Микрофон: удерживайте для записи'
              : 'Микрофон: переключить постоянное слушание'
          }
          aria-pressed={pushToTalk ? undefined : listening}
          className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-40',
            listening
              ? 'animate-pulse border-rose-300/60 bg-rose-500 text-white shadow-[0_0_26px_rgba(244,63,94,0.55)]'
              : 'border-amber-300/50 bg-amber-400 text-zinc-950 shadow-[0_0_18px_rgba(251,191,36,0.35)] hover:bg-amber-300',
          )}
        >
          <Mic className="h-6 w-6" aria-hidden />
        </button>
        <div className="min-w-0 hidden sm:block">
          <div
            className={cn(
              'truncate text-sm font-medium',
              listening && 'text-rose-400',
              voiceStatus === 'error' && 'text-rose-400',
            )}
            aria-live="polite"
          >
            {voiceStatus === 'executing' ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" aria-hidden />
                {statusLine(voiceStatus, voiceMessage)}
              </span>
            ) : (
              statusLine(voiceStatus, voiceMessage)
            )}
          </div>
          <div
            className={cn(
              'truncate text-xs',
              lastExecuted && !lastExecuted.result.success ? 'text-rose-400' : 'text-emerald-400/90',
            )}
          >
            {lastExecuted
              ? `${lastExecuted.result.success ? '✓' : '✗'} «${lastExecuted.raw}» — ${lastExecuted.result.message}`
              : 'Ctrl + Space — удерживайте для диктовки'}
          </div>
        </div>
      </div>

      <Select
        value={voiceMode}
        onValueChange={(v: string) => voice.setAlwaysListening(v === 'always-listening')}
      >
        <SelectTrigger
          aria-label="Режим микрофона"
          className="h-11 w-full shrink-0 border-zinc-800 bg-zinc-900/60 text-xs sm:w-[168px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-zinc-800 bg-zinc-900">
          <SelectItem value="push-to-talk">🎙 Рация (удерживать)</SelectItem>
          <SelectItem value="always-listening">📡 Постоянное слушание</SelectItem>
        </SelectContent>
      </Select>

      <form onSubmit={submitTest} className="flex min-w-0 flex-1 gap-1.5">
        <Input
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder="Тест команды без микрофона: следующая серия"
          aria-label="Тестовая текстовая команда"
          className="h-11 min-w-0 border-zinc-800 bg-zinc-900/60 text-sm placeholder:text-zinc-600 focus-visible:ring-amber-400/50"
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Выполнить команду"
          className="h-11 w-11 shrink-0 bg-amber-400 text-zinc-950 hover:bg-amber-300"
        >
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </form>
    </div>
  )
}
