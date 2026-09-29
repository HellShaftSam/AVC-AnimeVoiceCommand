'use client'
/**
 * HeaderBar — заголовок приложения: логотип слева, режим дивана/debug/справка/настройки справа.
 */
import { Armchair, Bug, CircleHelp, Mic, Settings } from 'lucide-react'
import { useAvcStore } from '@/lib/avc/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function HeaderBar() {
  const couchMode = useAvcStore((s) => s.settings.couchMode)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const setDebugOpen = useAvcStore((s) => s.setDebugOpen)
  const setHelpOpen = useAvcStore((s) => s.setHelpOpen)
  const setSettingsOpen = useAvcStore((s) => s.setSettingsOpen)
  const debugOpen = useAvcStore((s) => s.debugOpen)
  const helpOpen = useAvcStore((s) => s.helpOpen)
  const settingsOpen = useAvcStore((s) => s.settingsOpen)

  return (
    <header className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2 sm:px-4">
      <h1 className="flex min-w-0 items-center gap-2 text-base font-bold sm:text-lg">
        <Mic className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        <span className="truncate">
          Anime <span className="text-amber-400">Voice</span> Controller
        </span>
      </h1>
      <nav className="flex items-center gap-1" aria-label="Панель инструментов">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Режим дивана (крупный интерфейс)"
          aria-pressed={couchMode}
          title="Режим дивана"
          className={cn('h-11 w-11', couchMode && 'text-amber-400')}
          onClick={() => updateSettings({ couchMode: !couchMode })}
        >
          <Armchair className="h-5 w-5" />
        </Button>
        {!couchMode && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Отладочная панель"
            title="Отладка"
            className={cn('h-11 w-11', debugOpen && 'text-amber-400')}
            onClick={() => setDebugOpen(true)}
          >
            <Bug className="h-5 w-5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Справка по командам"
          title="Справка"
          className={cn('h-11 w-11', helpOpen && 'text-amber-400')}
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Настройки"
          title="Настройки"
          className={cn('h-11 w-11', settingsOpen && 'text-amber-400')}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-5 w-5" />
        </Button>
      </nav>
    </header>
  )
}
