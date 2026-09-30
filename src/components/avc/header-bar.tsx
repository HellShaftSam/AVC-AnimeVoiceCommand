'use client'
/**
 * HeaderBar — заголовок приложения: логотип слева, библиотека/аккаунт,
 * режим дивана/debug/справка/настройки справа.
 */
import { useState } from 'react'
import {
  Armchair,
  BookOpen,
  Bug,
  CircleHelp,
  Loader2,
  LogIn,
  LogOut,
  Mic,
  Settings,
  User,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function HeaderBar() {
  const couchMode = useAvcStore((s) => s.settings.couchMode)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const setDebugOpen = useAvcStore((s) => s.setDebugOpen)
  const setHelpOpen = useAvcStore((s) => s.setHelpOpen)
  const setSettingsOpen = useAvcStore((s) => s.setSettingsOpen)
  const setLibraryOpen = useAvcStore((s) => s.setLibraryOpen)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const debugOpen = useAvcStore((s) => s.debugOpen)
  const helpOpen = useAvcStore((s) => s.helpOpen)
  const settingsOpen = useAvcStore((s) => s.settingsOpen)
  const libraryCount = useAvcStore((s) => s.library.length)
  const user = useAvcStore((s) => s.user)
  const [loggingOut, setLoggingOut] = useState(false)

  const logout = async () => {
    setLoggingOut(true)
    try {
      await avcApi.logout()
      const st = useAvcStore.getState()
      st.setUser(null)
      st.setLibrary([])
      st.setVoiceAliases([])
      toast({ description: 'Вы вышли из аккаунта' })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось выйти — попробуйте ещё раз' })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <header className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2 sm:px-4">
      <h1 className="flex min-w-0 items-center gap-2 text-base font-bold sm:text-lg">
        <Mic className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        <span className="truncate">
          Anime <span className="text-amber-400">Voice</span> Controller
        </span>
      </h1>
      <nav className="flex items-center gap-1" aria-label="Панель инструментов">
        {/* Библиотека */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Библиотека"
          title="Библиотека"
          className={cn('relative h-11 w-11', libraryCount > 0 && 'text-amber-300')}
          onClick={() => setLibraryOpen(true)}
        >
          <BookOpen className="h-5 w-5" />
          {libraryCount > 0 && (
            <span
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]"
              aria-hidden
            />
          )}
        </Button>

        {/* Аккаунт: чип с dropdown или кнопка «Войти» */}
        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={`Аккаунт: ${user.username}`}
                className="h-11 min-h-11 gap-1.5 px-2.5 text-zinc-200 hover:text-amber-300"
              >
                <User className="h-4 w-4" aria-hidden />
                <span className="hidden max-w-28 truncate sm:inline">{user.username}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
              <DropdownMenuLabel className="text-zinc-400">
                Вы вошли как{' '}
                <span className="text-zinc-100">{user.username}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-zinc-800" />
              <DropdownMenuItem
                disabled={loggingOut}
                onClick={() => void logout()}
                className="gap-2 text-rose-300 focus:text-rose-300"
              >
                {loggingOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <LogOut className="h-4 w-4" aria-hidden />
                )}
                Выйти
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label="Войти в аккаунт"
            className="min-h-11 gap-1.5 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            onClick={() => setAuthOpen(true)}
          >
            <LogIn className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Войти</span>
          </Button>
        )}

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
