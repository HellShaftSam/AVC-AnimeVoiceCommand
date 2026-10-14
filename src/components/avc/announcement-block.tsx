'use client'
/**
 * AnnouncementBlock — состояние «Анонс» на странице аниме (ТЗ §5, §6, §14.6).
 *
 * Когда у тайтла ещё нет доступных серий, вместо пустого списка и плеера
 * показывается честный блок:
 *  - статус (Анонс/Ожидается/Перенос) и дата выхода С ТОЧНОСТЬЮ источника
 *    («в 2027 году» / «с июля 2027» / точная дата, «предположительно»);
 *  - официальный трейлер/тизер (сайт → AniList → Jikan), встраивание YouTube
 *    ТОЛЬКО по явному клику (не загружаем iframe заранее);
 *  - расписание серий: подтверждённая следующая серия + расчётные даты
 *    (помечены), либо «Расписание серий пока не объявлено».
 *
 * АВТО-ПЕРЕКЛЮЧЕНИЕ (ТЗ §6 сценарий C): пока блок открыт, раз в 6 минут
 * тихо проверяется матрица серий сайта; как только серии появились —
 * страница перезагружается и переходит на обычный список серий (трейлер
 * остаётся секцией «Трейлеры и материалы»).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, Clapperboard, Clock, ExternalLink, Info, Play, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/hooks/use-toast'
import type { AnimeDetails, ReleaseMeta, TrailerInfo } from '@/lib/avc/types'
import { cn } from '@/lib/utils'
import { formatKzDateTimeShort, formatRelative, formatReleaseDate, useNowTick } from './time-utils'

const STATUS_LABELS: Record<string, string> = {
  announced: 'Анонс',
  upcoming: 'Ожидается',
  airing: 'Выходит',
  released: 'Вышел',
  delayed: 'Перенос',
  unknown: 'Статус уточняется',
}

const SOURCE_LABELS: Record<string, string> = {
  yummy: 'YummyAnime',
  anilist: 'AniList',
  jikan: 'MyAnimeList',
}

/** Достать трейлеры + дату + расписание одним запросом (кэш сервера 3 ч) */
function useReleaseMeta(animeId: number) {
  const [state, setState] = useState<{
    meta: ReleaseMeta | null
    error: string | null
  }>({ meta: null, error: null })
  const [loadedId, setLoadedId] = useState<number | null>(null)

  useEffect(() => {
    if (!Number.isInteger(animeId) || animeId <= 0) return
    let cancelled = false
    fetch(`/api/site/release-meta?ids=${animeId}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { items: Record<number, ReleaseMeta> }
      })
      .then((d) => {
        if (cancelled) return
        setState({ meta: d.items[animeId] ?? null, error: null })
        setLoadedId(animeId)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ meta: null, error: e instanceof Error ? e.message : 'Метаданные выхода недоступны' })
        setLoadedId(animeId)
      })
    return () => {
      cancelled = true
    }
  }, [animeId])

  return { meta: state.meta, error: state.error, loaded: loadedId === animeId }
}

/**
 * Тихая проверка появления серий: GET /api/site/videos/{id} (кэш адаптера
 * 5 мин → фактический запрос к сайту не чаще, чем раз в 5 минут на открытую
 * вкладку). Появились → колбэк (перезагрузка страницы аниме).
 */
function useEpisodesWatch(animeId: number, enabled: boolean, onEpisodesAppeared: () => void) {
  const checkRef = useRef(onEpisodesAppeared)
  useEffect(() => {
    checkRef.current = onEpisodesAppeared
  })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const check = async () => {
      try {
        const r = await fetch(`/api/site/videos/${animeId}`, { cache: 'no-store' })
        if (!r.ok) return
        const d = (await r.json()) as { videos?: unknown[] }
        if (!cancelled && Array.isArray(d.videos) && d.videos.length > 0) {
          checkRef.current()
        }
      } catch {
        // сайт недоступен — молча ждём следующего тика (F: не рушим данные)
      }
    }
    const t = window.setInterval(check, 6 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [animeId, enabled])
}

/** Дата выхода с честной точностью и происхождением */
function ReleaseDateLine({ meta }: { meta: ReleaseMeta }) {
  const d = meta.releaseDate
  if (d.precision === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <CalendarClock className="h-4 w-4" aria-hidden />
        Дата выхода не объявлена
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <CalendarClock className="h-4 w-4 text-gold-300" aria-hidden />
      <span className="font-semibold text-foreground">{formatReleaseDate(d)}</span>
      {!d.confirmed && <span className="text-xs text-muted-foreground">· предположительно</span>}
      {d.source !== 'yummy' && (
        <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">
          {SOURCE_LABELS[d.source] ?? d.source}
        </Badge>
      )}
      {d.note && <span className="text-xs text-muted-foreground">({d.note})</span>}
    </span>
  )
}

/** Ленивый YouTube-плеер: iframe появляется только после клика */
function TrailerPlayer({ trailer, title }: { trailer: TrailerInfo; title: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-night-950/60" data-testid="trailer-box">
      <div className="relative aspect-video w-full">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${trailer.youtubeId}?autoplay=1&rel=0`}
            title={`Трейлер: ${title}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            onClick={() => setPlaying(true)}
            aria-label={`Смотреть трейлер: ${trailer.title}`}
            data-testid="trailer-play"
            className="group absolute inset-0 h-full w-full"
          >
            <img
              src={`https://i.ytimg.com/vi/${trailer.youtubeId}/hqdefault.jpg`}
              alt={`Превью трейлера: ${title}`}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full border border-gold-300/60 bg-night-950/80 shadow-[0_0_24px_rgba(229,188,94,0.35)] transition-transform group-hover:scale-105">
                <Play className="ml-1 h-7 w-7 text-gold-300" aria-hidden />
              </span>
            </span>
            <span className="absolute bottom-2 left-2 rounded-md border border-gold-300/30 bg-night-950/85 px-2 py-0.5 text-[11px] font-semibold text-gold-200">
              {trailer.title} · YouTube
            </span>
          </button>
        )}
      </div>
    </div>
  )
}

/** Расписание серий: подтверждённое + расчётное (ТЗ §14.6) */
function ScheduleLine({ meta }: { meta: ReleaseMeta }) {
  const nowMs = useNowTick(60_000)
  const { next, estimated, announced, weekly } = meta.schedule
  if (!announced || (!next && estimated.length === 0)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="schedule-none">
        Расписание серий пока не объявлено
      </p>
    )
  }
  const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  return (
    <div className="space-y-1.5" data-testid="schedule-block">
      {next && (
        <p className="text-sm">
          <span className="font-semibold text-gold-200">Серия {next.number}</span>
          <span className="text-muted-foreground"> — {formatKzDateTimeShort(next.at)} (Астана)</span>
          <span className="ml-1.5 text-xs text-muted-foreground">
            · {formatRelative(next.at, nowMs)} · источник: {SOURCE_LABELS[next.source] ?? next.source}
          </span>
        </p>
      )}
      {weekly && (
        <p className="text-xs text-muted-foreground">
          Еженедельно: {WEEKDAY[weekly.weekday % 7]} {String(weekly.hh).padStart(2, '0')}:
          {String(weekly.mm).padStart(2, '0')} (Астана)
        </p>
      )}
      {estimated.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {estimated.map((e) => (
            <li key={`${e.number}-${e.at}`}>
              серия {e.number} — {formatReleaseDate({ precision: 'day', unix: e.at, y: null, m: null })}
              <span className="ml-1 text-[10px]">· расчётная дата</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Блок «Анонс» для страницы аниме (см. шапку файла) */
export function AnnouncementBlock({ details, onEpisodesAppeared }: { details: AnimeDetails; onEpisodesAppeared: () => void }) {
  const { meta, error, loaded } = useReleaseMeta(details.animeId)
  const status = meta?.status ?? 'announced'
  const waiting = status === 'announced' || status === 'upcoming' || status === 'delayed' || status === 'unknown'
  useEpisodesWatch(details.animeId, waiting, onEpisodesAppeared)

  const trailers = meta?.trailers ?? []
  const featured = trailers[0] ?? null

  const manualRefresh = useCallback(() => {
    void fetch(`/api/site/videos/${details.animeId}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { videos?: unknown[] }
      })
      .then((d) => {
        if (Array.isArray(d.videos) && d.videos.length > 0) {
          toast({ description: 'Серии появились! Открываю список серий.' })
          onEpisodesAppeared()
        } else {
          toast({ description: 'Серий пока нет — трейлер и дата ниже' })
        }
      })
      .catch(() => toast({ variant: 'destructive', description: 'Сайт недоступен — попробуйте позже' }))
  }, [details.animeId, onEpisodesAppeared])

  return (
    <section
      aria-label="Статус выхода"
      data-testid="announcement-block"
      className="mt-6 rounded-xl border border-gold-400/25 bg-card/60 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={cn(
              'border',
              status === 'delayed'
                ? 'border-rose-400/40 bg-rose-400/10 text-rose-300'
                : 'border-gold-400/50 bg-gold-400/15 text-gold-200',
            )}
            data-testid="announcement-status"
          >
            <Clapperboard className="h-3 w-3" aria-hidden />
            {STATUS_LABELS[status] ?? 'Анонс'}
          </Badge>
          {loaded && meta ? <ReleaseDateLine meta={meta} /> : <span className="text-sm text-muted-foreground">Статус выхода: {details.status ?? 'неизвестен'}</span>}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={manualRefresh}
          aria-label="Проверить появление серий"
          className="min-h-9 gap-1.5 border-border bg-card/60 text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Проверить серии
        </Button>
      </div>

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" aria-hidden />
          Точные даты временно недоступны ({error}) — сайт-источник указан выше.
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* Трейлер / заглушка */}
        <div>
          {!loaded && <Skeleton className="aspect-video w-full rounded-xl bg-card" />}
          {loaded && featured && (
            <>
              <TrailerPlayer trailer={featured} title={details.title} />
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>
                  {featured.title} · источник: {SOURCE_LABELS[featured.source] ?? featured.source}
                </span>
                <a
                  href={`https://www.youtube.com/watch?v=${featured.youtubeId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-gold-300 hover:underline"
                >
                  YouTube <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </p>
              {trailers.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {trailers.slice(1).map((t) => (
                    <a
                      key={t.youtubeId}
                      href={`https://www.youtube.com/watch?v=${t.youtubeId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border bg-card/60 px-3 text-xs text-foreground transition-colors hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <Play className="h-3 w-3" aria-hidden />
                      {t.title}
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
          {loaded && !featured && (
            <div
              className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-gradient-to-b from-night-900 to-night-950 p-4 text-center"
              data-testid="trailer-placeholder"
            >
              {details.poster ? (
                <img
                  src={details.poster}
                  alt={`Постер: ${details.title}`}
                  className="h-28 w-20 rounded-lg border border-border object-cover opacity-90"
                />
              ) : (
                <Clapperboard className="h-8 w-8 text-gold-300" aria-hidden />
              )}
              <p className="text-sm text-muted-foreground">
                Официальный трейлер пока не опубликован — здесь он появится автоматически.
              </p>
            </div>
          )}
        </div>

        {/* Расписание серий */}
        <div className="rounded-xl border border-border bg-card/40 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5 text-gold-300" aria-hidden />
            Расписание серий
          </p>
          {loaded && meta ? <ScheduleLine meta={meta} /> : <Skeleton className="h-4 w-3/4 rounded bg-card" />}
          <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
            Даты — Астана (UTC+5). Серии появятся здесь автоматически, как только выйдут на сайте.
          </p>
        </div>
      </div>
    </section>
  )
}

/**
 * Компактная секция «Трейлеры и материалы» — для тайтлов, У КОТОРЫХ УЖЕ ЕСТЬ
 * серии (сценарий C: трейлер не пропадает, а переезжает сюда).
 */
export function TrailersSection({ animeId, title }: { animeId: number; title: string }) {
  const { meta, loaded } = useReleaseMeta(animeId)
  const trailers = meta?.trailers ?? []
  if (!loaded || trailers.length === 0) return null
  return (
    <section aria-label="Трейлеры и материалы" className="mt-6" data-testid="trailers-section">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Clapperboard className="h-4 w-4 text-gold-300" aria-hidden />
        Трейлеры и материалы
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {trailers.slice(0, 2).map((t) => (
          <TrailerPlayer key={t.youtubeId} trailer={t} title={title} />
        ))}
      </div>
    </section>
  )
}
