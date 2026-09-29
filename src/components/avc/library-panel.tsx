'use client'
/**
 * LibraryPanel — правая Sheet-панель «Библиотека».
 *
 * Табы: Продолжить | Смотрю | В планах | Просмотрено | Брошено | Отложено | Избранное.
 *  - «Продолжить»: записи с известной серией, сортировка по updatedAt desc,
 *    прогресс-бар (episode/total), кнопка Play → continueWatchingFromEntry.
 *  - Табы статусов: фильтр по status; в карточке смена статуса и удаление.
 *  - «Избранное»: фильтр favorite.
 * Клик по карточке (не по кнопкам) открывает аниме и продолжает просмотр.
 */
import { useMemo, useState } from 'react'
import { BookOpen, Loader2, Play, Trash2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import { continueWatchingFromEntry } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { LibraryEntryDto, WatchStatus } from '@/lib/avc/types'
import { WATCH_STATUS_LABELS } from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type LibTab = 'continue' | WatchStatus | 'favorite'

const TABS: { value: LibTab; label: string }[] = [
  { value: 'continue', label: 'Продолжить' },
  { value: 'watching', label: 'Смотрю' },
  { value: 'planned', label: 'В планах' },
  { value: 'completed', label: 'Просмотрено' },
  { value: 'dropped', label: 'Брошено' },
  { value: 'on_hold', label: 'Отложено' },
  { value: 'favorite', label: 'Избранное' },
]

const STATUS_ICONS: Record<WatchStatus, string> = {
  watching: '▶',
  planned: '📅',
  completed: '✓',
  dropped: '✕',
  on_hold: '⏸',
}

export function LibraryPanel() {
  const open = useAvcStore((s) => s.libraryOpen)
  const setOpen = useAvcStore((s) => s.setLibraryOpen)
  const user = useAvcStore((s) => s.user)
  const library = useAvcStore((s) => s.library)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const [tab, setTab] = useState<LibTab>('continue')

  // «Продолжить»: только записи с открытой серией, свежие сверху
  const continueList = useMemo(
    () =>
      library
        .filter((e) => e.episode != null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [library],
  )

  const statusList = useMemo(
    () =>
      library
        .filter((e) => tab !== 'favorite' && e.status === tab)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [library, tab],
  )

  const favoriteList = useMemo(
    () => library.filter((e) => e.favorite).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [library],
  )

  const list: LibraryEntryDto[] =
    tab === 'continue' ? continueList : tab === 'favorite' ? favoriteList : statusList

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 border-zinc-800 bg-zinc-950 sm:max-w-[420px]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2 text-zinc-100">
            <BookOpen className="h-4 w-4 text-amber-400" aria-hidden />
            Библиотека
          </SheetTitle>
          <SheetDescription className="text-zinc-500">
            Статусы, избранное и продолжение просмотра
          </SheetDescription>
        </SheetHeader>

        {!user ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <BookOpen className="h-10 w-10 text-zinc-700" aria-hidden />
            <p className="text-sm text-zinc-400">
              Войдите, чтобы синхронизировать библиотеку между устройствами
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
            <Tabs value={tab} onValueChange={(v: string) => setTab(v as LibTab)}>
              <TabsList className="avc-scroll flex w-full justify-start gap-1 overflow-x-auto bg-zinc-900/70 p-1">
                {TABS.map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="shrink-0 whitespace-nowrap px-2.5 text-xs data-[state=active]:text-amber-300"
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="avc-scroll -mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 pb-4">
              {list.length === 0 ? (
                <EmptyState />
              ) : (
                list.map((entry) => (
                  <EntryCard
                    key={entry.animeId}
                    entry={entry}
                    showProgress={tab === 'continue' || entry.episode != null}
                  />
                ))
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <BookOpen className="h-10 w-10 text-zinc-700" aria-hidden />
      <p className="max-w-xs text-sm text-zinc-500">
        Пока пусто. Скажите «найди Берсерка» и добавьте в смотрю
      </p>
    </div>
  )
}

/** Карточка записи: постер, название, серия, прогресс; клик = продолжить просмотр */
function EntryCard({ entry, showProgress }: { entry: LibraryEntryDto; showProgress: boolean }) {
  const library = useAvcStore((s) => s.library)
  const setLibrary = useAvcStore((s) => s.setLibrary)
  const setOpen = useAvcStore((s) => s.setLibraryOpen)
  const [busy, setBusy] = useState(false)

  const progressPct =
    entry.totalEpisodes && entry.totalEpisodes > 0 && entry.episode
      ? Math.min(100, Math.round((entry.episode / entry.totalEpisodes) * 100))
      : null

  const openAnime = () => {
    setOpen(false)
    continueWatchingFromEntry(entry)
  }

  const changeStatus = async (status: WatchStatus) => {
    setBusy(true)
    try {
      const updated = await avcApi.putLibrary({
        animeId: entry.animeId,
        title: entry.title,
        slug: entry.slug,
        poster: entry.poster,
        status,
      })
      if (!updated) {
        toast({ variant: 'destructive', description: 'Требуется вход в аккаунт' })
        return
      }
      setLibrary(library.map((e) => (e.animeId === entry.animeId ? { ...e, ...updated } : e)))
      toast({ description: `«${entry.title}» — ${WATCH_STATUS_LABELS[status]}` })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось обновить статус' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const ok = await avcApi.deleteLibraryEntry(entry.animeId)
      if (!ok) {
        toast({ variant: 'destructive', description: 'Не удалось удалить запись' })
        return
      }
      setLibrary(library.filter((e) => e.animeId !== entry.animeId))
      toast({ description: `«${entry.title}» удалено из библиотеки` })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось удалить запись' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Открыть ${entry.title}`}
      onClick={openAnime}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openAnime()
        }
      }}
      className="group flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2.5 transition-colors hover:border-amber-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
    >
      {entry.poster ? (
        <img
          src={entry.poster}
          alt={`Постер: ${entry.title}`}
          loading="lazy"
          className="h-20 w-14 shrink-0 rounded-md border border-zinc-800 object-cover"
        />
      ) : (
        <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-600">
          <BookOpen className="h-5 w-5" aria-hidden />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-zinc-100">
            {entry.title}
            {entry.favorite && <span className="ml-1 text-rose-400" aria-label="В избранном">♥</span>}
          </p>
          {/* Действия: статус + удалить (клик не должен открывать аниме) */}
          <div
            className="flex shrink-0 items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Сменить статус"
                  title="Сменить статус"
                  disabled={busy}
                  className="h-9 min-h-9 gap-1 px-2 text-xs text-zinc-400 hover:text-amber-300"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <>
                      <span aria-hidden>{STATUS_ICONS[entry.status]}</span>
                      {WATCH_STATUS_LABELS[entry.status]}
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
                <DropdownMenuLabel className="text-xs text-zinc-500">Статус</DropdownMenuLabel>
                {(Object.keys(WATCH_STATUS_LABELS) as WatchStatus[]).map((st) => (
                  <DropdownMenuItem
                    key={st}
                    onClick={() => void changeStatus(st)}
                    className={cn(
                      'gap-2 text-zinc-300',
                      st === entry.status && 'text-amber-300',
                    )}
                  >
                    <span aria-hidden>{STATUS_ICONS[st]}</span>
                    {WATCH_STATUS_LABELS[st]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator className="bg-zinc-800" />
                <DropdownMenuItem
                  onClick={() => void remove()}
                  className="gap-2 text-rose-300 focus:text-rose-300"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Удалить
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Удалить ${entry.title} из библиотеки`}
              title="Удалить"
              disabled={busy}
              className="h-9 w-9 rounded-full text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400"
              onClick={() => void remove()}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>

        <p className="mt-0.5 text-xs text-zinc-500">
          {entry.episode != null ? (
            <>
              Серия <span className="text-amber-300">{entry.episode}</span>
              {entry.totalEpisodes ? ` из ${entry.totalEpisodes}` : ''}
              {entry.currentDub && <> · {entry.currentDub}</>}
            </>
          ) : (
            WATCH_STATUS_LABELS[entry.status]
          )}
        </p>

        {showProgress && progressPct !== null && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" aria-hidden>
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        <Button
          size="sm"
          aria-label={`Продолжить просмотр ${entry.title}`}
          className="mt-2 min-h-9 gap-1.5 bg-amber-400/90 text-zinc-950 hover:bg-amber-300"
          onClick={(e) => {
            e.stopPropagation()
            openAnime()
          }}
        >
          <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
          {entry.episode != null ? `Серия ${entry.episode}` : 'Открыть'}
        </Button>
      </div>
    </div>
  )
}
