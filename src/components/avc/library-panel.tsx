'use client'
/**
 * LibraryPanel — правая Sheet-панель «Библиотека YummyAnime» (thin client).
 *
 * Показывает ИЗБРАННОЕ с реального сайта (/api/yummy/favorites). Статусы
 * просмотра ведутся на сайте — панель честно сообщает об этом и даёт кнопку
 * «Открыть на сайте». Без сессии — приглашение войти.
 * Клик по карточке открывает аниме в приложении (по slug/id с сайта).
 */
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, ExternalLink, Heart, Loader2, RefreshCw } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { continueWatchingFromLast, getLastWatched, openAnimeByRef } from '@/lib/avc/executor'
import { siteProfileUrl } from '@/lib/avc/site-urls'
import { useAvcStore } from '@/lib/avc/store'
import type { YummyFavoriteItem, YummyFavoritesResult } from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export function LibraryPanel() {
  const open = useAvcStore((s) => s.favoritesOpen)
  const setOpen = useAvcStore((s) => s.setFavoritesOpen)
  const account = useAvcStore((s) => s.yummyAccount)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const [data, setData] = useState<YummyFavoritesResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastWatched, setLastWatched] = useState<ReturnType<typeof getLastWatched>>(null)

  const load = useCallback(
    async (refresh: boolean) => {
      if (account.state !== 'loggedIn') {
        setData({
          available: false,
          items: [],
          reason: 'Нет подтверждённой сессии YummyAnime',
          lastSync: null,
        })
        return
      }
      setLoading(true)
      try {
        const res = await avcApi.yummyFavorites(refresh)
        setData(res)
      } catch (e) {
        setData({
          available: false,
          items: [],
          reason: e instanceof Error ? e.message : 'Ошибка загрузки избранного',
          lastSync: null,
        })
      } finally {
        setLoading(false)
      }
    },
    [account.state],
  )

  useEffect(() => {
    if (open) {
      setLastWatched(getLastWatched())
      void load(false)
    }
  }, [open, load])

  const openAnime = (item: YummyFavoriteItem) => {
    if (!item.slug && item.animeId === null) return
    void openAnimeByRef({
      slug: item.slug ?? '',
      animeId: item.animeId,
      title: item.title,
    }).catch(() => {
      toast({ variant: 'destructive', description: 'Не удалось открыть тайтл' })
    })
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 border-zinc-800 bg-zinc-950 p-4 sm:max-w-md"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="h-5 w-5 text-amber-400" aria-hidden />
            Библиотека YummyAnime
          </SheetTitle>
          <SheetDescription className="text-xs text-zinc-500">
            Избранное с реального сайта. Статусы просмотра ведутся на сайте.
          </SheetDescription>
        </SheetHeader>

        {/* Продолжить просмотр (локальная сессионная метка приложения) */}
        {lastWatched && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Продолжить просмотр
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-zinc-100">{lastWatched.title}</div>
                {lastWatched.episode !== null && (
                  <div className="text-xs text-zinc-500">серия {lastWatched.episode}</div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => void continueWatchingFromLast()}
                className="min-h-11 shrink-0 gap-1.5 bg-amber-400 text-zinc-950 hover:bg-amber-300"
              >
                Продолжить
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Избранное на сайте
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Обновить избранное"
              disabled={loading}
              onClick={() => void load(true)}
              className="h-9 w-9 text-zinc-400 hover:text-amber-300"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Открыть профиль и избранное на сайте"
              onClick={() =>
                window.open(
                  siteProfileUrl(
                    useAvcStore.getState().settings.baseUrl,
                    account.state === 'loggedIn' ? account.user?.userId ?? null : null,
                  ),
                  '_blank',
                  'noopener',
                )
              }
              className="h-9 w-9 text-zinc-400 hover:text-amber-300"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>

        {/* Контент */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {account.state !== 'loggedIn' ? (
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
              <p className="text-zinc-300">
                Избранное живёт в вашем аккаунте YummyAnime. Войдите — и оно появится здесь.
              </p>
              <Button
                onClick={() => {
                  setOpen(false)
                  setAuthOpen(true)
                }}
                className="min-h-11 w-full gap-2 bg-amber-400 text-zinc-950 hover:bg-amber-300"
              >
                Войти через YummyAnime
              </Button>
            </div>
          ) : loading && !data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-amber-400" aria-hidden />
            </div>
          ) : data?.available ? (
            data.items.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                Избранное пока пусто — добавляйте тайтлы на сайте
              </p>
            ) : (
              <ul className="space-y-2 pb-2">
                {data.items.map((item, i) => (
                  <li key={`${item.slug ?? item.animeId ?? i}-${i}`}>
                    <button
                      onClick={() => openAnime(item)}
                      className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2 text-left transition-colors hover:border-amber-400/40 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                    >
                      {item.poster ? (
                        <img
                          src={item.poster}
                          alt=""
                          loading="lazy"
                          className="h-16 w-12 shrink-0 rounded-lg border border-zinc-800 object-cover"
                        />
                      ) : (
                        <span className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                          <Heart className="h-4 w-4 text-zinc-700" aria-hidden />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">
                        {item.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div
              className={cn(
                'rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-300',
              )}
            >
              <p className="mb-2">{data?.reason ?? 'Избранное недоступно'}</p>
              <p className="text-xs text-zinc-500">
                Сайт не отдаёт список избранного внешним запросам — управление только на
                сайте. Мы не показываем выдуманные данные.
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
