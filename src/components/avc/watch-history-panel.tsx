'use client'
/**
 * WatchHistoryPanel — панель истории просмотров (Persistent Watch History).
 *
 * Показывает по каждому аниме: постер, последнюю серию, прогресс (%),
 * когда смотрели. Действия: «Продолжить» (resume с сохранённой позиции,
 * досмотренные серии — следующая), «Убрать» из истории. Сверху — очистка
 * всей истории. Список ограничен по высоте со скроллом.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, History, Loader2, Play, Trash2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { continueWatchingFromHistoryId, removeAnimeFromHistory } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { WatchHistoryEntryDto } from '@/lib/avc/types'
import { clearWatchHistory, fetchWatchHistory } from '@/lib/avc/watch-history'

/** Сгруппированная запись: одно аниме — последняя серия + метаданные */
interface HistoryGroup {
  animeId: number
  animeTitle: string
  animeSlug: string | null
  poster: string | null
  episodeNumber: number
  percent: number
  completed: boolean
  positionSec: number
  lastWatchedAt: number
}

function groupByAnime(items: WatchHistoryEntryDto[]): HistoryGroup[] {
  const map = new Map<number, HistoryGroup>()
  for (const e of items) {
    const percent =
      e.durationSec > 0
        ? Math.round(Math.min(100, (e.lastPositionSec / e.durationSec) * 100))
        : Math.round(e.watchedPercent)
    const prev = map.get(e.animeId)
    // список отсортирован по lastWatchedAt desc — первая запись аниме уже свежая
    if (!prev) {
      map.set(e.animeId, {
        animeId: e.animeId,
        animeTitle: e.animeTitle,
        animeSlug: e.animeSlug,
        poster: e.poster,
        episodeNumber: e.episodeNumber,
        percent,
        completed: e.completed || percent >= 90,
        positionSec: e.lastPositionSec,
        lastWatchedAt: new Date(e.lastWatchedAt).getTime(),
      })
    }
  }
  return [...map.values()].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
}

/** «сегодня» / «вчера» / «12.05» */
function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (days <= 0) return 'Сегодня'
  if (days === 1) return 'Вчера'
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

export function WatchHistoryPanel() {
  const open = useAvcStore((s) => s.watchHistoryOpen)
  const setOpen = useAvcStore((s) => s.setWatchHistoryOpen)
  const historyVersion = useAvcStore((s) => s.historyVersion)

  const [items, setItems] = useState<WatchHistoryEntryDto[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetchWatchHistory(300)
    setItems(data)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load, historyVersion])

  const groups = useMemo(() => (items ? groupByAnime(items) : []), [items])

  const onClearAll = async () => {
    const done = await clearWatchHistory()
    toast({ description: done ? 'История просмотров очищена' : 'Не удалось очистить историю' })
    if (done) void load()
  }

  const onResume = (g: HistoryGroup) => {
    setBusyId(g.animeId)
    void (async () => {
      try {
        await continueWatchingFromHistoryId(g.animeId)
        setOpen(false)
      } finally {
        setBusyId(null)
      }
    })()
  }

  const onRemove = (g: HistoryGroup) => {
    setItems((prev) => prev?.filter((e) => e.animeId !== g.animeId) ?? null)
    void removeAnimeFromHistory(g.animeId, g.animeTitle)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] border-zinc-800 bg-zinc-950 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-amber-400" aria-hidden />
            История просмотров
          </DialogTitle>
          <DialogDescription>
            Сохраняется автоматически во время просмотра — переживёт перезапуск приложения
          </DialogDescription>
        </DialogHeader>

        {loading && items === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            Загружаю историю...
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-zinc-500">
            <Clock className="h-8 w-8" aria-hidden />
            <p className="text-sm">История пуста. Скажите «найди ...» и запустите серию.</p>
          </div>
        ) : (
          <>
            <ScrollArea className="max-h-96 overflow-y-auto pr-2">
              <ul className="flex flex-col gap-2">
                {groups.map((g) => (
                  <li
                    key={g.animeId}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5"
                  >
                    {/* Постер (или заглушка) */}
                    <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded bg-zinc-800">
                      {g.poster ? (
                        <img
                          src={g.poster}
                          alt={`Постер: ${g.animeTitle}`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-zinc-600">
                          <History className="h-5 w-5" aria-hidden />
                        </div>
                      )}
                    </div>

                    {/* Название / серия / прогресс */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{g.animeTitle}</p>
                      <p className="text-xs text-zinc-400">
                        Серия {g.episodeNumber}
                        {g.completed ? ' — просмотрена' : ` — ${Math.max(1, g.percent)}%`}
                      </p>
                      {/* Полоса прогресса */}
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={g.completed ? 'h-full bg-emerald-500' : 'h-full bg-amber-400'}
                          style={{ width: `${g.completed ? 100 : Math.max(2, g.percent)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        Последний просмотр: {fmtWhen(g.lastWatchedAt)}
                      </p>
                    </div>

                    {/* Действия */}
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button
                        size="sm"
                        className="h-8 gap-1 bg-amber-400 px-2.5 text-zinc-950 hover:bg-amber-300"
                        disabled={busyId === g.animeId}
                        onClick={() => onResume(g)}
                        aria-label={`Продолжить: ${g.animeTitle}, серия ${g.episodeNumber}`}
                      >
                        {busyId === g.animeId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Play className="h-3.5 w-3.5" aria-hidden />
                        )}
                        <span className="text-xs">Далее</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1 px-2.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-300"
                        onClick={() => onRemove(g)}
                        aria-label={`Убрать ${g.animeTitle} из истории`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        <span className="text-xs">Убрать</span>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </ScrollArea>

            <div className="flex justify-end border-t border-zinc-800 pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 gap-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-300"
                onClick={() => void onClearAll()}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Очистить всю историю
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
