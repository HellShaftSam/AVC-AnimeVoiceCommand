'use client'
/**
 * RandomView — вкладка «Случайное» с выбором жанра (ТЗ п.4: «можно было
 * выбирать случайное по жанрам, а не просто случайно из всего списка»).
 *
 * Жанры — слаги категорий сайта (тот же словарь, что голосовые алиасы).
 * «Из всех» — прежнее поведение (/catalog/random); жанр — рандом внутри
 * категории сайта (getRandomByGenre с окном исключений). Честные ошибки:
 * у жанра нет тайтлов/сайт недоступен — сообщение, не молчание.
 */
import { useMemo, useState } from 'react'
import { Dices, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openAnimeCard } from '@/lib/avc/executor'
import type { AnimeCard } from '@/lib/avc/types'
import { GENRE_ALIASES, genreLabel } from '@/lib/voice/genre-aliases'
import { cn } from '@/lib/utils'

export function RandomView() {
  const [genre, setGenre] = useState<string | null>(null)
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<AnimeCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Счётчик круток — ключ перерендера плитки результата */
  const [spinCount, setSpinCount] = useState(0)

  /** Уникальные слаги жанров с человеческими подписями, по алфавиту */
  const genres = useMemo(() => {
    const uniq = [...new Set(Object.values(GENRE_ALIASES))]
    return uniq
      .map((slug) => ({ slug, label: genreLabel(slug) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  }, [])

  const spin = async () => {
    setSpinning(true)
    setError(null)
    try {
      const url = genre
        ? `/api/site/random-by-genre?genre=${encodeURIComponent(genre)}`
        : '/api/site/random'
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { card?: AnimeCard } | AnimeCard
      // random-by-genre → {card}, /api/site/random → AnimeDetails (плоский объект)
      const card = 'card' in data && data.card ? data.card : (data as AnimeCard)
      if (!card || !card.slug) throw new Error('Сайт не вернул тайтл')
      setResult(card)
      setSpinCount((n) => n + 1)
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : 'Не удалось получить случайное аниме')
    } finally {
      setSpinning(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Dices className="h-5 w-5 text-gold-400" aria-hidden />
          Случайное аниме
        </h2>
        <Button
          onClick={() => void spin()}
          disabled={spinning}
          data-testid="random-spin"
          className="min-h-11 bg-gold-400/20 font-semibold text-gold-200 hover:bg-gold-400/30"
        >
          {spinning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Dices className="h-4 w-4" aria-hidden />}
          {genre ? `Крутить: ${genreLabel(genre)}` : 'Крутить из всех'}
        </Button>
      </div>

      {/* Чипы жанров (мультивыбор НЕ нужен: рандом — в ОДНОМ жанре за крутку) */}
      <div
        role="radiogroup"
        aria-label="Жанр случайного аниме"
        className="avc-scroll mb-5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-border bg-card/40 p-2.5"
      >
        <button
          role="radio"
          aria-checked={genre === null}
          data-testid="random-genre-all"
          onClick={() => setGenre(null)}
          className={cn(
            'min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            genre === null
              ? 'border-gold-400 bg-gold-400/30 text-gold-200'
              : 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300',
          )}
        >
          Из всех
        </button>
        {genres.map((g) => (
          <button
            key={g.slug}
            role="radio"
            aria-checked={genre === g.slug}
            data-testid={`random-genre-${g.slug}`}
            onClick={() => setGenre(g.slug)}
            className={cn(
              'min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              genre === g.slug
                ? 'border-gold-400 bg-gold-400/30 text-gold-200'
                : 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300',
            )}
          >
            {g.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-center text-sm text-rose-300">
          ✗ {error}
          <div className="mt-2">
            <Button variant="outline" onClick={() => void spin()} disabled={spinning} className="min-h-11 border-border">
              <RotateCw className="h-4 w-4" aria-hidden />
              Повторить
            </Button>
          </div>
        </div>
      )}

      {result && !error && (
        <div
          key={spinCount}
          data-testid="random-result"
          className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-xl border border-gold-400/25 bg-card/60 p-4 sm:flex-row"
        >
          {result.poster ? (
            <img
              src={result.poster}
              alt={`Постер: ${result.title}`}
              className="h-48 w-32 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : (
            <div className="flex h-48 w-32 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
              <Dices className="h-6 w-6" aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="text-base font-bold text-foreground">{result.title}</p>
            <p className="mt-1 flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:justify-start">
              {result.year !== null && <span>{result.year}</span>}
              {result.type && <span>· {result.type}</span>}
              {result.status && <span>· {result.status}</span>}
              {result.rating !== null && result.rating > 0 && <span>· ★ {result.rating.toFixed(1)}</span>}
            </p>
            {genre && (
              <p className="mt-1 text-xs text-gold-300">Жанр: {genreLabel(genre)}</p>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
              <Button
                onClick={() => void openAnimeCard(result, true)}
                className="min-h-11 bg-gold-400/20 font-semibold text-gold-200 hover:bg-gold-400/30"
              >
                Открыть
              </Button>
              <Button
                variant="outline"
                onClick={() => void spin()}
                disabled={spinning}
                className="min-h-11 border-border bg-card/60"
              >
                <Dices className="h-4 w-4" aria-hidden />
                Ещё раз
              </Button>
            </div>
          </div>
        </div>
      )}

      {!result && !error && !spinning && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Выберите жанр (или «Из всех») и нажмите «Крутить»
        </p>
      )}
    </div>
  )
}
