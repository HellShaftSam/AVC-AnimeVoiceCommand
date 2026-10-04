'use client'
/**
 * HeaderBar — заголовок приложения: логотип слева, библиотека/аккаунт,
 * режим дивана/debug/справка/настройки/скачать справа.
 *
 * Аккаунт — РЕАЛЬНАЯ сессия YummyAnime (thin client): аватар и имя берутся
 * с сайта, вход выполняется на сайте (диалог входа), локального аккаунта нет.
 */
import { useEffect, useState } from 'react'
import {
  Armchair,
  BookOpen,
  Bug,
  CircleHelp,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Mic,
  PackageOpen,
  RefreshCw,
  Settings,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { accountLogout, checkAccount, refreshAccount } from '@/lib/avc/executor'
import { siteProfileUrl } from '@/lib/avc/site-urls'
import { getElectronBridge } from '@/lib/avc/api'
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
import { ToastAction } from '@/components/ui/toast'
import { DevConsole, DevGate, isDevUnlocked } from './dev-console'

/** Цвет точки статуса сессии */
function statusDotClass(state: string): string {
  switch (state) {
    case 'loggedIn':
      return 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
    case 'checking':
      return 'bg-sky-400 animate-pulse'
    case 'sessionExpired':
      return 'bg-rose-400'
    case 'unavailable':
      return 'bg-zinc-500'
    default:
      return 'bg-zinc-600'
  }
}

export function HeaderBar() {
  const couchMode = useAvcStore((s) => s.settings.couchMode)
  const setDebugOpen = useAvcStore((s) => s.setDebugOpen)
  const setHelpOpen = useAvcStore((s) => s.setHelpOpen)
  const setSettingsOpen = useAvcStore((s) => s.setSettingsOpen)
  const setFavoritesOpen = useAvcStore((s) => s.setFavoritesOpen)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const debugOpen = useAvcStore((s) => s.debugOpen)
  const helpOpen = useAvcStore((s) => s.helpOpen)
  const settingsOpen = useAvcStore((s) => s.settingsOpen)
  const account = useAvcStore((s) => s.yummyAccount)
  const [loggingOut, setLoggingOut] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [devGateOpen, setDevGateOpen] = useState(false)
  const [devConsoleOpen, setDevConsoleOpen] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)

  /**
   * ОбНОВЛЕНИЕ одной кнопкой: EXE — проверить GitHub releases против своей
   * версии и, если новее, скачать и подменить себя с перезапуском; в браузере
   * (превью) — честный fallback: скачать свежий EXE со страницы релизов.
   */
  const runUpdate = async () => {
    if (updateBusy) return
    const aiBridge = getElectronBridge()
    const bridge = aiBridge as unknown as {
      checkUpdate?: () => Promise<{
        current: string
        latest: string | null
        available: boolean
        assetUrl: string | null
        assetName: string | null
        releasesUrl: string
        error?: string
      }>
      installUpdate?: (url: string) => Promise<{ ok: boolean; error?: string }>
    }
    setUpdateBusy(true)
    try {
      if (bridge?.checkUpdate && bridge?.installUpdate) {
        const info = await bridge.checkUpdate()
        if (info.error) {
          toast({ variant: 'destructive', description: `Обновление: ${info.error}` })
          return
        }
        if (!info.available) {
          toast({ description: `У вас последняя версия (${info.current})` })
          return
        }
        toast({ description: `Доступна ${info.latest} — скачиваю… приложение перезапустится само` })
        bridge.onUpdateProgress?.((p) => {
          if (p.phase === 'downloading' && p.percent != null) {
            setUpdateProgress(p.percent)
          }
        })
        const res = await bridge.installUpdate(info.assetUrl ?? '')
        if (!res.ok) toast({ variant: 'destructive', description: `Не удалось обновиться: ${res.error ?? 'ошибка'}` })
        return
      }
      // web-режим: просто скачать последний EXE
      const res = await fetch('/api/download-exe', { cache: 'no-store' })
      const info = (await res.json()) as {
        ok: boolean
        downloadUrl: string | null
        assetName: string | null
        reason: string | null
        releasesUrl: string
      }
      if (info.ok && info.downloadUrl) {
        toast({ description: `Скачивание началось: ${info.assetName ?? 'AVC-Anime.exe'}` })
        const a = document.createElement('a')
        a.href = info.downloadUrl
        a.rel = 'noopener'
        a.download = info.assetName ?? 'AVC-Anime.exe'
        document.body.appendChild(a)
        a.click()
        a.remove()
      } else {
        toast({
          variant: 'destructive',
          description: info.reason ?? 'EXE не найден',
          action: (
            <ToastAction
              altText="Открыть страницу релизов"
              onClick={() => window.open(info.releasesUrl, '_blank', 'noopener')}
            >
              Открыть релизы
            </ToastAction>
          ),
        })
      }
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось проверить обновления' })
    } finally {
      setUpdateBusy(false)
      setUpdateProgress(null)
    }
  }

  // Первичная проверка аккаунта при монтировании шапки (не блокирует UI)
  useEffect(() => {
    if (account.state === 'unknown') {
      void refreshAccount(false).catch(() => undefined)
    }
  }, [])

  const logout = async () => {
    setLoggingOut(true)
    try {
      await accountLogout()
      toast({ description: 'Вы вышли из аккаунта YummyAnime' })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось выйти — попробуйте ещё раз' })
    } finally {
      setLoggingOut(false)
    }
  }

  const checkNow = async () => {
    try {
      const res = await checkAccount()
      if (res.message) toast({ description: res.message })
    } catch {
      /* checkAccount сам обрабатывает ошибки */
    }
  }

  const user = account.user
  const loggedIn = account.state === 'loggedIn' && user !== null

  return (
    <header className="glass flex items-center justify-between gap-3 border-b border-cyan-200/10 px-3 py-2 sm:px-4">
      <h1 className="avc-title-glow flex min-w-0 items-center gap-2 text-base font-bold sm:text-lg">
        <Mic className="h-5 w-5 shrink-0 text-sky-400" aria-hidden />
        <span className="truncate">
          Anime <span className="text-sky-400">Voice</span> Controller
        </span>
      </h1>
      <nav className="flex items-center gap-1" aria-label="Панель инструментов">
        {/* Библиотека YummyAnime (избранное с сайта) */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Библиотека YummyAnime"
          title="Библиотека YummyAnime"
          className="h-11 w-11"
          onClick={() => setFavoritesOpen(true)}
        >
          <BookOpen className="h-5 w-5" />
        </Button>

        {/* Аккаунт YummyAnime: чип с аватаром или кнопка «Войти» */}
        {loggedIn ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={`Аккаунт YummyAnime: ${user.username ?? ''}`}
                className="h-11 min-h-11 gap-1.5 px-2.5 text-foreground hover:text-sky-300"
              >
                <span className="relative shrink-0">
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="h-6 w-6 rounded-full border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-secondary text-xs font-bold text-sky-300">
                      {(user.username ?? '?').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full',
                      statusDotClass(account.state),
                    )}
                    aria-hidden
                  />
                </span>
                <span className="hidden max-w-28 truncate sm:inline">
                  {user.username ?? 'Аккаунт'}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-card">
              <DropdownMenuLabel className="text-muted-foreground">
                YummyAnime:{' '}
                <span className="text-foreground">{user.username ?? 'без имени'}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-secondary" />
              <DropdownMenuItem
                onClick={() => {
                  const base = useAvcStore.getState().settings.baseUrl
                  // /profile на сайте НЕТ (404): при известном id — /users/id{N}, иначе главная
                  window.open(siteProfileUrl(base, user.userId), '_blank', 'noopener')
                }}
                className="gap-2"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                Открыть профиль на сайте
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void checkNow()} className="gap-2">
                <RefreshCw className="h-4 w-4" aria-hidden />
                Проверить аккаунт
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-secondary" />
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
            aria-label="Войти через YummyAnime"
            className={cn(
              'min-h-11 gap-1.5 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300',
              account.state === 'sessionExpired' && 'border-rose-400/40 text-rose-300',
            )}
            onClick={() => setAuthOpen(true)}
          >
            {account.state === 'sessionExpired' ? (
              <KeyRound className="h-4 w-4" aria-hidden />
            ) : (
              <LogIn className="h-4 w-4" aria-hidden />
            )}
            <span className="hidden sm:inline">
              {account.state === 'sessionExpired' ? 'Сессия истекла' : 'Войти'}
            </span>
          </Button>
        )}

        {!couchMode && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Отладочная панель"
            title="Отладка"
            className={cn('h-11 w-11', debugOpen && 'text-sky-400')}
            onClick={() => {
              if (isDevUnlocked()) setDevConsoleOpen(true)
              else setDevGateOpen(true)
            }}
          >
            <Bug className="h-5 w-5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Справка по командам"
          title="Справка"
          className={cn('h-11 w-11', helpOpen && 'text-sky-400')}
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Настройки"
          title="Настройки"
          className={cn('h-11 w-11', settingsOpen && 'text-sky-400')}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-5 w-5" />
        </Button>
        {/* Обновление: EXE проверяет релизы и обновляет себя; web — скачать EXE */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Обновление приложения"
          title={updateProgress != null ? `Скачивание обновления… ${updateProgress}%` : 'Обновление приложения'}
          className="h-11 w-11"
          disabled={updateBusy}
          onClick={() => void runUpdate()}
        >
          {updateBusy ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : updateProgress != null ? (
            <span className="text-[10px] font-bold tabular-nums text-sky-300">{updateProgress}%</span>
          ) : (
            <RefreshCw className="h-5 w-5" />
          )}
        </Button>
      </nav>

      {/* Панель разработчика: доступ только по секретному коду */}
      <DevGate open={devGateOpen} onClose={() => setDevGateOpen(false)} onUnlocked={() => {
        setDevGateOpen(false)
        setDevConsoleOpen(true)
      }} />
      <DevConsole open={devConsoleOpen} onClose={() => setDevConsoleOpen(false)} />
    </header>
  )
}
