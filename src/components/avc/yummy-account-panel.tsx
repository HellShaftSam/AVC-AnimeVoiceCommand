'use client'
/**
 * YummyAccountPanel — Sheet-панель «Аккаунт YummyAnime».
 *
 * Показывает реальные данные аккаунта сайта (old.yummyani.me):
 *  - профиль: аватар, ник, дата регистрации, время просмотра;
 *  - шесть списков сайта: Смотрю / В Планах / Просмотрено / Брошено / Любимые / Отложено
 *    (GET /api/yummy/lists/{0..5} → /api/users/{id}/lists/{n} на сайте);
 *  - карточки с постером/годом/рейтингом/датой добавления; клик — открыть аниме.
 * Без привязанного аккаунта — приглашение войти (AuthDialog, вкладка YummyAnime).
 */
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, ExternalLink, Heart, Loader2, RefreshCw, Star, UserRound } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, type YummyListItemDto } from '@/lib/avc/api'
import { openAnimeCard } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { AnimeCard } from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** Списки сайта (id фиксированы на стороне YummyAnime) */
const LIST_TABS: ReadonlyArray<{ id: number; title: string }> = [
  { id: 0, title: 'Смотрю' },
  { id: 1, title: 'В Планах' },
  { id: 2, title: 'Просмотрено' },
  { id: 3, title: 'Брошено' },
  { id: 4, title: 'Любимые' },
  { id: 5, title: 'Отложено' },
]

function formatDate(unixSec: number | null): string | null {
  if (!unixSec || unixSec <= 0) return null
  try {
    return new Date(unixSec * 1000).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return null
  }
}

export function YummyAccountPanel() {
  const open = useAvcStore((s) => s.yummyPanelOpen)
  const setOpen = useAvcStore((s) => s.setYummyPanelOpen)
  const yummyStatus = useAvcStore((s) => s.yummyStatus)
  const setYummyStatus = useAvcStore((s) => s.setYummyStatus)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)

  const [tab, setTab] = useState<number>(0)
  const [items, setItems] = useState<Record<number, YummyListItemDto[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const connected = yummyStatus?.connected ?? false
  const profile = yummyStatus?.profile ?? null

  const loadList = useCallback(
    async (listId: number, silent = false) => {
      setLoading(true)
      setError(null)
      try {
        const data = await avcApi.yummyListItems(listId)
        setItems((prev) => ({ ...prev, [listId]: data }))
      } catch (e) {
        if (!silent) {
          const msg = e instanceof Error && e.message ? e.message : 'Не удалось загрузить список'
          setError(msg)
          // 401 — сессия сайта истекла: сбрасываем статус, честно предлагаем войти
          if (msg.includes('войдите') || msg.includes('истекла')) {
            setYummyStatus({ connected: false, expired: true })
          }
        }
      } finally {
        setLoading(false)
      }
    },
    [setYummyStatus],
  )

  // Открытие панели: свежий статус аккаунта + первый список
  useEffect(() => {
    if (!open) return
    setFilter('')
    avcApi
      .yummyStatus()
      .then((st) => {
        setYummyStatus(st)
        if (st.connected) void loadList(tab, true)
      })
      .catch(() => undefined)
  }, [open])

  // Смена вкладки: грузим список (кэшируется на сессию панели)
  useEffect(() => {
    if (open && connected && items[tab] === undefined) void loadList(tab)
  }, [open, connected, tab])

  const list = (items[tab] ?? []).filter((it) =>
    filter.trim() === '' ? true : it.title.toLowerCase().includes(filter.trim().toLowerCase()),
  )

  const openItem = (it: YummyListItemDto) => {
    setOpen(false)
    const card: AnimeCard = {
      animeId: it.animeId,
      slug: it.slug,
      title: it.title,
      poster: it.poster,
      year: it.year,
      rating: it.rating,
      status: null,
      type: null,
    }
    void openAnimeCard(card, false)
  }

  const refresh = () => {
    setItems({})
    void loadList(tab)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 border-zinc-800 bg-zinc-950 sm:max-w-[440px]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2 text-zinc-100">
            <UserRound className="h-4 w-4 text-amber-400" aria-hidden />
            Аккаунт YummyAnime
          </SheetTitle>
          <SheetDescription className="text-zinc-500">
            Списки, любимые и оценки с сайта old.yummyani.me
          </SheetDescription>
        </SheetHeader>

        {!connected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <UserRound className="h-10 w-10 text-zinc-700" aria-hidden />
            <p className="text-sm text-zinc-400">
              Войдите в аккаунт YummyAnime, чтобы видеть свои списки и оценки с сайта
            </p>
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
          <>
            {/* Профиль */}
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              {profile?.avatar ? (
                <img
                  src={profile.avatar}
                  alt={`Аватар ${profile.nickname}`}
                  className="h-12 w-12 rounded-full border border-zinc-700 object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-400/20 text-amber-300">
                  <UserRound className="h-6 w-6" aria-hidden />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-zinc-100">{profile?.nickname}</p>
                <p className="text-xs text-emerald-400/90">Подключено · old.yummyani.me</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Обновить данные"
                  title="Обновить"
                  onClick={refresh}
                  disabled={loading}
                  className="h-9 w-9 rounded-full text-zinc-400 hover:text-amber-300"
                >
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Открыть профиль на сайте"
                  title="Профиль на сайте"
                  onClick={() => {
                    const id = profile?.id
                    window.open(
                      id ? `https://old.yummyani.me/users/id${id}` : 'https://old.yummyani.me',
                      '_blank',
                      'noopener',
                    )
                  }}
                  className="h-9 w-9 rounded-full text-zinc-400 hover:text-amber-300"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>

            {/* Вкладки списков */}
            <Tabs value={String(tab)} onValueChange={(v: string) => setTab(parseInt(v, 10))}>
              <TabsList className="avc-scroll flex w-full justify-start gap-1 overflow-x-auto bg-zinc-900/70 p-1">
                {LIST_TABS.map((t) => {
                  const count = items[t.id]?.length
                  return (
                    <TabsTrigger
                      key={t.id}
                      value={String(t.id)}
                      className="shrink-0 whitespace-nowrap px-2.5 text-xs data-[state=active]:text-amber-300"
                    >
                      {t.title}
                      {count !== undefined ? ` ${count}` : ''}
                    </TabsTrigger>
                  )
                })}
              </TabsList>
            </Tabs>

            {/* Поиск внутри списка */}
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Поиск в списке…"
              aria-label="Поиск аниме в списке"
              className="h-10 min-h-10 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
            />

            <div className="avc-scroll -mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 pb-4">
              {loading && items[tab] === undefined && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Загружаю список с сайта…
                </div>
              )}
              {!loading && error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
                  ✗ {error}
                  <div className="mt-2">
                    <Button variant="outline" size="sm" onClick={refresh} className="min-h-9 border-zinc-700">
                      Повторить
                    </Button>
                  </div>
                </div>
              )}
              {!error && list.length === 0 && !loading && (
                <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                  <BookOpen className="h-9 w-9 text-zinc-700" aria-hidden />
                  <p className="text-sm text-zinc-500">
                    {filter ? 'Ничего не найдено по фильтру' : 'Список пуст'}
                  </p>
                </div>
              )}
              {list.map((it) => (
                <YummyItemCard key={it.animeId} item={it} onOpen={() => openItem(it)} />
              ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Карточка аниме из списка сайта */
function YummyItemCard({ item, onOpen }: { item: YummyListItemDto; onOpen: () => void }) {
  const added = formatDate(item.addedAt)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Открыть ${item.title}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2.5 transition-colors hover:border-amber-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
    >
      {item.poster ? (
        <img
          src={item.poster}
          alt={`Постер: ${item.title}`}
          loading="lazy"
          className="h-20 w-14 shrink-0 rounded-md border border-zinc-800 object-cover"
        />
      ) : (
        <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-600">
          <BookOpen className="h-5 w-5" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-zinc-100">
          {item.title}
          {item.isFav && (
            <Heart className="ml-1 inline h-3.5 w-3.5 fill-rose-400 text-rose-400" aria-label="В любимых" />
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
          {item.year !== null && <span>{item.year}</span>}
          {item.rating !== null && item.rating > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-400/90">
              <Star className="h-3 w-3 fill-amber-400" aria-hidden />
              {item.rating.toFixed(1)}
            </span>
          )}
          {item.userRating > 0 && <span>моя: {item.userRating}</span>}
          {added && <span>добавлено {added}</span>}
        </p>
      </div>
    </div>
  )
}
