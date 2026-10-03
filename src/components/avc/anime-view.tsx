'use client'
/**
 * AnimeView — вкладка аниме: постер, инфо, бейджи, действия аккаунта,
 * озвучки, пагинированная сетка серий, диалог «Серии» (ShowEpisodes) и плеер.
 *
 * РЕАЛЬНЫЕ действия аккаунта (спецификация I §9): статусы списка, избранное и
 * оценка выполняются ВНУТРИ постоянной сессии сайта через IPC-мост (EXE).
 * Без сессии — честная просьба войти (диалог входа открывается сам).
 *
 * Сетка серий: пагинация по 60 кнопок вместо «спрятанного» max-h-64 скролла
 * (EPISODE_PARSER_AUDIT §3 п.1) — голосовой пользователь добирается до любой
 * серии командами «вниз» (голос-скролл) и «серия N».
 */
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Film, Heart, RotateCw, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Player } from './player'
import {
  executeCommand,
  getCachedDetails,
  maxEpisodeOf,
  syncPlaybackToDetails,
} from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { LIBRARY_STATUSES } from '@/lib/avc/types'
import type { AnimeDetails, BrowserTab } from '@/lib/avc/types'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Кнопок серий на страницу (аудит: ~48–60 видимых кнопок = «57–58 серий») */
const EPISODES_PER_PAGE = 60

/** Подписи шкалы сайта (модалка rating-list: 10 «шедевр» … 1 «ничтожно») */
const RATE_TITLES: Record<number, string> = {
  10: 'шедевр',
  9: 'великолепно',
  8: 'очень хорошо',
  7: 'хорошо',
  6: 'неплохо',
  5: 'посредственно',
  4: 'никак',
  3: 'плохо',
  2: 'ужасно',
  1: 'ничтожно',
}

export function AnimeView({ tab }: { tab: BrowserTab }) {
  const playback = useAvcStore((s) => s.playback)
  const patchTab = useAvcStore((s) => s.patchTab)
  const bumpReload = useAvcStore((s) => s.bumpReload)
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const [details, setDetails] = useState<AnimeDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [expanded, setExpanded] = useState(false)

  const slug = typeof tab.payload.slug === 'string' ? tab.payload.slug : null
  const animeId = typeof tab.payload.animeId === 'number' ? tab.payload.animeId : null
  const requestKey = `${slug ?? ''}|${animeId ?? ''}|${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    const cached = getCachedDetails(animeId, slug)
    const key = slug ?? (animeId !== null ? String(animeId) : '')
    const work: Promise<AnimeDetails> = cached
      ? Promise.resolve(cached)
      : key
        ? fetch(`/api/site/anime/${encodeURIComponent(key)}`).then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return (await r.json()) as AnimeDetails
          })
        : Promise.reject(new Error('Не указан идентификатор аниме'))
    work
      .then((d) => {
        if (cancelled) return
        setDetails(d)
        setError(null)
        setLoadedKey(requestKey)
        syncPlaybackToDetails(d)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setDetails(null)
        setError(e instanceof Error ? e.message : 'Ошибка загрузки аниме')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [slug, animeId, reloadCounter, requestKey])

  useEffect(() => {
    if (details && details.title && details.title !== tab.title) {
      patchTab(tab.id, { title: details.title })
    }
  }, [details, tab.id, tab.title, patchTab])

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-5 sm:flex-row">
          <Skeleton className="aspect-[3/4] w-full rounded-xl bg-zinc-900 sm:w-44" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-7 w-3/4 rounded bg-zinc-900" />
            <Skeleton className="h-4 w-1/2 rounded bg-zinc-900" />
            <Skeleton className="h-24 w-full rounded bg-zinc-900" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !details) {
    return (
      <div className="mx-auto max-w-5xl rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
        ✗ {error ?? 'Аниме не найдено'}
        <div className="mt-3">
          <Button
            variant="outline"
            onClick={() => bumpReload(tab.id)}
            className="min-h-11 border-zinc-700"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            Повторить
          </Button>
        </div>
      </div>
    )
  }

  const maxEp = maxEpisodeOf(details)
  const desc = details.description ?? ''
  const currentEp = playback.currentEpisode
  const isDemo = details.source === 'demo'

  const pickEpisode = (n: number) => {
    void executeCommand({
      type: VoiceCommandType.SelectEpisode,
      params: { episode: n },
      confidence: 1,
      label: `Серия ${n}`,
    })
  }

  // --- Статусы/избранное/оценка — РЕАЛЬНЫЕ действия через сессию сайта -----
  const act = (
    type: VoiceCommandType,
    params: Record<string, string | number | boolean>,
    label: string,
  ) => {
    void executeCommand({ type, params, confidence: 1, label })
  }

  const openOnSite = () => {
    const base = useAvcStore.getState().settings.baseUrl.replace(/\/+$/, '')
    if (details.slug) window.open(`${base}/catalog/item/${details.slug}`, '_blank', 'noopener')
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-5 sm:flex-row">
        {details.poster ? (
          <img
            src={details.poster}
            alt={details.title}
            loading="lazy"
            className="aspect-[3/4] w-full shrink-0 rounded-xl border border-zinc-800 object-cover sm:w-44"
          />
        ) : (
          <div className="flex aspect-[3/4] w-full shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-600 sm:w-44">
            <Film className="h-8 w-8" aria-hidden />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-bold md:text-2xl">
            {details.title}
            {isDemo && (
              <Badge className="border border-rose-400/40 bg-rose-400/10 text-rose-300">
                ДЕМО-ДАННЫЕ — сайт недоступен
              </Badge>
            )}
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {details.year !== null && (
              <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                {details.year}
              </Badge>
            )}
            {details.rating !== null && details.rating > 0 && (
              <Badge className="border border-amber-400/30 bg-amber-400/10 text-amber-300">
                <Star className="h-3 w-3" aria-hidden />
                {details.rating.toFixed(1)}
              </Badge>
            )}
            {details.status && (
              <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                {details.status}
              </Badge>
            )}
            {details.type && (
              <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                {details.type}
              </Badge>
            )}
            {details.genres.slice(0, 5).map((g) => (
              <Badge key={g} variant="outline" className="border-zinc-800 text-zinc-500">
                {g}
              </Badge>
            ))}
          </div>

          {desc && (
            <div className="mt-3">
              <p className={cn('leading-relaxed text-zinc-300', !expanded && 'line-clamp-4')}>
                {desc}
              </p>
              {desc.length > 180 && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="mt-1 text-xs text-amber-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                >
                  {expanded ? 'Свернуть' : 'Показать полностью'}
                </button>
              )}
            </div>
          )}

          <AccountActionBar
            details={details}
            onAct={act}
            onOpenSite={openOnSite}
          />

          <p className="mt-3 text-sm text-zinc-400">
            Серия <span className="font-semibold text-amber-300">{currentEp ?? '—'}</span> из{' '}
            {maxEp > 0 ? maxEp : '—'} · Озвучка:{' '}
            <span className="text-zinc-200">{playback.currentDub ?? 'не выбрана'}</span>
          </p>

          {details.dubs.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">
                Озвучки (в скобках — серий в этой озвучке)
              </div>
              <div className="flex flex-wrap gap-2">
                {details.dubs.map((d) => {
                  const active = playback.currentDub === d.name
                  return (
                    <button
                      key={d.name}
                      onClick={() =>
                        act(
                          VoiceCommandType.SelectVoice,
                          { dub: d.shortName },
                          `Озвучка ${d.shortName}`,
                        )
                      }
                      aria-pressed={active}
                      className={cn(
                        'min-h-11 rounded-full border px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                        active
                          ? 'border-amber-400 bg-amber-400/10 text-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.15)]'
                          : 'border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-zinc-500',
                      )}
                    >
                      {d.shortName}
                      {d.episodes.length > 0 && (
                        <span className="ml-1 text-zinc-500">· {d.episodes.length} эп.</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {maxEp > 0 && (
        <div className="mt-6">
          <EpisodeGrid
            title="Серии"
            maxEp={maxEp}
            totalCount={details.episodesTotal && details.episodesTotal > 0 ? details.episodesTotal : null}
            currentEp={currentEp}
            onPick={pickEpisode}
          />
        </div>
      )}

      <div className="mt-6">
        <Player />
      </div>

      <EpisodesDialog details={details} maxEp={maxEp} />
    </div>
  )
}

// --- панель действий аккаунта ------------------------------------------------

function AccountActionBar({
  details,
  onAct,
  onOpenSite,
}: {
  details: AnimeDetails
  onAct: (type: VoiceCommandType, params: Record<string, string | number | boolean>, label: string) => void
  onOpenSite: () => void
}) {
  const account = useAvcStore((s) => s.yummyAccount)
  const loggedIn = account.state === 'loggedIn'
  const username = account.user?.username ?? null

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">
          {loggedIn && username
            ? `Аккаунт YummyAnime: ${username}`
            : 'Списки, избранное и оценки — в вашем аккаунте YummyAnime'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSite}
          aria-label="Открыть страницу тайтла на сайте"
          className="min-h-9 gap-1.5 px-2 text-xs text-zinc-500 hover:text-amber-300"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          На сайте
        </Button>
      </div>

      {/* Статусы списка (реестр сайта: Смотрю/В Планах/Просмотрено/Брошено/Отложено) */}
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Статус просмотра">
        {LIBRARY_STATUSES.map((s) => (
          <Button
            key={s.id}
            variant="outline"
            size="sm"
            onClick={() =>
              onAct(VoiceCommandType.SetWatchStatus, { status: s.alias }, `Статус: ${s.title}`)
            }
            aria-label={`Добавить «${details.title}» в список «${s.title}»`}
            className="min-h-9 border-zinc-700 bg-zinc-900/60 px-2.5 text-xs text-zinc-300 hover:border-amber-400/50 hover:text-amber-300"
          >
            {s.title}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onAct(VoiceCommandType.ToggleFavorite, { favorite: true }, 'В Любимые')
          }
          aria-label={`Добавить «${details.title}» в Любимые (избранное)`}
          className="min-h-9 gap-1 border-zinc-700 bg-zinc-900/60 px-2.5 text-xs text-zinc-300 hover:border-rose-400/60 hover:text-rose-300"
        >
          <Heart className="h-3.5 w-3.5" aria-hidden />
          Любимое
        </Button>
      </div>

      {/* Оценка 1..10 (шкала сайта) */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Star className="h-4 w-4 text-amber-300" aria-hidden />
        <Select
          value=""
          onValueChange={(v: string) => {
            const n = parseInt(v, 10)
            if (Number.isInteger(n) && n >= 1 && n <= 10) {
              onAct(VoiceCommandType.RateAnime, { rating: n }, `Оценка ${n} из 10`)
            }
          }}
        >
          <SelectTrigger
            aria-label="Поставить оценку от 1 до 10"
            className="h-9 w-44 border-zinc-700 bg-zinc-900/60 text-xs text-zinc-300"
          >
            <SelectValue placeholder="Оценить (1–10)" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900">
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
              <SelectItem key={n} value={String(n)} className="text-xs text-zinc-300">
                {n} — {RATE_TITLES[n]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAct(VoiceCommandType.RemoveRating, {}, 'Убрать оценку')}
          aria-label="Убрать мою оценку"
          className="min-h-9 px-2 text-xs text-zinc-500 hover:text-rose-300"
        >
          Убрать оценку
        </Button>
      </div>
    </div>
  )
}

// --- пагинированная сетка серий ----------------------------------------------

function EpisodeGrid({
  title,
  maxEp,
  totalCount,
  currentEp,
  onPick,
}: {
  title: string
  maxEp: number
  /** Заявленное число серий из /api/anime/{id} (count, а для онгоингов aired) */
  totalCount: number | null
  currentEp: number | null
  onPick: (n: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(maxEp / EPISODES_PER_PAGE))
  const [page, setPage] = useState(1)
  const [lastEp, setLastEp] = useState<number | null>(currentEp)
  // Номер серии вне текущей страницы → переход на её страницу (adjust-during-render,
  // https://react.dev/learn/you-might-not-need-an-effect)
  if (currentEp !== lastEp) {
    setLastEp(currentEp)
    if (currentEp !== null && currentEp >= 1 && currentEp <= maxEp) {
      const epPage = Math.ceil(currentEp / EPISODES_PER_PAGE)
      const cur = Math.min(Math.max(page, 1), totalPages)
      if (epPage !== cur) setPage(epPage)
    }
  }
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const from = (safePage - 1) * EPISODES_PER_PAGE + 1
  const to = Math.min(maxEp, safePage * EPISODES_PER_PAGE)
  const eps = useMemo(
    () => Array.from({ length: to - from + 1 }, (_, i) => from + i),
    [from, to],
  )

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
        {/* Честный счётчик: заявленное число серий ≠ позиций в озвучке (аудит §3 п.2б) */}
        <p className="text-xs text-zinc-500">
          Серий: <span className="font-semibold text-zinc-300">{totalCount && totalCount > 0 ? totalCount : maxEp}</span>
          {totalCount && totalCount > 0 && totalCount !== maxEp && (
            <span> (доступно {maxEp})</span>
          )}
          {totalPages > 1 && (
            <span className="ml-2">
              · страница {safePage} из {totalPages}
            </span>
          )}
        </p>
      </div>
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
        {eps.map((n) => (
          <button
            key={n}
            onClick={() => onPick(n)}
            aria-label={`Включить серию ${n}`}
            aria-current={currentEp === n ? 'true' : undefined}
            className={cn(
              'min-h-11 rounded-lg border text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              currentEp === n
                ? 'border-amber-400 bg-amber-400/15 text-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.2)]'
                : 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-amber-400/40 hover:text-amber-200',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
            aria-label="Предыдущая страница серий"
            className="min-h-9 border-zinc-700 text-xs text-zinc-300"
          >
            ‹ Назад
          </Button>
          <span className="min-w-20 text-center text-xs tabular-nums text-zinc-500">
            {from}–{to} из {maxEp}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
            aria-label="Следующая страница серий"
            className="min-h-9 border-zinc-700 text-xs text-zinc-300"
          >
            Вперёд ›
          </Button>
        </div>
      )}
    </div>
  )
}

function EpisodesDialog({ details, maxEp }: { details: AnimeDetails; maxEp: number }) {
  const open = useAvcStore((s) => s.episodesPanelOpen)
  const setOpen = useAvcStore((s) => s.setEpisodesPanelOpen)
  const currentEp = useAvcStore((s) => s.playback.currentEpisode)
  const totalCount =
    details.episodesTotal && details.episodesTotal > 0 ? details.episodesTotal : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Серии — {details.title}</DialogTitle>
        </DialogHeader>
        {maxEp > 0 ? (
          <EpisodeGrid
            title=""
            maxEp={maxEp}
            totalCount={totalCount}
            currentEp={currentEp}
            onPick={(n) => {
              void executeCommand({
                type: VoiceCommandType.SelectEpisode,
                params: { episode: n },
                confidence: 1,
                label: `Серия ${n}`,
              })
              setOpen(false)
            }}
          />
        ) : (
          <p className="text-sm text-zinc-500">Серии не найдены</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
