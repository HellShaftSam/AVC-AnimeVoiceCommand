'use client'
/**
 * AuthDialog — «Вход через YummyAnime» (спецификация, секция 4).
 *
 * Пароль НИКОГДА не вводится и не хранится в приложении: вход выполняется
 * ТОЛЬКО на сайте, в его собственном окне (капча/2FA — тоже на сайте):
 *   - EXE: openLoginWindow() открывает окно сайта через мост; сессия живёт
 *     в постоянном браузерном профиле оболочки (partition persist:yummyanime)
 *     и не покидает main-процесс. Резолв промиса — после закрытия окна.
 *   - Web: постоянной сессии нет — честно сообщаем о недоступности и
 *     предлагаем открыть сайт в обычной вкладке (без обещаний синхронизации).
 *
 * Cookie-мост (ручная вставка cookie) УДАЛЁН — запрещён спекой (секции 15/16):
 * приложение не принимает, не показывает и не передаёт cookie/токены.
 *
 * ВАЖНО (проверено живым сайтом): отдельной страницы /login НЕТ (404) —
 * форма «Вход» встроена в ГЛАВНУЮ страницу сайта, поэтому кнопка открывает её.
 */
import { useEffect, useState } from 'react'
import {
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, getElectronBridge } from '@/lib/avc/api'
import { siteLoginUrl } from '@/lib/avc/site-urls'
import { useAvcStore } from '@/lib/avc/store'
import type { YummyAccountSnapshot } from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function AuthDialog() {
  const open = useAvcStore((s) => s.authOpen)
  const setOpen = useAvcStore((s) => s.setAuthOpen)
  const setYummyAccount = useAvcStore((s) => s.setYummyAccount)

  // Мост есть только в EXE-сборке; определяем после гидрации (SSR-safe)
  const [hasBridge, setHasBridge] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [webCheckBusy, setWebCheckBusy] = useState(false)

  useEffect(() => {
    setHasBridge(getElectronBridge() !== null)
  }, [])

  /** Применить снапшот: в store + toast; при подтверждённом входе закрыть диалог */
  const applySnapshot = (snap: YummyAccountSnapshot, closeOnLogin: boolean) => {
    setYummyAccount(snap)
    if (snap.state === 'loggedIn') {
      toast({ description: `Вы вошли как ${snap.user?.username ?? 'без имени'}` })
      if (closeOnLogin) setOpen(false)
      return
    }
    toast({
      variant: 'destructive',
      description:
        snap.message ?? 'Сайт не подтвердил вход — завершите вход на сайте и попробуйте снова',
    })
  }

  /** EXE: открыть окно сайта для входа; промис резолвится ПОСЛЕ его закрытия */
  const loginViaSite = async () => {
    setLoginBusy(true)
    try {
      const snap = await avcApi.openLoginWindow()
      applySnapshot(snap, true)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Не удалось открыть окно входа',
      })
    } finally {
      setLoginBusy(false)
    }
  }

  /** EXE: полная проверка аутентификации через сайт (verifyAuthentication) */
  const verifyNow = async () => {
    setVerifyBusy(true)
    try {
      const snap = await avcApi.verifyAuthentication()
      applySnapshot(snap, true)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка проверки аккаунта',
      })
    } finally {
      setVerifyBusy(false)
    }
  }

  /** Web: честная проверка — вернёт «недоступно», сессия живёт в EXE-сборке */
  const checkWeb = async () => {
    setWebCheckBusy(true)
    try {
      const snap = await avcApi.yummyAccount(true)
      applySnapshot(snap, false)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка проверки',
      })
    } finally {
      setWebCheckBusy(false)
    }
  }

  /** Открыть главную сайта: форма «Вход» встроена в неё (/login на сайте = 404) */
  const openSite = () => {
    window.open(siteLoginUrl(useAvcStore.getState().settings.baseUrl), '_blank', 'noopener')
  }

  const anyBusy = loginBusy || verifyBusy

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-400" aria-hidden />
            Вход через YummyAnime
          </DialogTitle>
          <DialogDescription>
            Войдите защищённо на YummyAnime: пароль вводится только на сайте, в его
            собственном окне — приложение пароль не видит. Аккаунт, статусы и избранное
            живут на YummyAnime.
          </DialogDescription>
        </DialogHeader>

        {hasBridge ? (
          <>
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => void loginViaSite()}
                disabled={anyBusy}
                className="min-h-11 w-full gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
              >
                {loginBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                Войти через YummyAnime
              </Button>

              <Button
                variant="outline"
                disabled={anyBusy}
                onClick={() => void verifyNow()}
                className="min-h-11 gap-2 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
              >
                {verifyBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                Проверить аккаунт
              </Button>
            </div>

            {loginBusy && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs leading-relaxed text-amber-200"
              >
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                Открыто окно сайта — завершите вход там. Это окно закроется автоматически
                после входа.
              </p>
            )}

            <p className="text-xs leading-relaxed text-zinc-500">
              Форма «Вход» находится вверху главной страницы сайта (там же вход через
              Telegram / VK / Shikimori). Сессия сохраняется в постоянном профиле сайта
              и переживёт перезапуск приложения.
            </p>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
              <p className="flex items-start gap-2 text-sm leading-relaxed text-zinc-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                Постоянная сессия сайта живёт в EXE-сборке — в веб-режиме вход в аккаунт
                недоступен.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                onClick={openSite}
                className="min-h-11 gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                Открыть сайт для входа
              </Button>

              <Button
                variant="outline"
                disabled={webCheckBusy}
                onClick={() => void checkWeb()}
                className="min-h-11 gap-2 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
              >
                {webCheckBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                Проверить
              </Button>
            </div>
          </>
        )}

        <p className="text-xs leading-relaxed text-zinc-600">
          Безопасность: пароли и cookie не хранятся в приложении. Вход выполняется на
          сайте, а сессия живёт в постоянном профиле сайта внутри EXE-сборки и не
          покидает её.
        </p>
      </DialogContent>
    </Dialog>
  )
}
