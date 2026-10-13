'use client'
/**
 * ScheduleView — расписание онгоингов по дням недели (плитки).
 *
 * Данные: /api/site/schedule → { days: ScheduleDay[] } с UNIX-временем выхода
 * следующей серии каждой карточки (local-time[data-time] с сайта).
 * День выбирается чипами; по умолчанию — сегодняшний (метка сайта isToday,
 * иначе день недели машины). Клик по плитке — открыть аниме в новой вкладке.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Clock, RotateCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimeGridSkeleton } from './anime-grid'
import { openAnimeCard } from '@/lib/avc/executor'
import type { SchedulePage, ScheduleEntry } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Тикает каждые 30 с — для честного «через N минут» */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** «20:45» по локальной машине пользователя */
function formatTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** «через 2 ч 15 мин» / «через 40 мин» / «через 4 дн 12 ч» / «серия вышла» */
function formatRelative(unixSec: number, nowMs: number): string {
  const diffMin = Math.round(unixSec - nowMs / 1000) / 60
  if (!Number.isFinite(diffMin)) return ''
  if (diffMin <= -5) return 'серия вышла'
  if (diffMin < 60) return `через ${Math.max(1, Math.round(diffMin))} мин`
  const h = Math.floor(diffMin / 60)
  const m = Math.round(diffMin % 60)
  if (h < 24) return m > 0 ? `через ${h} ч ${m} мин` : `через ${h} ч`
  const d = Math.floor(h / 24)
  const restH = h % 24
  return restH > 0 ? `через ${d} дн ${restH} ч` : `через ${d} дн`
}

/** День недели машины: Пн=1 … Вс=7 (JS: 0=Вс) */
function localDayIndex(): number {
  return ((new Date().getDay() + 6) % 7) + 1
}

function ScheduleTile({ entry, nowMs }: { entry: ScheduleEntry; nowMs: number }) {
  const release = entry.releaseAt !== null ? formatTime(entry.releaseAt) : null
  const rel = entry.releaseAt !== null ? formatRelative(entry.releaseAt, nowMs) : null
  const released =
    entry.releaseAt !== null && entry.releaseAt * 1000 < nowMs - 5 * 60_000
  return (
    <button
      onClick={() =>
        void openAnimeCard({
          animeId: entry.animeId,
          slug: entry.slug,
          title: entry.title,
          poster: entry.poster,
          year: entry.year,
          rating: entry.rating,
          status: entry.status,
          type: entry.type,
        })
      }
      aria-label={`Открыть: ${entry.title}${release ? `, серия в ${release}` : ''}`}
      data-testid="schedule-tile"
      className={cn(
        'group flex min-h-20 gap-3 rounded-xl border p-2.5 text-left transition-all',
        'border-border bg-card/60 hover:border-gold-400/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        released && 'opacity-60',
      )}
    >
      {entry.poster ? (
        <img
          src={entry.poster}
          alt=""
          loading="lazy"
          className="h-24 w-16 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <CalendarDays className="h-5 w-5" aria-hidden />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 py-0.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {entry.title}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {entry.type && <span className="text-muted-foreground">{entry.type}</span>}
          {release && (
            <span
              className={cn(
                'inline-flex items-center gap-1 font-semibold',
                released ? 'text-muted-foreground' : 'text-gold-300',
              )}
            >
              <Clock className="h-3 w-3" aria-hidden />
              {release}
            </span>
          )}
          {rel && (
            <span className={cn('text-muted-foreground', !released && rel !== '' && 'text-emerald-400/90')}>
              {rel}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

export function ScheduleView() {
  const [data, setData] = useState<SchedulePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Тик завершённой загрузки (null = ещё не грузили); retry повышает reloadTick */
  const [loadedTick, setLoadedTick] = useState<number | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [selected, setSelected] = useState<number | null>(null) // dayIndex
  const loading = loadedTick !== reloadTick
  const nowMs = useNowTick()

  useEffect(() => {
    let cancelled = false
    fetch('/api/site/schedule', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as SchedulePage
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedTick(reloadTick)
        // По умолчанию — сегодняшний день (метка сайта, иначе локальный день недели)
        const todaySite = d.days.find((x) => x.isToday)
        const fallbackIdx = d.days.some((x) => x.dayIndex === localDayIndex())
          ? localDayIndex()
          : null
        setSelected((prev) => prev ?? todaySite?.dayIndex ?? fallbackIdx ?? d.days[0]?.dayIndex ?? null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка загрузки расписания')
        setLoadedTick(reloadTick)
      })
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  const activeDay = useMemo(() => {
    if (!data) return null
    return data.days.find((d) => d.dayIndex === selected) ?? data.days[0] ?? null
  }, [data, selected])

  if (loading) {
    return (
      <div>
        <div className="mb-4 flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-gold-400" aria-hidden />
          <h2 className="text-lg font-bold">Расписание онгоингов</h2>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full bg-card" />
          ))}
        </div>
        <AnimeGridSkeleton />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
        ✗ {error ?? 'Расписание недоступно'}
        <div className="mt-3">
          <Button
            variant="outline"
            onClick={() => setReloadTick((t) => t + 1)}
            className="min-h-11 border-border"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            Повторить
          </Button>
        </div>
      </div>
    )
  }

  if (data.days.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/60 p-6 text-center text-sm text-muted-foreground">
        Расписание пусто
        {data.source === 'demo' && (
          <p className="mt-2 text-xs">Сайт недоступен — показывать нечего.</p>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <CalendarDays className="h-5 w-5 text-gold-400" aria-hidden />
          Расписание онгоингов
        </h2>
        {data.source === 'demo' && (
          <Badge className="border border-gold-400/40 bg-gold-400/40 text-gold-300">
            Демо-данные (сайт недоступен)
          </Badge>
        )}
      </div>

      {/* Чипы дней недели */}
      <div
        role="tablist"
        aria-label="Дни недели"
        className="avc-scroll mb-4 flex gap-2 overflow-x-auto pb-1"
      >
        {data.days.map((d) => {
          const active = activeDay?.dayIndex === d.dayIndex
          return (
            <button
              key={d.dayIndex}
              role="tab"
              aria-selected={active}
              aria-label={`День: ${d.day}, тайтлов: ${d.items.length}`}
              data-testid="schedule-day"
              onClick={() => setSelected(d.dayIndex)}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                active
                  ? 'border-gold-400 bg-gold-400/40 text-gold-300 shadow-[0_0_14px_rgba(229,188,94,0.15)]'
                  : 'border-border bg-card/60 text-foreground hover:border-zinc-500',
              )}
            >
              {d.day}
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] leading-none',
                  active ? 'bg-night-900/60 text-gold-200' : 'bg-secondary text-muted-foreground',
                )}
              >
                {d.items.length}
              </span>
              {d.isToday && (
                <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
                  сегодня
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Плитки выбранного дня */}
      {activeDay ? (
        activeDay.items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            В этот день релизов нет
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {activeDay.items.map((entry) => (
              <ScheduleTile key={`${entry.animeId}-${entry.slug}`} entry={entry} nowMs={nowMs} />
            ))}
          </div>
        )
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">Выберите день</p>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Время указано по вашему часовому поясу. Нажмите на тайтл, чтобы открыть его.
      </p>
    </div>
  )
}
