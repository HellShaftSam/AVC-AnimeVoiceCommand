'use client'
/**
 * RandomView — вкладка «Случайное» (ТЗ §15: полноценный выбор по жанрам и
 * ПРЯМОЙ переход на страницу выбранного аниме).
 *
 * Что было сломано (жалоба владельца): жанр фактически не влиял на выборку,
 * результат висел маленькой карточкой и открывался только по кнопке.
 * Теперь:
 *  - мультивыбор жанров: пересечение категорий сайта (тайтл подходит под ВСЕ
 *    выбранные жанры, как в фильтрах каталога);
 *  - «Крутить» сразу открывает полноценную страницу аниме через штатную
 *    навигацию (та же страница, что из каталога/поиска: серии, плеер, списки);
 *  - пустое пересечение → честное «ничего не найдено», без подмены случайным
 *    неподходящим тайтлом;
 *  - выбранные жанры живут в payload вкладки — «назад» возвращает к выбору
 *    с сохранёнными фильтрами;
 *  - «Из всех» — прежнее поведение /catalog/random.
 */
import { useEffect, useMemo, useState } from 'react'
import { Dices, Loader2, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openAnimeCard } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { AnimeCard, BrowserTab } from '@/lib/avc/types'
import { GENRE_ALIASES, genreLabel } from '@/lib/voice/genre-aliases'
import { cn } from '@/lib/utils'

const GENRE_PAGES = 2

/** Уникальные слаги жанров с человеческими подписями, по алфавиту */
const GENRES: Array<{ slug: string; label: string }> = [...new Set(Object.values(GENRE_ALIASES))]
  .map((slug) => ({ slug, label: genreLabel(slug) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'ru'))

export function RandomView({ tab }: { tab: BrowserTab }) {
  const patchTab = useAvcStore((s) => s.patchTab)
  // Жанры — в payload вкладки: «назад» возвращает к сохранённому выбору
  const initialGenres = useMemo<string[]>(() => {
    const raw = tab.payload.genres
    return Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : []
  }, [tab.payload.genres])

  const [genres, setGenres] = useState<string[]>(initialGenres)
  const [spinning, setSpinning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** id последней крутки — чтобы повторный клик давал новый результат */
  const [spinCount, setSpinCount] = useState(0)

  // Payload вкладки обновляем только при реальном изменении выбора
  useEffect(() => {
    const same =
      genres.length === initialGenres.length && genres.every((g) => initialGenres.includes(g))
    if (!same) {
      patchTab(tab.id, { payload: { ...tab.payload, genres } })
    }
  }, [genres, initialGenres, patchTab, tab.id, tab.payload])

  const toggleGenre = (slug: string) =>
    setGenres((prev) => (prev.includes(slug) ? prev.filter((g) => g !== slug) : [...prev, slug]))

  const spin = async () => {
    setSpinning(true)
    setError(null)
    setNotice(null)
    try {
      if (genres.length === 0) {
        // «Из всех» — прежний честный рандом сайта
        const res = await fetch('/api/site/random', { cache: 'no-store' })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `HTTP ${res.status}`)
        }
        const details = (await res.json()) as AnimeCard
        if (!details || !details.slug) throw new Error('Сайт не вернул тайтл')
        await openAnimeCard(details, false) // сразу на полноценную страницу
        setSpinCount((n) => n + 1)
        return
      }

      // Пересечение категорий: тайтл входит в КАЖДЫЙ выбранный жанр
      const perGenre: Map<number, AnimeCard>[] = []
      for (const genre of genres) {
        const map = new Map<number, AnimeCard>()
        for (let p = 1; p <= GENRE_PAGES; p++) {
          const res = await fetch(`/api/site/category?genre=${encodeURIComponent(genre)}&page=${p}`)
          if (!res.ok) {
            if (p === 1) throw new Error(`Жанр «${genreLabel(genre)}» недоступен`)
            break
          }
          const data = (await res.json()) as { items: AnimeCard[] }
          for (const card of data.items) map.set(card.animeId, card)
        }
        perGenre.push(map)
      }

      const first = perGenre[0]
      const matched: AnimeCard[] = []
      for (const [id, card] of first) {
        if (perGenre.every((m) => m.has(id))) matched.push(card)
      }

      if (matched.length === 0) {
        // Честный отказ (ТЗ §15.2): не подменяем случайным неподходящим тайтлом
        setError(
          `По жанрам «${genres.map(genreLabel).join(' + ')}» ничего не нашлось. Уберите часть жанров и попробуйте снова.`,
        )
        return
      }

      setNotice(`Подходящих тайтлов: ${matched.length} — круткой выбран один`)
      const card = matched[Math.floor(Math.random() * matched.length)]
      await openAnimeCard(card, false) // сразу на полноценную страницу
      setSpinCount((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось получить случайное аниме')
    } finally {
      setSpinning(false)
    }
  }

  const spinKey = `spin-${spinCount}`

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Dices className="h-5 w-5 text-gold-400" aria-hidden />
          Случайное аниме
        </h2>
        <div className="flex items-center gap-2">
          {genres.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGenres([])}
              disabled={spinning}
              aria-label="Сбросить выбранные жанры"
              className="min-h-11 gap-1 border-border bg-card/60"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Сбросить ({genres.length})
            </Button>
          )}
          <Button
            onClick={() => void spin()}
            disabled={spinning}
            data-testid="random-spin"
            className="min-h-11 bg-gold-400/20 font-semibold text-gold-200 hover:bg-gold-400/30"
          >
            {spinning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Dices className="h-4 w-4" aria-hidden />}
            {genres.length > 0
              ? `Крутить: ${genres.map(genreLabel).join(' + ')}`
              : 'Крутить из всех'}
          </Button>
        </div>
      </div>

      {/* Чипы жанров: мультивыбор (ТЗ §15.2) — пересечение жанров */}
      <div
        role="group"
        aria-label="Жанры случайного аниме (можно выбрать несколько)"
        className="avc-scroll mb-5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-border bg-card/40 p-2.5"
      >
        <button
          role="checkbox"
          aria-checked={genres.length === 0}
          data-testid="random-genre-all"
          onClick={() => setGenres([])}
          className={cn(
            'min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            genres.length === 0
              ? 'border-gold-400 bg-gold-400/30 text-gold-200'
              : 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300',
          )}
        >
          Из всех
        </button>
        {GENRES.map((g) => {
          const on = genres.includes(g.slug)
          return (
            <button
              key={g.slug}
              role="checkbox"
              aria-checked={on}
              data-testid={`random-genre-${g.slug}`}
              onClick={() => toggleGenre(g.slug)}
              className={cn(
                'min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                on
                  ? 'border-gold-400 bg-gold-400/30 text-gold-200'
                  : 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300',
              )}
            >
              {g.label}
            </button>
          )
        })}
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Выберите один или несколько жанров и нажмите «Крутить» — откроется полноценная страница
        случайного тайтла, подходящего под ВСЕ выбранные жанры.
      </p>

      {spinning && (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status" data-testid="random-loading">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Кручу каталог…
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-center text-sm text-rose-300" data-testid="random-error">
          ✗ {error}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {genres.length > 0 && (
              <Button
                variant="outline"
                onClick={() => setGenres([])}
                disabled={spinning}
                className="min-h-11 border-border bg-card/60"
              >
                <X className="h-4 w-4" aria-hidden />
                Сбросить жанры
              </Button>
            )}
            <Button variant="outline" onClick={() => void spin()} disabled={spinning} className="min-h-11 border-border">
              <RotateCw className="h-4 w-4" aria-hidden />
              Повторить
            </Button>
          </div>
        </div>
      )}

      {!spinning && !error && !notice && genres.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground" key={spinKey} data-testid="random-empty">
          Выберите жанр или нажмите «Крутить из всех» — страница аниме откроется сразу
        </p>
      )}
    </div>
  )
}
