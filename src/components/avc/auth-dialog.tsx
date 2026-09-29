'use client'
/**
 * AuthDialog — вход/регистрация (управляется store: authOpen/setAuthOpen).
 *
 * Регистрация на бэкенде автоматически логинит (ставит сессию-cookie),
 * поэтому после обеих форм выполняем одинаковую последовательность:
 * setUser → закрыть диалог → загрузить library + aliases в store → toast.
 */
import { useState } from 'react'
import { Loader2, LogIn, UserPlus } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type AuthTab = 'login' | 'register'

export function AuthDialog() {
  const open = useAvcStore((s) => s.authOpen)
  const setOpen = useAvcStore((s) => s.setAuthOpen)
  const [tab, setTab] = useState<AuthTab>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isLogin = tab === 'login'

  const submit = async () => {
    const u = username.trim()
    if (!u || !password) {
      setError('Введите имя пользователя и пароль')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const user = isLogin ? await avcApi.login(u, password) : await avcApi.register(u, password)
      const st = useAvcStore.getState()
      st.setUser(user)
      setOpen(false)
      setPassword('')
      // Догружаем данные аккаунта в store (ошибки не блокируют вход)
      try {
        st.setLibrary(await avcApi.library())
      } catch {
        /* библиотека подгрузится при следующем открытии панели */
      }
      try {
        st.setVoiceAliases(await avcApi.aliases())
      } catch {
        /* алиасы не критичны */
      }
      toast({
        description: isLogin
          ? `С возвращением, ${user.username}!`
          : `Добро пожаловать, ${user.username}! Аккаунт создан.`,
      })
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : isLogin
            ? 'Неверный логин или пароль'
            : 'Не удалось зарегистрироваться',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isLogin ? 'Вход' : 'Регистрация'}</DialogTitle>
          <DialogDescription>
            Аккаунт синхронизирует библиотеку и алиасы озвучек между устройствами.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v: string) => {
            setTab(v === 'register' ? 'register' : 'login')
            setError(null)
          }}
        >
          <TabsList className="grid w-full grid-cols-2 bg-zinc-900">
            <TabsTrigger value="login" className="min-h-9 data-[state=active]:text-amber-300">
              Вход
            </TabsTrigger>
            <TabsTrigger value="register" className="min-h-9 data-[state=active]:text-amber-300">
              Регистрация
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="avc-auth-username" className="text-zinc-300">
              Имя пользователя
            </Label>
            <Input
              id="avc-auth-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="otaku_2007"
              aria-label="Имя пользователя"
              className="h-11 min-h-11 border-zinc-800 bg-zinc-900 focus-visible:ring-amber-400/50"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="avc-auth-password" className="text-zinc-300">
              Пароль
            </Label>
            <Input
              id="avc-auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              placeholder="Минимум 4 символа"
              aria-label="Пароль"
              className="h-11 min-h-11 border-zinc-800 bg-zinc-900 focus-visible:ring-amber-400/50"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-rose-400">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy}
            aria-label={isLogin ? 'Войти' : 'Зарегистрироваться'}
            className="min-h-11 w-full gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : isLogin ? (
              <LogIn className="h-4 w-4" aria-hidden />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden />
            )}
            {isLogin ? 'Войти' : 'Создать аккаунт'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
