'use client'
/**
 * BookmarksPanel (Task 17) — панель РЕАЛЬНЫХ закладок/списков YummyAnime.
 *
 * Данные — серверные списки сайта (GET /api/users/{id}/lists), синхронизируются
 * YummySyncService: TTL 2 мин, hash-детект, офлайн → кэш с плашкой (спека #25).
 * Табы по типам списков сайта: Все | Смотрю | В планах | Просмотрено |
 * Брошено | Любимые | Отложено. Клик по карточке открывает аниме.
 * Кнопка «Синхронизировать» — ручной refresh (спека #41).
 */
import { useMemo, useState } from 'react'
import { ExternalLink, Heart, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { openAnimeCard } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import {
  formatLastSync,
  useYummyStore,
  type YummyListItemDto,
} from '@/lib/avc/yummy-store'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** id списков сайта (см. account-adapter YUMMY_LISTS) */
const LIST_TABS: { value: string; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: '0', label: 'Смотрю' },
  { value: '1', label: 'В планах' },
  { value: '2', label: 'Просмотрено' },
  { value: '3', label: 'Брошено' },
  { value: '4', label: 'Любимые' },
  { value: '5', label: 'Отложено' },
]

const LIST_BADGE: Record<number, { label: string; className: string }> = {
  0: { label: 'Смотрю', className: 'bg-rose-500/15 text-rose-300' },
  1: { label: 'В планах', className: 'bg-purple-500/15 text-purple-300' },
  2: { label: 'Просмотрено', className: 'bg-emerald-500/15 text-emerald-300' },
  3: { label: 'Брошено', className: 'bg-zinc-500/15 text-zinc-300' },
  4: { label: 'Любимое', className: 'bg-pink-500/15 text-pink-300' },
  5: { label: 'Отложено', className: 'bg-amber-500/15 text-amber-300' },
}

export function BookmarksPanel() {
  const open = useAvcStore((s) => s.bookmarksOpen)
  const setOpen = useAvcStore((s) => s.setBookmarksOpen)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const authState = useYummyStore((s) => s.authState)
  const lists = useYummyStore((s) => s.lists)
  const syncing = useYummyStore((s) => s.listsSyncing)
  const stale = useYummyStore((s) => s.listsStale)
  const error = useYummyStore((s) => s.listsError)
  const lastSync = useYummyStore((s) => s.listsLastSync)
  const openBookmarks = useYummyStore((s) => s.openBookmarks)
  const manualRefresh = useYummyStore((s) => s.manualRefresh)
  const [tab, setTab] = useState('all')

  // при открытии панели — точечный sync (TTL 2 мин на сервере, trigger D)
  const handleOpen = (v: boolean) => {
    setOpen(v)
    if (v) void openBookmarks()
  }

  const items = useMemo(
    () =>
      (tab === 'all' ? lists : lists.filter((i) => String(i.listId) === tab)).sort(
        (a, b) => (b.siteDate ?? 0) - (a.siteDate ?? 0),
      ),
    [lists, tab],
  )

  const counts = useMemo(() => {
    const map = new Map<number, number>()
    for (const i of lists) map.set(i.listId, (map.get(i.listId) ?? 0) + 1)
    return map
  }, [lists])

  return (
    <Sheet open={open} onOpenChange={handleOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 border-zinc-800 bg-zinc-950 sm:max-w-[460px]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2 text-zinc-100">
            <Heart className="h-4 w-4 text-pink-400" aria-hidden />
            Закладки YummyAnime
          </SheetTitle>
          <SheetDescription className="text-zinc-500">
            Реальные списки вашего аккаунта сайта
          </SheetDescription>
        </SheetHeader>

        {authState !== 'logged_in' && authState !== 'session_expired' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <Heart className="h-10 w-10 text-zinc-700" aria-hidden />
            <p className="text-sm text-zinc-400">
              Войдите в аккаунт YummyAnime, чтобы видеть свои закладки с сайта
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
            {/* Строка синхронизации: статус, время, ручной refresh (спека #41) */}
            <div className="flex items-center justify-between gap-2 px-1 text-xs text-zinc-500">
              <span aria-live="polite">
                {syncing
                  ? 'Синхронизация…'
                  : stale
                    ? `Офлайн · Синхронизировано: ${formatLastSync(lastSync)}`
                    : `Обновлено: ${formatLastSync(lastSync)}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Синхронизировать закладки"
                className="h-8 gap-1.5 px-2 text-xs text-zinc-400 hover:text-amber-300"
                onClick={() => void manualRefresh()}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
                Обновить
              </Button>
            </div>

            {error && error !== 'session_expired' && (
              <p className="mx-1 flex items-center gap-1.5 text-xs text-amber-400/90">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {error}
              </p>
            )}

            <Tabs value={tab} onValueChange={(v: string) => setTab(v)}>
              <TabsList className="avc-scroll flex w-full justify-start gap-1 overflow-x-auto bg-zinc-900/70 p-1">
                {LIST_TABS.map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="shrink-0 whitespace-nowrap px-2.5 text-xs data-[state=active]:text-amber-300"
                  >
                    {t.label}
                    {t.value !== 'all' && (counts.get(Number(t.value)) ?? 0) > 0 && (
                      <span className="ml-1 text-zinc-500">
                        {counts.get(Number(t.value))}
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="avc-scroll -mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 pb-4">
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <Heart className="h-10 w-10 text-zinc-700" aria-hidden />
                  <p className="max-w-xs text-sm text-zinc-500">
                    {syncing || lists.length === 0
                      ? 'Список пуст или ещё синхронизируется'
                      : 'В этом списке пока нет аниме'}
                  </p>
                </div>
              ) : (
                items.map((item) => (
                  <BookmarkCard key={`${item.animeId}:${item.listId}`} item={item} />
                ))
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Карточка закладки: постер, название, бейдж списка, год; клик — открыть аниме */
function BookmarkCard({ item }: { item: YummyListItemDto }) {
  const setOpen = useAvcStore((s) => s.setBookmarksOpen)
  const badge = LIST_BADGE[item.listId]

  const open = () => {
    setOpen(false)
    void openAnimeCard({
      animeId: item.animeId,
      slug: item.animeUrl,
      title: item.title,
      poster: item.poster,
      year: item.year,
      rating: item.rating,
      status: null,
      type: null,
    })
  }

  const openOnSite = () => {
    window.open(
      `https://old.yummyani.me/catalog/item/${item.animeUrl}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Открыть ${item.title}`}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2',
        'transition-colors hover:border-amber-400/40 hover:bg-zinc-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      {item.poster ? (
        <img
          src={item.poster}
          alt=""
          loading="lazy"
          className="h-16 w-11 shrink-0 rounded border border-zinc-800 object-cover"
        />
      ) : (
        <div className="h-16 w-11 shrink-0 rounded border border-zinc-800 bg-zinc-800" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-100">{item.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {badge && (
            <span className={cn('rounded px-1.5 py-0.5 text-[11px]', badge.className)}>
              {badge.label}
            </span>
          )}
          {item.year != null && <span>{item.year}</span>}
          {item.rating != null && <span>★ {item.rating.toFixed(1)}</span>}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Открыть «${item.title}» на сайте`}
        className="h-8 w-8 shrink-0 text-zinc-600 hover:text-amber-300"
        onClick={(e) => {
          e.stopPropagation()
          openOnSite()
        }}
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  )
}
