'use client'
/**
 * YummyLoginDialog — вход через РЕАЛЬНЫЙ сайт YummyAnime (thin client).
 *
 * Пароль НИКОГДА не вводится в этом приложении: на сайте вход защищён
 * hCaptcha, поэтому логинимся там (открываем сайт), а приложение после
 * входа:
 *   - web (PWA): пользователь нажимает «Я вошёл — проверить» → сервер
 *     адаптера… но браузер не может отдать cookie чужого домена, поэтому
 *     честно показываем статус: сессию видит только Electron-оболочка.
 *   - Electron: главный процесс сам читает cookie из persistent-профиля
 *     webview и передаёт их на /api/yummy/session (мост сессии), после чего
 *     аккаунт появляется здесь автоматически.
 */
import { useState } from 'react'
import { ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { refreshAccount } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Есть ли Electron-мост (появится в EXE-сборке) */
function hasElectronBridge(): boolean {
  return typeof window !== 'undefined' && 'avcElectron' in window
}

export function AuthDialog() {
  const open = useAvcStore((s) => s.authOpen)
  const setOpen = useAvcStore((s) => s.setAuthOpen)
  const setYummyAccount = useAvcStore((s) => s.setYummyAccount)
  const [busy, setBusy] = useState(false)

  const checkNow = async () => {
    setBusy(true)
    try {
      const snap = await refreshAccount(true)
      if (snap.state === 'loggedIn' && snap.user) {
        toast({ description: `Вы вошли как ${snap.user.username ?? 'без имени'}` })
        setOpen(false)
      } else if (snap.state === 'sessionExpired') {
        toast({ description: 'Сессия истекла — войдите на сайте ещё раз' })
      } else if (snap.state === 'unavailable') {
        toast({ variant: 'destructive', description: snap.message ?? 'Сайт недоступен' })
      } else {
        toast({
          description: hasElectronBridge()
            ? 'Сессия ещё не видна — войдите на сайте и попробуйте снова'
            : 'В веб-версии сессию видит только EXE-сборка (мост cookie из webview)',
        })
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка проверки',
      })
    } finally {
      setBusy(false)
    }
  }

  const syncFromElectron = async () => {
    setBusy(true)
    try {
      const bridge = (window as unknown as {
        avcElectron?: { syncYummySession?: () => Promise<string | null> }
      }).avcElectron
      const cookie = await bridge?.syncYummySession?.()
      if (!cookie) {
        toast({ description: 'Electron-мост не нашёл cookie yummyani.me — войдите на сайте' })
        return
      }
      const snap = await avcApi.syncYummySession(cookie)
      setYummyAccount(snap)
      if (snap.state === 'loggedIn') {
        toast({ description: `Готово: ${snap.user?.username ?? 'вход подтверждён'}` })
        setOpen(false)
      } else {
        toast({ description: snap.message ?? 'Сайт не подтвердил сессию' })
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка моста сессии',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-400" aria-hidden />
            Вход через YummyAnime
          </DialogTitle>
          <DialogDescription>
            Приложение работает с вашим РЕАЛЬНЫМ аккаунтом сайта: библиотека, статусы и
            избранное живут на YummyAnime. Пароль вводится только на сайте — приложение
            его не видит.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-300">
          <li className="flex gap-2">
            <span className="font-bold text-amber-400">1.</span>
            Откройте сайт и войдите там (капча/2FA — только на сайте)
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-amber-400">2.</span>
            Вернитесь сюда и нажмите «Я вошёл» — приложение проверит сессию
          </li>
        </ol>

        <div className="flex flex-col gap-2">
          <Button
            onClick={() =>
              window.open('https://old.yummyani.me/login', '_blank', 'noopener')
            }
            className="min-h-11 gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Открыть сайт для входа
          </Button>

          {hasElectronBridge() && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void syncFromElectron()}
              className="min-h-11 gap-2 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Синхронизировать сессию из webview
            </Button>
          )}

          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void checkNow()}
            className="min-h-11 gap-2 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Я вошёл — проверить
          </Button>
        </div>

        <p className="text-xs leading-relaxed text-zinc-600">
          В EXE-сборке сессия подхватывается автоматически из встроенного окна сайта и
          сохраняется между запусками. Пароли и cookie не хранятся в коде приложения.
        </p>
      </DialogContent>
    </Dialog>
  )
}
