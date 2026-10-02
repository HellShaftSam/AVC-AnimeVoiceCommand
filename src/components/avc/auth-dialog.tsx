'use client'
/**
 * YummyLoginDialog — вход через РЕАЛЬНЫЙ сайт YummyAnime (thin client).
 *
 * Пароль НИКОГДА не вводится в этом приложении: на сайте вход защищён
 * капчей/2FA, поэтому логинимся там, а приложение подхватывает сессию:
 *   - Electron (EXE): главный процесс сам читает cookie yummyani.me из
 *     persistent-профиля webview и передаёт их на /api/yummy/session (мост).
 *   - Web (браузер/PWA): браузер не отдаёт cookie чужого домена — есть
 *     ручной путь: DevTools → Cookies → скопировать строку → вставить сюда.
 *
 * ВАЖНО (проверено живым сайтом): отдельной страницы /login НЕТ (404) —
 * форма «Вход» встроена в ГЛАВНУЮ страницу сайта, поэтому кнопка открывает её.
 */
import { useState } from 'react'
import {
  ChevronDown,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { refreshAccount } from '@/lib/avc/executor'
import { siteLoginUrl } from '@/lib/avc/site-urls'
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
  const [cookieOpen, setCookieOpen] = useState(false)
  const [cookieValue, setCookieValue] = useState('')

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
            : 'В веб-версии передайте cookie вручную (ниже) или используйте EXE-сборку',
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

  const applyCookie = async (cookie: string) => {
    setBusy(true)
    try {
      const snap = await avcApi.syncYummySession(cookie)
      setYummyAccount(snap)
      if (snap.state === 'loggedIn') {
        toast({ description: `Готово: ${snap.user?.username ?? 'вход подтверждён'}` })
        setCookieValue('')
        setCookieOpen(false)
        setOpen(false)
      } else {
        toast({
          variant: 'destructive',
          description:
            snap.message ??
            'Сайт не подтвердил сессию — скопируйте cookie ПОСЛЕ входа на сайт',
        })
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка передачи cookie',
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
      await applyCookie(cookie)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка моста сессии',
      })
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
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
            Откройте сайт: форма «Вход» находится вверху главной страницы (там же вход
            через Telegram / VK / Shikimori)
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-amber-400">2.</span>
            {hasElectronBridge()
              ? 'После входа EXE-сборка подхватит сессию автоматически'
              : 'Веб-версия: скопируйте cookie сайта (F12 → Application → Cookies) и вставьте ниже'}
          </li>
        </ol>

        <div className="flex flex-col gap-2">
          <Button
            onClick={() =>
              window.open(siteLoginUrl(useAvcStore.getState().settings.baseUrl), '_blank', 'noopener')
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

        {/* Ручной мост cookie — единственный способ для web-версии (браузер
            не отдаёт cookie чужого домена серверному адаптеру) */}
        {!hasElectronBridge() && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
            <button
              type="button"
              onClick={() => setCookieOpen((v) => !v)}
              aria-expanded={cookieOpen}
              className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium text-zinc-200 hover:text-amber-300"
            >
              <span className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-400" aria-hidden />
                Веб-версия: передать cookie вручную
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${cookieOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
            {cookieOpen && (
              <div className="space-y-2 border-t border-zinc-800 p-3">
                <p className="text-xs leading-relaxed text-zinc-400">
                  На открытой вкладке сайта: F12 → Application → Cookies →{' '}
                  <span className="text-zinc-200">yummyani.me</span> → скопируйте все пары
                  «имя=значение» одной строкой (например{' '}
                  <code className="text-amber-300/90">PHPSESSID=…; remember_web=…</code>) и
                  вставьте сюда. Cookie проверяется реальным сайтом и хранится только на
                  вашем сервере приложения.
                </p>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  aria-label="Строка cookie сайта yummyani.me"
                  placeholder="PHPSESSID=…; …"
                  className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950/80 p-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-400/60"
                />
                <Button
                  size="sm"
                  disabled={busy || cookieValue.trim().length < 8}
                  onClick={() => void applyCookie(cookieValue.trim())}
                  className="min-h-11 w-full gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  )}
                  Подтвердить и войти
                </Button>
              </div>
            )}
          </div>
        )}

        <p className="text-xs leading-relaxed text-zinc-600">
          В EXE-сборке сессия подхватывается автоматически из встроенного окна сайта и
          сохраняется между запусками. Пароли и cookie не хранятся в коде приложения.
        </p>
      </DialogContent>
    </Dialog>
  )
}
