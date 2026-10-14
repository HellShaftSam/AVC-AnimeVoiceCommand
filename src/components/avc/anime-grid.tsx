'use client'
/**
 * AnimeGrid — сетка карточек аниме (секции/поиск) + скелетон загрузки.
 * Наведение (мышь) → плавающее превью рядом с карточкой: полное название,
 * рейтинг, жанры, описание — без перехода на страницу (короткие названия
 * на карточке обрезаются — в превью видно всё).
 *
 * Если у карточки известно время следующей серии (онгоинги/анонсы —
 * обогащение в адаптере), на плитке показывается бейдж: номер серии и
 * «через…» (обратный отсчёт), для анонсов — дата премьеры. Время — Астана.
 */
import { useRef } from 'react'
import { CalendarClock, Clock, Star } from 'lucide-react'
import { openAnimeCard } from '@/lib/avc/executor'
import type { AnimeCard } from '@/lib/avc/types'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimeHoverPreview, useAnimeHover } from './anime-hover-preview'
import { formatKzDateTimeShort, formatReleaseDate, formatRelative, useNowTick } from './time-utils'

/**
 * Бейдж следующей серии/премьеры (ТЗ п.3, п.6): честно только при известных
 * данных. Анонсы с точностью даты (releaseDate) показывают честный уровень:
 * «в 2027 году» / «с июля 2027» / точная дата + «дата не объявлена».
 */
export function NextEpisodeBadge({ card, nowMs }: { card: AnimeCard; nowMs: number }) {
  const rd = card.releaseDate
  // Дата с точностью хуже дня: честная подпись вместо фальшивого «1 января»
  if (rd && (rd.precision === 'year' || rd.precision === 'month' || rd.precision === 'unknown')) {
    if (rd.precision === 'unknown') {
      return (
        <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          <CalendarClock className="h-3 w-3" aria-hidden />
          дата не объявлена
        </span>
      )
    }
    const approx = !rd.confirmed
    return (
      <span
        className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300"
        title={rd.note ?? undefined}
      >
        <CalendarClock className="h-3 w-3" aria-hidden />
        {formatReleaseDate(rd)}
        {approx && <span className="text-emerald-400/80">· предположительно</span>}
      </span>
    )
  }

  const t = card.nextEpisodeAt
  if (typeof t !== 'number' || t <= 0) return null
  const released = t * 1000 < nowMs - 5 * 60_000
  const epNum =
    typeof card.episodesAired === 'number' && card.episodesAired > 0
      ? card.episodesAired + 1
      : null
  const isPremiere = epNum === null || epNum === 1
  if (released) {
    return (
      <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        {isPremiere ? 'вышло' : `серия ${epNum} вышла`}
      </span>
    )
  }
  return (
    <span
      className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300"
      title={`${formatKzDateTimeShort(t)} (Астана)`}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {isPremiere ? 'с ' : `серия ${epNum} — `}
      {formatKzDateTimeShort(t)}
      <span className="text-emerald-400/90">· {formatRelative(t, nowMs)}</span>
    </span>
  )
}

export function AnimeGrid({ items }: { items: AnimeCard[] }) {
  const { hover, onEnter, onLeave } = useAnimeHover()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const open = (card: AnimeCard) => void openAnimeCard(card, true)
  // один тик на сетку — бейджи обратного отсчёта обновляются вместе
  const nowMs = useNowTick(60_000)

  return (
    <div ref={gridRef} className="relative">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((card) => (
        <button
          key={`${card.animeId}-${card.slug}`}
          onClick={() => open(card)}
          onMouseEnter={(e) => onEnter(card, e.currentTarget)}
          onMouseLeave={onLeave}
          aria-label={`Открыть: ${card.title}${card.nextEpisodeAt ? `, следующая серия ${formatKzDateTimeShort(card.nextEpisodeAt)} по Астане` : ''}`}
          className="group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-xl"
        >
          <div className="relative overflow-hidden rounded-lg border border-border bg-card transition-all group-hover:border-gold-400/40 group-hover:shadow-[0_0_20px_rgba(229, 188, 94,0.12)]">
            {card.poster ? (
              <img
                src={card.poster}
                alt={card.title}
                loading="lazy"
                className="aspect-[3/4] w-full object-cover transition-transform group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex aspect-[3/4] w-full items-center justify-center text-xs text-muted-foreground">
                Нет постера
              </div>
            )}
            {card.rating !== null && card.rating > 0 && (
              <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-gold-400">
                <Star className="h-3 w-3" aria-hidden />
                {card.rating.toFixed(1)}
              </span>
            )}
          </div>
          <div className="mt-1.5 line-clamp-2 text-sm font-medium text-foreground transition-colors group-hover:text-gold-300">
            {card.title}
          </div>
          <NextEpisodeBadge card={card} nowMs={nowMs} />
          <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
            {card.year !== null && <span>{card.year}</span>}
            {card.type && <span>· {card.type}</span>}
            {card.status && <span>· {card.status}</span>}
          </div>
        </button>
      ))}
      </div>
      <AnimeHoverPreview hover={hover} onOpen={open} onNavigate={open} />
    </div>
  )
}

export function AnimeGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[3/4] w-full rounded-lg bg-card" />
          <Skeleton className="mt-2 h-4 w-4/5 rounded bg-card" />
          <Skeleton className="mt-1 h-3 w-2/5 rounded bg-card" />
        </div>
      ))}
    </div>
  )
}
