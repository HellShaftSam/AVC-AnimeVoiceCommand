'use client'
/**
 * AnimeView — вкладка аниме: постер, инфо, бейджи, озвучки, сетка серий,
 * диалог «Серии» (ShowEpisodes) и плеер.
 */
import { useEffect, useState } from 'react'
import { Film, RotateCw, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Player } from './player'
import {
  executeCommand,
  getCachedDetails,
  maxEpisodeOf,
  syncPlaybackToDetails,
} from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { AnimeDetails, BrowserTab } from '@/lib/avc/types'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

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

  const pickEpisode = (n: number) => {
    void executeCommand({
      type: VoiceCommandType.SelectEpisode,
      params: { episode: n },
      confidence: 1,
      label: `Серия ${n}`,
    })
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
          <h2 className="text-xl font-bold md:text-2xl">{details.title}</h2>
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

          <p className="mt-3 text-sm text-zinc-400">
            Серия <span className="font-semibold text-amber-300">{currentEp ?? '—'}</span> из{' '}
            {maxEp > 0 ? maxEp : '—'} · Озвучка:{' '}
            <span className="text-zinc-200">{playback.currentDub ?? 'не выбрана'}</span>
          </p>

          {details.dubs.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">
                Озвучки
              </div>
              <div className="flex flex-wrap gap-2">
                {details.dubs.map((d) => {
                  const active = playback.currentDub === d.name
                  return (
                    <button
                      key={d.name}
                      onClick={() =>
                        void executeCommand({
                          type: VoiceCommandType.SelectVoice,
                          params: { dub: d.shortName },
                          confidence: 1,
                          label: `Озвучка ${d.shortName}`,
                        })
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
                        <span className="ml-1 text-zinc-500">({d.episodes.length})</span>
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
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Серии
          </h3>
          <div className="avc-scroll grid max-h-64 grid-cols-6 gap-2 overflow-y-auto pr-1 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
            {Array.from({ length: maxEp }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => pickEpisode(n)}
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
        </div>
      )}

      <div className="mt-6">
        <Player />
      </div>

      <EpisodesDialog details={details} maxEp={maxEp} />
    </div>
  )
}

function EpisodesDialog({ details, maxEp }: { details: AnimeDetails; maxEp: number }) {
  const open = useAvcStore((s) => s.episodesPanelOpen)
  const setOpen = useAvcStore((s) => s.setEpisodesPanelOpen)
  const currentEp = useAvcStore((s) => s.playback.currentEpisode)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Серии — {details.title}</DialogTitle>
        </DialogHeader>
        {maxEp > 0 ? (
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
            {Array.from({ length: maxEp }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => {
                  void executeCommand({
                    type: VoiceCommandType.SelectEpisode,
                    params: { episode: n },
                    confidence: 1,
                    label: `Серия ${n}`,
                  })
                  setOpen(false)
                }}
                aria-label={`Включить серию ${n}`}
                className={cn(
                  'min-h-11 rounded-lg border text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                  currentEp === n
                    ? 'border-amber-400 bg-amber-400/15 text-amber-300'
                    : 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-amber-400/40',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Серии не найдены</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
