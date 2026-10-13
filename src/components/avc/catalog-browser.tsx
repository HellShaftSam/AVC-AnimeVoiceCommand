'use client'
/**
 * CatalogBrowser — вкладка «Каталог» с фильтрами (ТЗ п.4: «фильтр по жанрам,
 * датам, годам и тд. НО чтобы можно было выбирать несколько вариантов»).
 *
 * Механика (честная, без выдумок):
 *  - Жанры (мультивыбор): пересечение категорий сайта — карточки, входящие
 *    в КАЖДЫЙ выбранный жанр (по первым K страницам каждой категории).
 *  - Годы и статус: метаданные из деталей через POST /api/site/enrich
 *    (кэш адаптера 5 мин; сайт своих фильтров не имеет).
 *  - Без фильтров — обычная постраничная навигация сайта.
 *  - С фильтрами — клиентская пагинация отфильтрованного списка (24/стр).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Loader2, RotateCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AnimeGrid, AnimeGridSkeleton } from './anime-grid'
import { SectionPagination } from './section-pagination'
import type { AnimeCard, SectionPage } from '@/lib/avc/types'
import { GENRE_ALIASES, genreLabel } from '@/lib/voice/genre-aliases'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 24
/** Глубина выборки кандидатов: страниц категории жанра / каталога */
const GENRE_PAGES = 3
const CATALOG_PAGES = 4

const STATUS_CHIPS = ['онгоинг', 'анонс', 'вышел'] as const
const YEAR_QUICK = [2026, 2025, 2024, 2023] as const

interface EnrichItem {
  year: number | null
  rating: number | null
  status: string | null
}

interface CatalogFilters {
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  statuses: string[]
}

const EMPTY_FILTERS: CatalogFilters = { genres: [], yearFrom: null, yearTo: null, statuses: [] }

function filtersActive(f: CatalogFilters): boolean {
  return f.genres.length > 0 || f.yearFrom !== null || f.yearTo !== null || f.statuses.length > 0
}

/** Уникальные слаги жанров с подписями */
const GENRES: Array<{ slug: string; label: string }> = [
  ...new Set(Object.values(GENRE_ALIASES)),
]
  .map((slug) => ({ slug, label: genreLabel(slug) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'ru'))

export function CatalogBrowser() {
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS)
  const [panelOpen, setPanelOpen] = useState(false)

  // Обычный режим (без фильтров): серверная пагинация сайта
  const [sitePage, setSitePage] = useState(1)
  const [siteData, setSiteData] = useState<SectionPage | null>(null)
  const [siteError, setError] = useState<string | null>(null)
  const [siteLoadedKey, setSiteLoadedKey] = useState('')

  // Фильтрованный режим: пул кандидатов + клиентская пагинация
  const [pool, setPool] = useState<AnimeCard[] | null>(null)
  const [poolLoading, setPoolLoading] = useState(false)
  const [poolNotice, setPoolNotice] = useState<string | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)
  const [clientPage, setClientPage] = useState(1)
  const runIdRef = useRef(0)

  const active = filtersActive(filters)

  // --- загрузка без фильтров (сайт) -----------------------------------------
  useEffect(() => {
    if (active) return
    let cancelled = false
    const key = `site:${sitePage}`
    fetch(`/api/site/section/catalog?page=${sitePage}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as SectionPage
      })
      .then((d) => {
        if (cancelled) return
        setSiteData(d)
        setError(null)
        setSiteLoadedKey(key)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка загрузки каталога')
        setSiteLoadedKey(key)
      })
    return () => {
      cancelled = true
    }
  }, [sitePage, active])

  // --- загрузка с фильтрами --------------------------------------------------
  const loadPool = useCallback(async (f: CatalogFilters) => {
    const runId = ++runIdRef.current
    setPoolLoading(true)
    setPoolError(null)
    setPoolNotice(null)
    try {
      let candidates: AnimeCard[] = []
      let truncated = false

      if (f.genres.length > 0) {
        // Пересечение категорий: карточки, входящие в КАЖДЫЙ выбранный жанр
        const perGenre: Map<number, AnimeCard>[] = []
        for (const genre of f.genres) {
          const map = new Map<number, AnimeCard>()
          // страницы жанра — последовательно (кэш адаптера делает это дешёвым)
          for (let p = 1; p <= GENRE_PAGES; p++) {
            const res = await fetch(`/api/site/category?genre=${encodeURIComponent(genre)}&page=${p}`)
            if (!res.ok) {
              if (p === 1) throw new Error(`Жанр «${genreLabel(genre)}» недоступен`)
              break
            }
            const data = (await res.json()) as SectionPage
            for (const card of data.items) map.set(card.animeId, card)
            if (data.totalPages != null && p >= data.totalPages) break
          }
          perGenre.push(map)
        }
        if (runId !== runIdRef.current) return
        if (perGenre.length > 0) {
          const first = perGenre[0]
          for (const [id, card] of first) {
            if (perGenre.every((m) => m.has(id))) candidates.push(card)
          }
        }
        truncated = f.genres.length > 0 && candidates.length >= GENRE_PAGES * PAGE_SIZE
      } else {
        // Каталог: первые CATALOG_PAGES страниц
        const responses = await Promise.all(
          Array.from({ length: CATALOG_PAGES }, (_, i) =>
            fetch(`/api/site/section/catalog?page=${i + 1}`)
              .then((r) => (r.ok ? (r.json() as Promise<SectionPage>) : null))
              .catch(() => null),
          ),
        )
        if (runId !== runIdRef.current) return
        const seen = new Set<number>()
        for (const r of responses) {
          for (const card of r?.items ?? []) {
            if (seen.has(card.animeId)) continue
            seen.add(card.animeId)
            candidates.push(card)
          }
        }
        truncated = responses.some((r) => r?.totalPages != null && r.totalPages > CATALOG_PAGES)
      }

      // Годы/статус: обогащение метаданными деталей
      if (f.yearFrom !== null || f.yearTo !== null || f.statuses.length > 0) {
        const ids = candidates.map((c) => c.animeId).slice(0, 120)
        const enrichRes = await fetch('/api/site/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (runId !== runIdRef.current) return
        if (!enrichRes.ok) {
          const data = (await enrichRes.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? 'Не удалось получить метаданные для фильтра')
        }
        const data = (await enrichRes.json()) as { items: Record<number, EnrichItem> }
        candidates = candidates.filter((c) => {
          const e = data.items[c.animeId]
          if (!e) return false // нет метаданных — не показываем под фильтром
          if (f.yearFrom !== null && (e.year === null || e.year < f.yearFrom)) return false
          if (f.yearTo !== null && (e.year === null || e.year > f.yearTo)) return false
          if (f.statuses.length > 0) {
            const st = (e.status ?? '').toLowerCase()
            if (!f.statuses.some((s) => st.includes(s))) return false
          }
          return true
        })
        if (candidates.length > ids.length) {
          // кандидатов больше капа обогащения — честная пометка
          truncated = true
        }
      }

      if (runId !== runIdRef.current) return
      setPool(candidates)
      setClientPage(1)
      const bits: string[] = [`Найдено: ${candidates.length}`]
      if (truncated) {
        bits.push(
          f.genres.length > 0
            ? `выборка по первым ${GENRE_PAGES} страницам каждого жанра`
            : `выборка по первым ${CATALOG_PAGES} страницам каталога`,
        )
      }
      setPoolNotice(bits.join(' · '))
    } catch (e) {
      if (runId !== runIdRef.current) return
      setPool(null)
      setPoolError(e instanceof Error ? e.message : 'Ошибка фильтрации')
    } finally {
      if (runId === runIdRef.current) setPoolLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void loadPool(filters)
    else setPool(null)
  }, [filters, active, loadPool])

  const toggleGenre = (slug: string) =>
    setFilters((f) => ({
      ...f,
      genres: f.genres.includes(slug) ? f.genres.filter((g) => g !== slug) : [...f.genres, slug],
    }))
  const toggleStatus = (s: string) =>
    setFilters((f) => ({
      ...f,
      statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s],
    }))

  // Рендер-данные
  const clientTotalPages = pool ? Math.max(1, Math.ceil(pool.length / PAGE_SIZE)) : 1
  const clientItems = pool ? pool.slice((clientPage - 1) * PAGE_SIZE, clientPage * PAGE_SIZE) : []
  const siteLoading = siteLoadedKey !== `site:${sitePage}`

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Каталог</h2>
        <div className="flex items-center gap-2">
          {siteData?.source === 'demo' && (
            <Badge className="border border-gold-400/40 bg-gold-400/40 text-gold-300">
              Демо-данные (сайт недоступен)
            </Badge>
          )}
          <Button
            variant={active ? 'default' : 'outline'}
            size="sm"
            aria-expanded={panelOpen}
            aria-label="Фильтры каталога"
            data-testid="catalog-filter-toggle"
            onClick={() => setPanelOpen((v) => !v)}
            className={cn(
              'min-h-11 gap-1.5 border-border',
              active ? 'bg-gold-400/25 font-semibold text-gold-200' : 'bg-card/60',
            )}
          >
            <Filter className="h-4 w-4" aria-hidden />
            Фильтры{active ? ` (${filters.genres.length + filters.statuses.length + (filters.yearFrom !== null || filters.yearTo !== null ? 1 : 0)})` : ''}
          </Button>
        </div>
      </div>

      {/* Панель фильтров */}
      {panelOpen && (
        <div className="mb-4 space-y-3 rounded-xl border border-border bg-card/50 p-3" data-testid="catalog-filters">
          {/* Жанры: мультивыбор */}
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Жанры (мультивыбор — пересечение)
            </p>
            <div className="avc-scroll flex max-h-32 flex-wrap gap-1.5 overflow-y-auto" data-testid="catalog-genres">
              {GENRES.map((g) => {
                const on = filters.genres.includes(g.slug)
                return (
                  <button
                    key={g.slug}
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleGenre(g.slug)}
                    className={cn(
                      'min-h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      on
                        ? 'border-gold-400 bg-gold-400/30 text-gold-200'
                        : 'border-border bg-card/60 text-foreground hover:border-gold-400/40',
                    )}
                  >
                    {g.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Годы */}
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Годы:</p>
            {YEAR_QUICK.map((y) => {
              const on = filters.yearFrom === y && filters.yearTo === y
              return (
                <button
                  key={y}
                  role="checkbox"
                  aria-checked={on}
                  onClick={() =>
                    setFilters((f) => ({ ...f, yearFrom: on ? null : y, yearTo: on ? null : y }))
                  }
                  className={cn(
                    'min-h-8 rounded-full border px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    on
                      ? 'border-gold-400 bg-gold-400/30 text-gold-200'
                      : 'border-border bg-card/60 text-foreground hover:border-gold-400/40',
                  )}
                >
                  {y}
                </button>
              )
            })}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              от
              <input
                type="number"
                min={1950}
                max={2030}
                value={filters.yearFrom ?? ''}
                aria-label="Год от"
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    yearFrom: e.target.value ? parseInt(e.target.value, 10) : null,
                  }))
                }
                className="h-8 w-20 rounded-md border border-border bg-card px-2 text-foreground focus:border-gold-400/50 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              до
              <input
                type="number"
                min={1950}
                max={2030}
                value={filters.yearTo ?? ''}
                aria-label="Год до"
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    yearTo: e.target.value ? parseInt(e.target.value, 10) : null,
                  }))
                }
                className="h-8 w-20 rounded-md border border-border bg-card px-2 text-foreground focus:border-gold-400/50 focus:outline-none"
              />
            </label>
          </div>

          {/* Статус: мультивыбор */}
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Статус:</p>
            {STATUS_CHIPS.map((s) => {
              const on = filters.statuses.includes(s)
              return (
                <button
                  key={s}
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'min-h-8 rounded-full border px-3 text-xs font-medium capitalize transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    on
                      ? 'border-gold-400 bg-gold-400/30 text-gold-200'
                      : 'border-border bg-card/60 text-foreground hover:border-gold-400/40',
                  )}
                >
                  {s}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
              disabled={!active}
              className="min-h-9 gap-1.5 border-border bg-card/60"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Сбросить
            </Button>
            <p className="text-xs text-muted-foreground">
              Тайтлы должны иметь ВСЕ выбранные жанры. Годы/статус — по данным деталей тайтла.
            </p>
          </div>
        </div>
      )}

      {/* Контент: фильтрованный пул или страницы сайта */}
      {active ? (
        <>
          {poolLoading && (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Подбираю тайтлы по фильтрам…
            </p>
          )}
          {!poolLoading && poolError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
              ✗ {poolError}
              <div className="mt-3">
                <Button variant="outline" onClick={() => void loadPool(filters)} className="min-h-11 border-border">
                  <RotateCw className="h-4 w-4" aria-hidden />
                  Повторить
                </Button>
              </div>
            </div>
          )}
          {!poolLoading && !poolError && pool && (
            <>
              {poolNotice && (
                <p className="mb-3 text-xs text-muted-foreground" data-testid="catalog-notice">{poolNotice}</p>
              )}
              {clientItems.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  По выбранным фильтрам ничего не найдено
                </p>
              ) : (
                <AnimeGrid items={clientItems} />
              )}
              {clientTotalPages > 1 && (
                <div className="mt-6 border-t border-border pt-4">
                  <SectionPagination
                    page={clientPage}
                    totalPages={clientTotalPages}
                    onGo={setClientPage}
                    sticky
                  />
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {siteLoading && <AnimeGridSkeleton />}
          {!siteLoading && siteError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
              ✗ {siteError}
              <div className="mt-3">
                <Button
                  variant="outline"
                  onClick={() => setSiteLoadedKey('')}
                  className="min-h-11 border-border"
                >
                  Повторить
                </Button>
              </div>
            </div>
          )}
          {!siteLoading && !siteError && siteData && <AnimeGrid items={siteData.items} />}
          {!siteLoading && !siteError && siteData && siteData.items.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">Секция пуста</p>
          )}
          {!siteLoading && !siteError && siteData && siteData.totalPages != null && siteData.totalPages > 1 && (
            <div className="mt-6 border-t border-border pt-4">
              <SectionPagination
                page={sitePage}
                totalPages={siteData.totalPages}
                onGo={setSitePage}
                sticky
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
