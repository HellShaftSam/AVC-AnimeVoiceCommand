'use client'
/**
 * TabContent — рендер активного места по kind: home / section / search / anime.
 *
 * Единая история навигации (ТЗ «вкладки → стрелки»): место ОДНО, вкладки не
 * создаются — содержание меняется по payload активной вкладки, история листается
 * стрелками NavBar. При смене места скролл уходит наверх (как в браузере).
 */
import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Dices,
  Loader2,
  SearchX,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AnimeGrid, AnimeGridSkeleton } from './anime-grid'
import { AnimeView } from './anime-view'
import { CatalogBrowser } from './catalog-browser'
import { RandomView } from './random-view'
import { ReleaseCalendar } from './release-calendar'
import { ScheduleView } from './schedule-view'
import { RecommendationsView } from './recommendations-view'
import { CompanionView } from './companion-view'
import { SectionPagination } from './section-pagination'
import { executeText } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { AnimeCard, BrowserTab, ReleaseDateInfo, SectionPage } from '@/lib/avc/types'

// --- Главная -----------------------------------------------------------------

interface DiagResult {
  name: string
  ok: boolean
  detail: string
}

const HINT_CHIPS: string[] = [
  'Открой топ сто',
  'Покажи онгоинги',
  'Найди Берсерк',
  'Следующая серия',
  'Сохрани этот момент',
]

function HomeView() {
  const [diag, setDiag] = useState<DiagResult[] | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)

  const runDiagnostics = async () => {
    setDiagLoading(true)
    setDiagError(null)
    try {
      const res = await fetch('/api/site/diagnostics')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { results?: DiagResult[] }
      setDiag(data.results ?? [])
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : 'Ошибка диагностики')
    } finally {
      setDiagLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl py-6">
      <div className="text-center">
        <div className="mb-4 flex items-center justify-center gap-3" aria-hidden>
          <span className="gold-hairline h-px w-16 sm:w-28" />
          <span className="h-1.5 w-1.5 rounded-full bg-gold-300 shadow-[0_0_10px_rgba(242,221,164,0.9)]" />
          <span className="gold-hairline h-px w-16 sm:w-28" />
        </div>
        <h2 className="bg-gradient-to-r from-gold-200 via-gold-400 to-gold-200 bg-clip-text text-2xl font-bold text-transparent md:text-4xl">
          Скажите команду или нажмите микрофон
        </h2>
        <p className="mt-3 text-sm text-muted-foreground md:text-base">
          Голосовое управление аниме-сайтом: поиск, каталоги, серии, озвучки и плеер.
          Навигация — стрелками в панели сверху (Alt+← / Alt+→), поиск — в той же строке (Ctrl+F).
          Удерживайте <kbd className="rounded border border-border bg-card px-1.5 py-0.5 text-xs">Ctrl + Space</kbd> или кнопку микрофона внизу.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {HINT_CHIPS.map((chip) => (
            <button
              key={chip}
              onClick={() => void executeText(chip, 'text')}
              className="min-h-11 rounded-full border border-border bg-card/60 px-4 text-sm text-foreground transition-all hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              «{chip}»
            </button>
          ))}
        </div>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {[
          { icon: SearchX, title: 'Поиск', text: '«Найди берсерк», «открой клейм» — совпадения покажутся списком: скажите номер. Или печатайте в строке поиска — тайтлы появляются по мере ввода.' },
          { icon: Sparkles, title: 'Сериалы', text: '«Следующая серия», «включи пятую», «озвучка anidub», «назад на 30 секунд».' },
          { icon: Dices, title: 'Витрина', text: '«Открой топ сто», «покажи онгоинги», «открой случайное» (с выбором жанра), «расписание».' },
          { icon: Loader2, title: 'Навигация', text: 'Стрелки назад/вперёд листают историю, как в браузере. Голосом: «назад», «вперёд».' },
        ].map(({ icon: Icon, title, text }) => (
          <div
            key={title}
            className="rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-border"
          >
            <div className="flex items-center gap-2 text-gold-400">
              <Icon className="h-5 w-5" aria-hidden />
              <span className="font-semibold text-foreground">{title}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 text-center">
        <Button
          variant="outline"
          onClick={() => void runDiagnostics()}
          disabled={diagLoading}
          className="min-h-11 border-border bg-card/60 hover:border-gold-400/40 hover:text-gold-300"
        >
          {diagLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Диагностика сайта
        </Button>
        {diagError && (
          <p className="mt-3 text-sm text-rose-400">✗ {diagError}</p>
        )}
        {diag && (
          <ul className="mx-auto mt-4 max-w-md space-y-1.5 text-left">
            {diag.map((d) => (
              <li
                key={d.name}
                className="flex items-start gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm"
              >
                {d.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="text-foreground">{d.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{d.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// --- Секция ---------------------------------------------------------------------

const PAGE_SIZE_FALLBACK = 1

function SectionView({ tab }: { tab: BrowserTab }) {
  const patchTab = useAvcStore((s) => s.patchTab)
  const navigate = useAvcStore((s) => s.navigate)
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const [data, setData] = useState<SectionPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')

  const section = typeof tab.payload.section === 'string' ? tab.payload.section : 'catalog'
  const page = typeof tab.payload.page === 'number' ? tab.payload.page : PAGE_SIZE_FALLBACK
  const requestKey = `${section}:${page}:${reloadCounter}`
  const loading = loadedKey !== requestKey
  /**
   * Даты выхода с точностью (анонсы: батч release-meta) — хранятся ВМЕСТЕ
   * с ключом запроса: смена секции/страницы автоматически «сбрасывает» их
   * без setState-in-effect (слияние только когда ключ совпадает).
   */
  const [releaseDates, setReleaseDates] = useState<{ key: string; map: Record<number, ReleaseDateInfo> } | null>(null)

  useEffect(() => {
    // Расписание рендерится отдельным видом (ScheduleView c своей загрузкой) —
    // здесь данные секции для него не нужны
    if (section === 'schedule') return
    let cancelled = false
    fetch(`/api/site/section/${encodeURIComponent(section)}?page=${page}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as SectionPage
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка загрузки секции')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [section, page, reloadCounter, requestKey])

  // Анонсы: один батч-запрос дат на страницу (кэш сервера 3 ч) — точность дат
  // (день/месяц/год/не объявлена) доезжает на плитки и календарь (ТЗ §3/§14.8)
  useEffect(() => {
    if (section !== 'announcements' || !data || data.items.length === 0) return
    let cancelled = false
    const ids = data.items.map((c) => c.animeId).slice(0, 40)
    fetch(`/api/site/release-meta?ids=${ids.join(',')}`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as { items: Record<number, { releaseDate: ReleaseDateInfo }> }) : null))
      .then((d) => {
        if (cancelled || !d) return
        const map: Record<number, ReleaseDateInfo> = {}
        for (const [id, meta] of Object.entries(d.items)) {
          if (meta?.releaseDate) map[Number(id)] = meta.releaseDate
        }
        setReleaseDates({ key: requestKey, map })
      })
      .catch(() => undefined) // без дат плитки честно молчат, секция не падает
    return () => {
      cancelled = true
    }
  }, [section, data, requestKey])

  useEffect(() => {
    // Синхронизация заголовка из данных сайта. Guard data.section === section:
    // при переходе секция→секция внутри НЕ перемонтированного вида старые data
    // («Анонсы») не должны перебивать свежий заголовок навигации («Расписание»)
    if (data && data.section === section && data.title && data.title !== tab.title) {
      patchTab(tab.id, { title: data.title })
    }
  }, [data, section, tab.id, tab.title, patchTab])

  // Переключение страницы = запись в единую историю (стрелки листают страницы тоже)
  const goToPage = (next: number) => {
    if (next < 1) return
    if (data?.totalPages != null && next > data.totalPages) return
    navigate({
      kind: 'section',
      title: tab.title,
      payload: { ...tab.payload, page: next },
    })
  }

  // Специальные виды секций (ВАЖНО: после всех хуков — Rules of Hooks)
  if (section === 'schedule') {
    return <ScheduleView />
  }
  if (section === 'random') {
    return <RandomView tab={tab} />
  }
  if (section === 'catalog') {
    return <CatalogBrowser />
  }

  const isAnnouncements = section === 'announcements'
  // Слитые карточки: даты с точностью прилетают в бейдж плитки и календарь
  // (ключ гарантирует, что даты не от старой страницы не смешаются с новой)
  const releaseMap = releaseDates && releaseDates.key === requestKey ? releaseDates.map : null
  const mergedItems =
    data && isAnnouncements && releaseMap
      ? data.items.map((c) => ({ ...c, releaseDate: releaseMap[c.animeId] ?? null }))
      : data?.items ?? []

  return (
    <div>
      {/* Липкая пагинация сверху (ТЗ п.5: доступна в ЛЮБОЙ момент скролла) */}
      {!loading && !error && data && data.totalPages != null && data.totalPages > 1 && (
        <SectionPagination page={page} totalPages={data.totalPages} onGo={goToPage} sticky />
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{data?.title ?? tab.title}</h2>
        <div className="flex items-center gap-2">
          {data?.source === 'demo' && (
            <Badge className="border border-gold-400/40 bg-gold-400/40 text-gold-300">
              Демо-данные (сайт недоступен)
            </Badge>
          )}
          {data?.totalPages != null && data.totalPages > 1 && (
            <span className="text-sm text-muted-foreground">
              Страница {page} из {data.totalPages}
            </span>
          )}
        </div>
      </div>

      {loading && <AnimeGridSkeleton />}
      {!loading && error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
          ✗ {error}
          <div className="mt-3">
            <Button
              variant="outline"
              onClick={() => useAvcStore.getState().bumpReload(tab.id)}
              className="min-h-11 border-border"
            >
              Повторить
            </Button>
          </div>
        </div>
      )}
      {!loading && !error && data && <AnimeGrid items={mergedItems} />}
      {!loading && !error && data && data.items.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">Секция пуста</p>
      )}

      {/* Анонсы: календарь релизов с листанием месяцев (ТЗ п.3) */}
      {!loading && !error && data && isAnnouncements && data.items.length > 0 && (
        <ReleaseCalendar cards={mergedItems} datesLoading={isAnnouncements && releaseMap === null} />
      )}

      {/* Полная нумерованная пагинация под сеткой */}
      {!loading && !error && data && data.totalPages != null && data.totalPages > 1 && (
        <div className="mt-6 border-t border-border pt-4">
          <SectionPagination page={page} totalPages={data.totalPages} onGo={goToPage} />
        </div>
      )}
    </div>
  )
}

// --- Поиск (живой, по мере ввода — ТЗ п.2) ---------------------------------------

interface SuggestResponse {
  query: string
  items: AnimeCard[]
  mode: 'site' | 'index' | 'empty' | string
  error?: string
}

function SearchView({ tab }: { tab: BrowserTab }) {
  const query = typeof tab.payload.query === 'string' ? tab.payload.query : ''
  const live = tab.payload.live === true
  // Дебаунс 250 мс: тайтлы появляются по мере ввода, но без запроса на каждый символ
  const [debounced, setDebounced] = useState(query)
  const [items, setItems] = useState<AnimeCard[] | null>(null)
  const [mode, setMode] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 250)
    return () => window.clearTimeout(id)
  }, [query])

  const requestKey = `q:${debounced}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    const trimmed = debounced.trim()
    if (!trimmed) {
      // пустой запрос — сброс результатов (в отложенном тике: set-state-in-effect)
      const id = window.setTimeout(() => {
        setItems(null)
        setError(null)
        setLoadedKey('q:')
      }, 0)
      return () => window.clearTimeout(id)
    }
    let cancelled = false
    fetch(`/api/site/suggest?q=${encodeURIComponent(trimmed)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as SuggestResponse
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? [])
        setMode(d.mode ?? 'site')
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка поиска')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [debounced])

  const waiting = live && query.trim() !== debounced.trim()

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">
          Поиск: <span className="text-gold-300">{query}</span>
        </h2>
        {mode === 'index' && (
          <Badge variant="outline" className="border-border text-xs text-muted-foreground">
            короткий запрос — популярные тайтлы
          </Badge>
        )}
        {(loading || waiting) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
      </div>

      {(!live && query.trim() === '') || (live && query.trim() === '') ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Начните вводить название в строке поиска сверху (Ctrl+F) — тайтлы появятся здесь
        </p>
      ) : (
        <>
          {(loading || waiting) && items === null && <AnimeGridSkeleton />}
          {!loading && !waiting && error && <p className="text-sm text-rose-400">✗ {error}</p>}
          {!loading && !waiting && items !== null && items.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Ничего не найдено по запросу «{query}»
            </p>
          )}
          {!loading && !waiting && items !== null && items.length > 0 && (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Найдено: {items.length}. Сначала — названия, начинающиеся с запроса, затем совпадения внутри названия.
              </p>
              <AnimeGrid items={items} />
            </>
          )}
        </>
      )}
    </div>
  )
}

// --- переключатель ---------------------------------------------------------------

export function TabContent({ tab }: { tab: BrowserTab }) {
  // Смена места (навигация/стрелки/страница) — контент начинается сверху,
  // как в браузере. Ключ = payload: заголовки (title) скролл не трогают.
  const payloadKey = JSON.stringify(tab.payload ?? {})
  useEffect(() => {
    document.getElementById('avc-content')?.scrollTo({ top: 0 })
  }, [payloadKey])

  switch (tab.kind) {
    case 'home':
      return <HomeView />
    case 'section':
      return <SectionView tab={tab} />
    case 'search':
      return <SearchView tab={tab} />
    case 'anime':
      return <AnimeView tab={tab} />
    case 'recommendations':
      return <RecommendationsView />
    case 'companion':
      return <CompanionView tab={tab} />
    default:
      return <HomeView />
  }
}
