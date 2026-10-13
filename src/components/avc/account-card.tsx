'use client'
/**
 * AccountCard (Task 17) — карточка РЕАЛЬНОГО аккаунта YummyAnime (спека #36
 * «открой мой профиль»). Реальный аватар (URL сайта, кэш браузера — спека #9:
 * не дублируем картинку лишними загрузками), реальный ник, ссылка на профиль
 * сайта, статус синхронизации, выход.
 */
import { ExternalLink, Loader2, LogOut, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useAvcStore } from '@/lib/avc/store'
import { formatLastSync, useYummyStore } from '@/lib/avc/yummy-store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function AccountCard() {
  const open = useAvcStore((s) => s.accountCardOpen)
  const setOpen = useAvcStore((s) => s.setAccountCardOpen)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const authState = useYummyStore((s) => s.authState)
  const profile = useYummyStore((s) => s.profile)
  const checking = useYummyStore((s) => s.checking)
  const lastSync = useYummyStore((s) => s.listsLastSync)
  const stale = useYummyStore((s) => s.listsStale)
  const manualRefresh = useYummyStore((s) => s.manualRefresh)
  const logout = useYummyStore((s) => s.logout)
  const expired = useYummyStore((s) => s.sessionExpiredNotice)
  const clearExpired = useYummyStore((s) => s.clearExpiredNotice)

  const handleLogout = async () => {
    setOpen(false)
    await logout()
    toast({ description: 'Вы вышли из аккаунта YummyAnime' })
  }

  const stateLabel =
    authState === 'logged_in'
      ? 'Сессия активна'
      : authState === 'session_expired'
        ? 'Сессия истекла'
        : authState === 'checking'
          ? 'Проверка…'
          : authState === 'logged_out'
            ? 'Не вошли'
            : 'Неизвестно'

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) clearExpired()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Аккаунт YummyAnime</DialogTitle>
          <DialogDescription>
            Данные берутся напрямую с реального сайта (источник истины)
          </DialogDescription>
        </DialogHeader>

        {!profile || (authState !== 'logged_in' && authState !== 'session_expired') ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-sm text-zinc-400">Нет активной сессии YummyAnime</p>
            <Button
              className="min-h-11 bg-amber-400 text-zinc-950 hover:bg-amber-300"
              onClick={() => {
                setOpen(false)
                setAuthOpen(true)
              }}
            >
              Войти
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={`Аватар ${profile.nickname}`}
                  loading="lazy"
                  className="h-16 w-16 rounded-full border border-zinc-800 object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-xl font-bold text-amber-300">
                  {profile.nickname.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-zinc-100">
                  {profile.nickname}
                </p>
                <p className="text-xs text-zinc-500">ID: {profile.id}</p>
                <p
                  className={cn(
                    'mt-0.5 flex items-center gap-1 text-xs',
                    authState === 'logged_in' ? 'text-emerald-400' : 'text-amber-400',
                  )}
                >
                  {authState === 'logged_in' ? (
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {stateLabel}
                </p>
              </div>
            </div>

            {expired && (
              <p className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Сессия YummyAnime истекла. Войдите снова.
              </p>
            )}

            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span aria-live="polite">
                Закладки: {stale ? 'офлайн-кэш, ' : ''}обновлено {formatLastSync(lastSync)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Синхронизировать аккаунт"
                className="h-8 gap-1.5 px-2 text-xs text-zinc-400 hover:text-amber-300"
                onClick={() => void manualRefresh()}
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
                Синхронизировать
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="min-h-11 gap-1.5 border-zinc-700 hover:border-amber-400/50 hover:text-amber-300"
                onClick={() => window.open(profile.profileUrl, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                Профиль на сайте
              </Button>
              <Button
                variant="outline"
                className="min-h-11 gap-1.5 border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                onClick={() => void handleLogout()}
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Выйти
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
