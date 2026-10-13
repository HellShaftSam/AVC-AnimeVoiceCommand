'use client'
/**
 * ReleaseCalendar — календарь релизов (ТЗ п.3: «куда-нибудь запихнуть типа
 * календаря, где будут отмечены известные тайтлы, чтобы можно было листать
 * и смотреть в каком порядке они выходят по датам»).
 *
 * Источники событий (честные, без выдумок):
 *  1. Анонсы: дата премьеры/следующей серии из деталей (episodes.next_date)
 *  2. Расписание: время следующей серии онгоинга (data-time) + проекция
 *     еженедельного слота вперёд по 7-дневным шагам (помечено «по расписанию»)
 *
 * Все времена — Астана (Asia/Almaty, UTC+5). Листание — месяцами.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { openAnimeCard } from '@/lib/avc/executor'
import type { AnimeCard, SchedulePage } from '@/lib/avc/types'
import { cn } from '@/lib/utils'
import { formatKzTime, kzDateParts, kzDayKey, useNowTick } from './time-utils'

interface CalEvent {
  unix: number
  title: string
  animeId: number
  slug: string
  poster: string | null
  kind: 'announcement' | 'schedule'
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

/** Сетка месяца (Пн-первый): массив дней с null-пустотами */
function monthGrid(y: number, m: number): Array<number | null> {
  const first = new Date(y, m - 1, 1)
  const daysInMonth = new Date(y, m, 0).getDate()
  // JS: 0=Вс; наша сетка: Пн=0 … Вс=6
  const lead = (first.getDay() + 6) % 7
  const cells: Array<number | null> = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function ReleaseCalendar({ cards }: { cards: AnimeCard[] }) {
  const nowMs = useNowTick(60_000)
  // Текущий месяц В ПОЯСЕ АСТАНЫ
  const todayParts = kzDateParts(Math.floor(nowMs / 1000))
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: todayParts.y, m: todayParts.m })
  const [schedule, setSchedule] = useState<SchedulePage | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Расписание онгоингов (еженедельные слоты) — один запрос, кэш адаптера
  useEffect(() => {
    let cancelled = false
    fetch('/api/site/schedule', { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as SchedulePage) : null))
      .then((d) => {
        if (!cancelled) setSchedule(d)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>()
    const push = (e: CalEvent) => {
      const key = kzDayKey(e.unix)
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }

    // 1. Анонсы: точные даты премьер/следующих серий
    for (const c of cards) {
      if (typeof c.nextEpisodeAt === 'number' && c.nextEpisodeAt > 1_000_000_000) {
        push({
          unix: c.nextEpisodeAt,
          title: c.title,
          animeId: c.animeId,
          slug: c.slug,
          poster: c.poster,
          kind: 'announcement',
        })
      }
    }

    // 2. Онгоинги: еженедельные слоты из расписания, спроецированные
    //    на видимый месяц (шаг 7 дней от известного времени следующей серии)
    const monthStart = Math.floor(new Date(ym.y, ym.m - 1, 1).getTime() / 1000)
    const monthEnd = Math.floor(new Date(ym.y, ym.m, 0, 23, 59, 59).getTime() / 1000)
    if (schedule) {
      for (const day of schedule.days) {
        for (const entry of day.items) {
          if (typeof entry.releaseAt !== 'number' || entry.releaseAt <= 1_000_000_000) continue
          let t = entry.releaseAt
          // Если слот уже в прошлом — начинаем с ближайшего будущего
          const nowSec = Math.floor(nowMs / 1000)
          if (t < nowSec) {
            // сдвигаем на целое число недель вперёд от прошлого слота
            const weeks = Math.ceil((nowSec - t) / (7 * 86400))
            t += weeks * 7 * 86400
          }
          let guard = 0
          while (t <= monthEnd && guard < 12) {
            if (t >= monthStart) {
              push({
                unix: t,
                title: entry.title,
                animeId: entry.animeId,
                slug: entry.slug,
                poster: entry.poster,
                kind: 'schedule',
              })
            }
            t += 7 * 86400
            guard += 1
          }
        }
      }
    }

    // Внутри дня — по времени выхода
    for (const list of map.values()) list.sort((a, b) => a.unix - b.unix)
    return map
  }, [cards, schedule, ym, nowMs])

  const grid = monthGrid(ym.y, ym.m)
  const shiftMonth = (delta: number) => {
    setYm((p) => {
      const d = new Date(p.y, p.m - 1 + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() + 1 }
    })
    setSelectedDay(null)
  }

  const todayKey = kzDayKey(Math.floor(nowMs / 1000))
  const selectedEvents = selectedDay ? eventsByDay.get(selectedDay) ?? [] : []
  const monthTotal = [...eventsByDay.entries()]
    .filter(([k]) => k.startsWith(`${ym.y}-${String(ym.m).padStart(2, '0')}`))
    .reduce((acc, [, v]) => acc + v.length, 0)

  return (
    <section aria-label="Календарь релизов" className="mt-6" data-testid="release-calendar">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-bold">
          <CalendarDays className="h-5 w-5 text-gold-400" aria-hidden />
          Календарь релизов
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            aria-label="Предыдущий месяц"
            onClick={() => shiftMonth(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/60 transition-colors hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-36 text-center text-sm font-semibold" data-testid="calendar-month">
            {MONTHS_NOM[ym.m - 1]} {ym.y}
          </span>
          <button
            aria-label="Следующий месяц"
            onClick={() => shiftMonth(1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/60 transition-colors hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Легенда */}
      <p className="mb-2 text-xs text-muted-foreground">
        Событий в месяце: {monthTotal}. <span className="text-gold-300">● анонсы</span>{' '}
        (точные даты) · <span className="text-emerald-300">● онгоинги</span> (по расписанию).
        Время — Астана (UTC+5).
      </p>

      {/* Сетка месяца */}
      <div
        role="grid"
        aria-label="Дни месяца"
        className="grid grid-cols-7 gap-1 rounded-xl border border-border bg-card/40 p-2"
      >
        {WEEKDAYS.map((w) => (
          <div key={w} aria-hidden className="py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {w}
          </div>
        ))}
        {grid.map((d, i) => {
          if (d === null) return <div key={`e-${i}`} aria-hidden />
          const key = `${ym.y}-${String(ym.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          const evts = eventsByDay.get(key) ?? []
          const isToday = key === todayKey
          const isSelected = key === selectedDay
          const hasAnn = evts.some((e) => e.kind === 'announcement')
          const hasSched = evts.some((e) => e.kind === 'schedule')
          return (
            <button
              key={key}
              role="gridcell"
              aria-label={`${d} ${MONTHS_NOM[ym.m - 1].toLowerCase()}, релизов: ${evts.length}`}
              aria-selected={isSelected}
              data-testid="calendar-day"
              onClick={() => setSelectedDay(isSelected ? null : key)}
              className={cn(
                'flex min-h-16 flex-col items-center gap-0.5 rounded-lg border px-1 py-1 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                evts.length > 0
                  ? 'border-border bg-card/80 hover:border-gold-400/40'
                  : 'border-transparent bg-transparent text-muted-foreground/60',
                isSelected && 'border-gold-400/70 bg-gold-400/10',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold',
                  isToday ? 'bg-gold-400/30 text-gold-200' : '',
                )}
              >
                {d}
              </span>
              {evts.length > 0 && (
                <span className="flex items-center gap-0.5" aria-hidden>
                  {hasAnn && <span className="h-1.5 w-1.5 rounded-full bg-gold-300 shadow-[0_0_4px_rgba(242,221,164,0.9)]" />}
                  {hasSched && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                  <span className="text-[10px] text-muted-foreground">{evts.length}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Список выбранного дня */}
      {selectedDay && (
        <div className="mt-3 rounded-xl border border-border bg-card/60 p-3" data-testid="calendar-day-list">
          <p className="mb-2 text-sm font-semibold text-gold-200">
            {parseInt(selectedDay.slice(8), 10)} {MONTHS_NOM[parseInt(selectedDay.slice(5, 7), 10) - 1].toLowerCase()}
          </p>
          {selectedEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">В этот день релизов нет</p>
          ) : (
            <ul className="space-y-1.5">
              {selectedEvents.map((e) => (
                <li key={`${e.animeId}-${e.unix}`}>
                  <button
                    onClick={() =>
                      void openAnimeCard({ animeId: e.animeId, slug: e.slug, title: e.title, poster: e.poster, year: null, rating: null, status: null, type: null })
                    }
                    className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:border-gold-400/30 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{formatKzTime(e.unix)}</span>
                    <span
                      aria-hidden
                      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', e.kind === 'announcement' ? 'bg-gold-300' : 'bg-emerald-400')}
                    />
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                      {e.kind === 'announcement' ? 'анонс' : 'по расписанию'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
