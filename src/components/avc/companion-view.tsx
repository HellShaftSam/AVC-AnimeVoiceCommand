'use client'
/**
 * CompanionView — вкладка «Anime Companion» (kind='companion', ТЗ v1.0.33 §Anime Companion).
 *
 * Поднавигация (payload.sub, без новых вкладок браузера):
 *   Обзор | Компас | Хроники | Вкусы | Квесты | Персонажи
 *   + ссылки на существующие вкладки: «Рекомендации» и «Календарь» (расписание).
 *
 * Все загрузки — только при монтировании подвида (без таймеров/поллинга;
 * локальный debounce поиска в Хрониках — осознанное исключение из ТЗ подраздела).
 * Контракты API зафиксированы в docs/ANIME_COMPANION_AUDIT.md и дублируются здесь
 * узкими локальными типами (не импортируем серверные модули).
 *
 * Честные состояния в каждом подразделе: загрузка (скелетоны), ошибка с повтором,
 * пусто с честной подсказкой. Стиль — Celestial Dark Fantasy: bg-card/60 панели,
 * золотые акценты, gold-hairline, constellation-node; ноль backdrop/blur.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveMoodQuery } from '@/lib/companion/mood'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  CalendarDays,
  Check,
  Compass,
  EyeOff,
  Info,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Palette,
  Pencil,
  Play,
  Plus,
  Quote,
  RefreshCw,
  Sparkles,
  StickyNote,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { AnimeGrid, AnimeGridSkeleton } from './anime-grid'
import {
  COMPANION_SUB_LABELS,
  openAnimeCard,
  openRecommendations,
  openSection,
} from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type {
  AnimeCard,
  AnimeDetails,
  BrowserTab,
  CompanionSub,
  WatchProgressItem,
} from '@/lib/avc/types'
import { cn } from '@/lib/utils'

// --- контракты API (docs/ANIME_COMPANION_AUDIT.md §10) ------------------------

interface NoteDto {
  id: string
  kind: string
  animeId: number | null
  slug: string | null
  title: string | null
  poster: string | null
  episode: number | null
  text: string
  positionSec: number | null
  durationSec: number | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface CompanionCounts {
  notes: number | null
  moments: number | null
  watching: number | null
  unfinished: number | null
  favorites: number | null
  completed: number | null
}

/** GET /api/companion/overview */
interface OverviewResponse {
  accountKey: string | null
  counts: CompanionCounts | null
  continueItem: WatchProgressItem | null
  recentNotes: NoteDto[]
}

/** GET /api/companion/notes?q&kind&limit&offset */
interface NotesResponse {
  items: NoteDto[]
  total: number | null
}

/** GET /api/companion/quests */
interface QuestAchievement {
  id: string
  title: string
  description: string | null
  progress: number
  target: number
  done: boolean
}

interface QuestCustom {
  id: string
  title: string
  metric: string
  target: number
  progress: number
  done: boolean
}

interface QuestsResponse {
  achievements: QuestAchievement[]
  custom: QuestCustom[]
  available: boolean
  reason: string | null
}

/** GET /api/companion/taste */
interface TasteGenre {
  name: string
  count: number
  weight: number
  evidence: string[]
}

interface TasteStudio {
  name: string
  count: number
  titles: string[]
}

interface TasteTopRated {
  title: string
  rating: number
}

interface TasteResponse {
  available: boolean
  reason: string | null
  genres: TasteGenre[]
  studios: TasteStudio[]
  topRated: TasteTopRated[]
  signalCounts: {
    rated: number
    favorites: number
    watching: number
    completed: number
    dropped: number
  } | null
}

/** GET /api/site/category?genre=slug (существующий формат SectionPage-подобный) */
interface CategoryResponse {
  genre: string
  title: string
  page: number
  totalPages: number | null
  items: AnimeCard[]
  source: string
}

/** Персонаж — только имя/роль/постер (спойлер-гвардия): описания принципиально не показываем */
interface CharacterDto {
  id: string | number
  name: string
  role: string | null
  image: string | null
  seiyuu: string | null
}

// --- константы ----------------------------------------------------------------

const SUB_DEFS: Array<{ id: CompanionSub; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'compass', label: 'Компас', icon: Compass },
  { id: 'chronicles', label: 'Хроники', icon: BookOpen },
  { id: 'taste', label: 'Вкусы', icon: Palette },
  { id: 'quests', label: 'Квесты', icon: Trophy },
  { id: 'characters', label: 'Персонажи', icon: Users },
]

const SUB_IDS: readonly CompanionSub[] = SUB_DEFS.map((s) => s.id)

/** Оси настроений Компаса: id/подпись/подсказка/жанр-категория каталога сайта */
interface MoodAxis {
  id: string
  label: string
  hint: string
  genre: string
}

const MOOD_AXES: MoodAxis[] = [
  { id: 'dark', label: 'Мрачность', hint: 'Тяжёлые, гнетущие истории', genre: 'temnoe-fentezi' },
  { id: 'tense', label: 'Напряжение', hint: 'Держит в тонусе до финала', genre: 'triller' },
  { id: 'adventure', label: 'Приключения', hint: 'Дороги, походы, открытия', genre: 'priklyucheniya' },
  { id: 'cozy', label: 'Уютная атмосфера', hint: 'Спокойное повседневное тепло', genre: 'povsednevnost' },
  { id: 'tragic', label: 'Трагичность', hint: 'Драмы с настоящей ценой', genre: 'drama' },
  { id: 'politics', label: 'Политические интриги', hint: 'Дворцы, союзы, предательства', genre: 'istoricheskij' },
  { id: 'humor', label: 'Юмор', hint: 'Смеяться вслух', genre: 'komediya' },
  { id: 'complex', label: 'Сложный сюжет', hint: 'Голова должна работать', genre: 'psihologiya' },
  { id: 'slowburn', label: 'Методичный темп', hint: 'Медленное нарастание', genre: 'psihologiya' },
  { id: 'growth', label: 'Сила героя', hint: 'Рост и тренировки', genre: 'ekshen' },
  { id: 'romance', label: 'Романтика', hint: 'Чувства и отношения', genre: 'romantika' },
  { id: 'scale', label: 'Масштаб мира', hint: 'Огромные вселенные', genre: 'fantastika' },
  { id: 'supernatural', label: 'Магия', hint: 'Сверхъестественное рядом', genre: 'magiya' },
]

const NOTE_KINDS: Array<{ id: string; label: string }> = [
  { id: 'note', label: 'Заметка' },
  { id: 'quote', label: 'Цитата' },
  { id: 'moment', label: 'Момент' },
  { id: 'impression', label: 'Впечатление' },
]

const NOTE_KIND_LABELS: Record<string, string> = {
  note: 'Заметка',
  quote: 'Цитата',
  moment: 'Момент',
  impression: 'Впечатление',
}

const NOTE_KIND_ICONS: Record<string, LucideIcon> = {
  note: StickyNote,
  quote: Quote,
  moment: Sparkles,
  impression: MessageSquare,
}

const QUEST_METRICS: Array<{ id: string; label: string }> = [
  { id: 'episodes', label: 'серий' },
  { id: 'titles', label: 'тайтлов' },
  { id: 'notes', label: 'записей' },
  { id: 'ratings', label: 'оценок' },
  { id: 'favorites', label: 'любимых' },
]

const QUEST_METRIC_LABELS: Record<string, string> = Object.fromEntries(
  QUEST_METRICS.map((m) => [m.id, m.label]),
)

const TYPE_FILTERS: readonly string[] = ['Все', 'TV', 'Фильм', 'OVA', 'ONA', 'Спешл']

const NOTE_TEXT_MAX = 4000

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : DATE_FMT.format(d)
}

/** payload.q (голос MoodSearch) → предвыбранная ось: id/подпись в запросе, затем лексикон настроений */
function findAxisIdByQ(q: string): string | null {
  const s = q.trim().toLowerCase()
  if (!s) return null
  const byId = MOOD_AXES.find((a) => s.includes(a.id))
  if (byId) return byId.id
  const byLabel = MOOD_AXES.find((a) => s.includes(a.label.toLowerCase()))
  if (byLabel) return byLabel.id
  // Полная фраза голосом («найди что-нибудь мрачное с сильным героем») —
  // через общий лексикон настроений (тот же, что в парсере)
  return resolveMoodQuery(q).axis?.id ?? null
}

function clampPct(progress: number, target: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(target) || target <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((progress / target) * 100)))
}

// --- общие куски --------------------------------------------------------------

/** Строка ошибки → текст (fetch/HTTP) */
function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
      ✗ {message}
      <div className="mt-3">
        <Button variant="outline" onClick={onRetry} className="min-h-11 border-border">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Повторить
        </Button>
      </div>
    </div>
  )
}

function PanelEmpty({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon
  title: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-8 text-center">
      <Icon className="mx-auto h-10 w-10 text-gold-400/70" aria-hidden />
      <h3 className="mt-3 text-lg font-semibold">{title}</h3>
      {hint && (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/** Круглый узел-созвездие (bullets, достижения, оси компаса) */
function GoldNode({ done, className }: { done?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
        done
          ? 'border border-gold-200 bg-gold-300 shadow-[0_0_12px_rgba(242,221,164,0.8)]'
          : 'border-2 border-gold-400/60 bg-night-950/60',
        className,
      )}
    >
      {done && <Check className="h-2.5 w-2.5 text-night-950" strokeWidth={4} />}
    </span>
  )
}

function LoadingLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl bg-card" />
      ))}
    </div>
  )
}

// --- корень вкладки -------------------------------------------------------------

export function CompanionView({ tab }: { tab: BrowserTab }) {
  const patchTab = useAvcStore((s) => s.patchTab)
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const tablistRef = useRef<HTMLDivElement | null>(null)

  const rawSub = typeof tab.payload.sub === 'string' ? tab.payload.sub : 'overview'
  const sub: CompanionSub = (SUB_IDS as readonly string[]).includes(rawSub)
    ? (rawSub as CompanionSub)
    : 'overview'
  const q = typeof tab.payload.q === 'string' ? tab.payload.q : ''

  /** Смена подраздела = payload-патч ТЕКУЩЕЙ вкладки (никаких новых вкладок) */
  const selectSub = (next: CompanionSub) => {
    patchTab(tab.id, {
      payload: { ...tab.payload, sub: next },
      title: `Компаньон · ${COMPANION_SUB_LABELS[next] ?? next}`,
    })
  }

  /** Стрелки ←/→ внутри tablist — выбор соседнего подраздела */
  const onTablistKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const root = tablistRef.current
    if (!root) return
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const idx = tabs.findIndex((t) => t === document.activeElement)
    if (idx < 0) return
    e.preventDefault()
    const next =
      e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
    tabs[next]?.focus()
    const nextSub = SUB_IDS[next]
    if (nextSub && nextSub !== sub) selectSub(nextSub)
  }

  return (
    <div className="mx-auto max-w-6xl py-2">
      {/* --- шапка с созвездием-флоришем (как HomeView) --- */}
      <header className="text-center">
        <div className="mb-3 flex items-center justify-center gap-3" aria-hidden>
          <span className="gold-hairline h-px w-16 sm:w-28" />
          <span className="h-1.5 w-1.5 rounded-full bg-gold-300 shadow-[0_0_10px_rgba(242,221,164,0.9)]" />
          <span className="gold-hairline h-px w-16 sm:w-28" />
        </div>
        <h2 className="bg-gradient-to-r from-gold-200 via-gold-400 to-gold-200 bg-clip-text text-xl font-bold text-transparent md:text-3xl">
          Anime Companion
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Личный спутник просмотра: продолжения, настроение, хроники, вкусы и цели
        </p>
      </header>

      {/* --- поднавигация: сегмент-контрол + ссылки на соседние вкладки --- */}
      <nav aria-label="Разделы Anime Companion" className="mt-5">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Подразделы компаньона"
            onKeyDown={onTablistKeyDown}
            className="flex flex-wrap justify-center gap-1 rounded-xl border border-border bg-card/60 p-1"
          >
            {SUB_DEFS.map(({ id, label, icon: Icon }) => {
              const active = id === sub
              return (
                <button
                  key={id}
                  role="tab"
                  id={`companion-tab-${id}`}
                  aria-selected={active}
                  aria-controls={`companion-panel-${id}`}
                  aria-label={`Раздел: ${label}`}
                  tabIndex={active ? 0 : -1}
                  data-testid={`companion-sub-${id}`}
                  onClick={() => selectSub(id)}
                  className={cn(
                    'flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    active
                      ? 'border border-gold-400/60 bg-gold-400/15 text-gold-200 shadow-[0_0_14px_rgba(229,188,94,0.18)]'
                      : 'border border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Ссылки на существующие вкладки (не подразделы) */}
          <div className="flex gap-2">
            <button
              onClick={() => openRecommendations()}
              aria-label="Открыть вкладку: Рекомендации"
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 text-sm text-foreground transition-colors hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Compass className="h-4 w-4 text-gold-400" aria-hidden />
              Рекомендации
            </button>
            <button
              onClick={() => void openSection('schedule')}
              aria-label="Открыть вкладку: Календарь"
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 text-sm text-foreground transition-colors hover:border-gold-400/40 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <CalendarDays className="h-4 w-4 text-gold-400" aria-hidden />
              Календарь
            </button>
          </div>
        </div>
      </nav>

      {/* --- активный подраздел --- */}
      <div
        role="tabpanel"
        aria-labelledby={`companion-tab-${sub}`}
        id={`companion-panel-${sub}`}
        className="mt-5"
      >
        {sub === 'overview' && <OverviewSub tab={tab} reloadCounter={reloadCounter} />}
        {sub === 'compass' && <CompassSub q={q} reloadCounter={reloadCounter} />}
        {sub === 'chronicles' && <ChroniclesSub reloadCounter={reloadCounter} />}
        {sub === 'taste' && <TasteSub reloadCounter={reloadCounter} />}
        {sub === 'quests' && <QuestsSub reloadCounter={reloadCounter} />}
        {sub === 'characters' && <CharactersSub />}
      </div>
    </div>
  )
}

// --- 1. ОБЗОР --------------------------------------------------------------------

function OverviewSub({ tab, reloadCounter }: { tab: BrowserTab; reloadCounter: number }) {
  const patchTab = useAvcStore((s) => s.patchTab)
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  const requestKey = `overview:${reloadTick}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    fetch('/api/companion/overview')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as OverviewResponse
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e, 'Ошибка загрузки обзора'))
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])

  const jumpToChronicles = () => {
    patchTab(tab.id, {
      payload: { ...tab.payload, sub: 'chronicles' },
      title: `Компаньон · ${COMPANION_SUB_LABELS.chronicles}`,
    })
  }

  const counts = data?.counts ?? null
  const counterDefs: Array<{ key: keyof CompanionCounts; label: string }> = [
    { key: 'watching', label: 'Смотрю' },
    { key: 'favorites', label: 'Избранное' },
    { key: 'completed', label: 'Просмотрено' },
    { key: 'unfinished', label: 'Незаконченные' },
    { key: 'notes', label: 'Заметки' },
    { key: 'moments', label: 'Моменты' },
  ]
  const showOnboarding =
    !loading && !error && (!counts || (counts.watching === 0 && counts.notes === 0))
  const cont = data?.continueItem ?? null

  return (
    <section aria-label="Обзор">
      {loading && <LoadingLines rows={4} />}

      {!loading && error && (
        <PanelError message={error} onRetry={() => setReloadTick((t) => t + 1)} />
      )}

      {!loading && !error && data && (
        <div className="space-y-5">
          {/* Продолжить просмотр */}
          {cont && (
            <div className="anime-card flex flex-col gap-4 rounded-xl border border-border bg-card/60 p-4 sm:flex-row sm:items-center">
              {cont.poster ? (
                <img
                  src={cont.poster}
                  alt={cont.title}
                  loading="lazy"
                  className="aspect-[3/4] w-20 shrink-0 self-center rounded-lg border border-border object-cover sm:self-auto"
                />
              ) : (
                <div className="flex aspect-[3/4] w-20 shrink-0 items-center justify-center self-center rounded-lg border border-border bg-background/60 text-[10px] text-muted-foreground sm:self-auto">
                  Нет постера
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gold-400">
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Продолжить просмотр
                </p>
                <p className="mt-1 line-clamp-2 font-semibold">{cont.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {cont.episode != null
                    ? `Серия ${cont.episode}${cont.episodesTotal ? ` из ${cont.episodesTotal}` : ''}`
                    : 'Серия ещё не выбрана'}
                </p>
              </div>
              <Button
                onClick={() =>
                  void openAnimeCard(
                    {
                      animeId: cont.animeId,
                      slug: cont.slug,
                      title: cont.title,
                      poster: cont.poster,
                    } as AnimeCard,
                    false,
                  )
                }
                className="min-h-11 shrink-0"
                aria-label={`Продолжить: ${cont.title}`}
              >
                <Play className="h-4 w-4" aria-hidden />
                Продолжить
              </Button>
            </div>
          )}

          {/* Счётчики */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {counterDefs.map(({ key, label }) => {
              const value = counts ? counts[key] : null
              return (
                <div
                  key={key}
                  className="rounded-xl border border-border bg-card/60 p-4 text-center"
                >
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                  {value === null ? (
                    <p
                      title="нужен вход на сайте"
                      className="mt-1 text-2xl font-bold text-muted-foreground/60"
                    >
                      —
                    </p>
                  ) : (
                    <p className="mt-1 text-2xl font-bold text-gold-300 tabular-nums">{value}</p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Последние записи */}
          {data.recentNotes.length > 0 && (
            <div className="rounded-xl border border-border bg-card/60 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <BookOpen className="h-4 w-4 text-gold-300" aria-hidden />
                  Последние записи
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={jumpToChronicles}
                  className="min-h-11 px-3 text-xs text-gold-300 hover:text-gold-200"
                  aria-label="Открыть все записи в Хрониках"
                >
                  Все хроники
                </Button>
              </div>
              <ul className="space-y-2">
                {data.recentNotes.map((n) => {
                  const KindIcon = NOTE_KIND_ICONS[n.kind] ?? StickyNote
                  return (
                    <li key={n.id}>
                      <button
                        onClick={jumpToChronicles}
                        aria-label={`Открыть в хрониках: ${n.title ?? 'запись'}`}
                        className="flex min-h-11 w-full items-start gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-gold-400/30 hover:bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <KindIcon className="mt-0.5 h-4 w-4 shrink-0 text-gold-400/80" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {n.title ?? 'Без тайтла'}
                            {n.episode != null && (
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                Эп. {n.episode}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                            {n.text}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatDate(n.createdAt)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* Онбординг: пустой обзор — что умеет Companion */}
          {showOnboarding && (
            <div className="rounded-xl border border-gold-400/25 bg-gold-400/5 p-6">
              <h3 className="flex items-center gap-2 font-semibold text-gold-200">
                <Sparkles className="h-5 w-5 text-gold-400" aria-hidden />
                Чем поможет компаньон
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {[
                  'Обзор — продолжение просмотра, счётчики библиотеки и свежие записи.',
                  'Компас — подбор аниме под настроение: от «мрачного» до «уютного».',
                  'Хроники — ваши заметки, цитаты и моменты: «сохрани этот момент» голосом.',
                  'Вкусы — карта вкусов из ваших реальных оценок и списков на сайте.',
                  'Квесты — цели («посмотреть 10 серий на этой неделе») без штрафов и стриков.',
                  'Персонажи — имена и роли без спойлеров, только по MAL-ID.',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2.5">
                    <GoldNode className="mt-0.5" />
                    <span className="text-foreground/90">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// --- 2. КОМПАС --------------------------------------------------------------------

function CompassSub({ q, reloadCounter }: { q: string; reloadCounter: number }) {
  // Выбор оси: пока пользователь не кликнул сам, действует предвыбор из payload.q
  // (голосовая MoodSearch). Переопределение привязано к текущему q: новый q от
  // голоса снова включает предвыбор. Выводится в рендере — без setState в эффекте.
  const [override, setOverride] = useState<{ id: string | null; q: string } | null>(null)
  const qAxis = useMemo(() => findAxisIdByQ(q), [q])
  const selected = override && override.q === q ? override.id : qAxis
  const [typeFilter, setTypeFilter] = useState('Все')
  const [minRating, setMinRating] = useState(0)
  const [items, setItems] = useState<AnimeCard[] | null>(null)
  const [empty, setEmpty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  const requestKey = `${selected ?? ''}:${reloadTick}:${reloadCounter}`
  const loading = selected != null && loadedKey !== requestKey

  useEffect(() => {
    if (!selected) return
    const axis = MOOD_AXES.find((a) => a.id === selected)
    if (!axis) return
    let cancelled = false
    fetch(`/api/site/category?genre=${encodeURIComponent(axis.genre)}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error('EMPTY_CATEGORY')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as CategoryResponse
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? [])
        setEmpty((d.items ?? []).length === 0)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof Error && e.message === 'EMPTY_CATEGORY') {
          setItems([])
          setEmpty(true)
          setError(null)
        } else {
          setError(errText(e, 'Ошибка загрузки категории'))
        }
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])

  // Клиентские фильтры — по первой странице категории (честная пометка под сеткой)
  const filtered = useMemo(() => {
    let arr = items ?? []
    if (typeFilter !== 'Все') {
      arr = arr.filter(
        (c) => (c.type ?? '').trim().toLowerCase() === typeFilter.trim().toLowerCase(),
      )
    }
    if (minRating > 0) {
      arr = arr.filter((c) => c.rating !== null && c.rating >= minRating)
    }
    return arr
  }, [items, typeFilter, minRating])

  const filtersRemovedAll = (items?.length ?? 0) > 0 && filtered.length === 0
  const selectedAxis = MOOD_AXES.find((a) => a.id === selected) ?? null

  return (
    <section aria-label="Компас настроений">
      <p className="mb-3 text-sm text-muted-foreground">
        Выберите настроение — покажем подборку из категории каталога. Подсказка оси — во всплывающей
        подсказке.
      </p>

      {/* Оси: радиальное ощущение через круглые узлы и сетку */}
      <div
        role="group"
        aria-label="Оси настроений"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      >
        {MOOD_AXES.map((a) => {
          const active = selected === a.id
          return (
            <button
              key={a.id}
              onClick={() => setOverride({ id: active ? null : a.id, q })}
              aria-pressed={active}
              aria-label={`Настроение: ${a.label}. ${a.hint}`}
              title={a.hint}
              data-testid={`mood-axis-${a.id}`}
              className={cn(
                'flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                active
                  ? 'border-gold-400/70 bg-gold-400/15 text-gold-200 shadow-[0_0_14px_rgba(229,188,94,0.20)]'
                  : 'border-border bg-card/60 text-foreground hover:border-gold-400/40',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-2.5 w-2.5 shrink-0 rounded-full border-2 transition-colors',
                  active
                    ? 'border-gold-200 bg-gold-300 shadow-[0_0_10px_rgba(242,221,164,0.9)]'
                    : 'border-gold-400/50 bg-transparent',
                )}
              />
              <span className="min-w-0 leading-tight">{a.label}</span>
            </button>
          )
        })}
      </div>

      {/* Фильтры (клиентские, поверх первой страницы категории) */}
      {selected && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card/60 p-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Тип тайтла">
            {TYPE_FILTERS.map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                aria-pressed={typeFilter === t}
                className={cn(
                  'min-h-11 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  typeFilter === t
                    ? 'border-gold-400/70 bg-gold-400/15 text-gold-200'
                    : 'border-border bg-background/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex min-w-44 items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">
              Мин. рейтинг сайта: <span className="font-bold text-gold-300">{minRating}</span>
            </Label>
            <Slider
              aria-label="Минимальный рейтинг сайта"
              min={0}
              max={7}
              step={0.5}
              value={[minRating]}
              onValueChange={([v]) => setMinRating(v ?? 0)}
            />
          </div>
        </div>
      )}

      {/* Результаты */}
      <div className="mt-4">
        {!selected && (
          <div className="rounded-xl border border-border bg-card/60 p-8 text-center text-sm text-muted-foreground">
            Ось не выбрана. Например: «Мрачность» откроет тёмное фэнтези, «Уютная атмосфера» —
            повседневность.
          </div>
        )}

        {selected && loading && <AnimeGridSkeleton />}

        {selected && !loading && error && (
          <PanelError message={error} onRetry={() => setReloadTick((t) => t + 1)} />
        )}

        {selected && !loading && !error && empty && (
          <PanelEmpty
            icon={Compass}
            title="Категория пуста"
            hint={`На сайте пока нет тайтлов в категории «${selectedAxis?.label ?? selected}».`}
          />
        )}

        {selected && !loading && !error && !empty && filtersRemovedAll && (
          <div className="rounded-xl border border-gold-400/30 bg-gold-400/5 p-6 text-center">
            <Badge className="border border-gold-400/40 bg-gold-400/40 text-gold-100">
              Фильтры скрыли все результаты
            </Badge>
            <p className="mt-2 text-sm text-muted-foreground">
              Найдено {items?.length ?? 0}, но под фильтры не подошёл ни один тайтл.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setTypeFilter('Все')
                setMinRating(0)
              }}
              className="mt-3 min-h-11 border-border"
            >
              Сбросить фильтры
            </Button>
          </div>
        )}

        {selected && !loading && !error && !empty && !filtersRemovedAll && filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">Результатов нет</p>
        )}

        {selected && !loading && !error && !empty && filtered.length > 0 && (
          <>
            <AnimeGrid items={filtered} />
            <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Поиск по одной категории каталога; фильтры применены к первой странице результатов
              сайта.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

// --- 3. ХРОНИКИ --------------------------------------------------------------------

interface NoteFormState {
  kind: string
  animeId: string
  title: string
  episode: string
  text: string
  tags: string
}

const EMPTY_NOTE_FORM: NoteFormState = {
  kind: 'note',
  animeId: '',
  title: '',
  episode: '',
  text: '',
  tags: '',
}

function ChroniclesSub({ reloadCounter }: { reloadCounter: number }) {
  const [kind, setKind] = useState('all')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<NoteDto[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  // Форма новой записи
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<NoteFormState>(EMPTY_NOTE_FORM)
  const [posting, setPosting] = useState(false)

  // Редактирование / удаление
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null)

  // Debounce поиска 400 мс (локальный таймер внутри подвида)
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 400)
    return () => clearTimeout(t)
  }, [qInput])

  const requestKey = `notes:${kind}:${q}:${reloadTick}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    const sp = new URLSearchParams({ limit: '50' })
    if (kind !== 'all') sp.set('kind', kind)
    if (q.length >= 2) sp.set('q', q)
    fetch(`/api/companion/notes?${sp.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as NotesResponse
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? [])
        setTotal(d.total ?? null)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e, 'Ошибка загрузки записей'))
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])

  const submitNew = async () => {
    const text = form.text.trim()
    const animeId = parseInt(form.animeId, 10)
    const title = form.title.trim()
    if (!text) {
      toast.error('Текст записи обязателен')
      return
    }
    if (text.length > NOTE_TEXT_MAX) {
      toast.error(`Максимум ${NOTE_TEXT_MAX} символов`)
      return
    }
    if (!Number.isFinite(animeId) || animeId <= 0) {
      toast.error('Укажите числовой ID тайтла со страницы аниме')
      return
    }
    if (!title) {
      toast.error('Укажите название тайтла')
      return
    }
    const episode = parseInt(form.episode, 10)
    setPosting(true)
    try {
      const res = await fetch('/api/companion/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: form.kind,
          animeId,
          slug: '',
          title,
          episode: Number.isFinite(episode) && episode > 0 ? episode : undefined,
          text,
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { item?: NoteDto }
      if (d.item) {
        setItems((prev) => [d.item as NoteDto, ...prev])
        setTotal((t) => (t ?? 0) + 1)
      }
      setForm(EMPTY_NOTE_FORM)
      setFormOpen(false)
      toast('Запись сохранена в хроники')
    } catch (e) {
      toast.error(errText(e, 'Не удалось сохранить запись'))
    } finally {
      setPosting(false)
    }
  }

  const saveEdit = async (id: string) => {
    const text = editText.trim()
    if (!text) {
      toast.error('Текст не может быть пустым')
      return
    }
    setSavingId(id)
    try {
      const res = await fetch(`/api/companion/notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { item?: NoteDto }
      setItems((prev) =>
        prev.map((n) => (n.id === id ? (d.item ?? { ...n, text }) : n)),
      )
      setEditingId(null)
      setEditText('')
      toast('Запись обновлена')
    } catch (e) {
      toast.error(errText(e, 'Не удалось обновить запись'))
    } finally {
      setSavingId(null)
    }
  }

  const removeNote = async (id: string) => {
    try {
      const res = await fetch(`/api/companion/notes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setItems((prev) => prev.filter((n) => n.id !== id))
      setTotal((t) => (t == null ? null : Math.max(0, t - 1)))
      setArmedDeleteId(null)
      toast('Запись удалена')
    } catch (e) {
      toast.error(errText(e, 'Не удалось удалить запись'))
    }
  }

  return (
    <section aria-label="Хроники: заметки, цитаты, моменты">
      {/* Панель управления */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Тип записей" className="flex flex-wrap gap-1.5">
          {[{ id: 'all', label: 'Все' }, ...NOTE_KINDS].map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              aria-pressed={kind === k.id}
              className={cn(
                'min-h-11 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                kind === k.id
                  ? 'border-gold-400/70 bg-gold-400/15 text-gold-200'
                  : 'border-border bg-card/60 text-muted-foreground hover:text-foreground',
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="min-w-40 flex-1">
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Поиск по записям…"
            aria-label="Поиск по записям"
            className="min-h-11 border-border bg-card/60"
          />
        </div>
        <Button
          onClick={() => setFormOpen((v) => !v)}
          aria-expanded={formOpen}
          className="min-h-11"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Новая запись
        </Button>
      </div>

      {/* Форма новой записи */}
      {formOpen && (
        <div className="mb-4 space-y-3 rounded-xl border border-gold-400/25 bg-card/60 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="note-kind">Тип записи</Label>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger id="note-kind" aria-label="Тип записи" className="min-h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_KINDS.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note-anime-id">ID тайтла</Label>
              <Input
                id="note-anime-id"
                inputMode="numeric"
                value={form.animeId}
                onChange={(e) => setForm((f) => ({ ...f, animeId: e.target.value.replace(/\D/g, '') }))}
                placeholder="например 41"
                className="min-h-11 border-border bg-background/40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note-title">Название</Label>
              <Input
                id="note-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Наруто"
                className="min-h-11 border-border bg-background/40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note-episode">Серия (необязательно)</Label>
              <Input
                id="note-episode"
                inputMode="numeric"
                value={form.episode}
                onChange={(e) => setForm((f) => ({ ...f, episode: e.target.value.replace(/\D/g, '') }))}
                placeholder="12"
                className="min-h-11 border-border bg-background/40"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            ID и название тайтла возьмите со страницы аниме — компаньон не угадывает их за вас.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="note-text">Текст записи</Label>
            <Textarea
              id="note-text"
              value={form.text}
              maxLength={NOTE_TEXT_MAX}
              onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
              rows={4}
              required
              aria-required="true"
              placeholder="Что сохранить: мысль, цитату, момент или впечатление?"
              className="min-h-24 border-border bg-background/40"
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {form.text.length} / {NOTE_TEXT_MAX}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note-tags">Теги (через запятую)</Label>
            <Input
              id="note-tags"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="битва, твист, опенинг"
              className="min-h-11 border-border bg-background/40"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void submitNew()} disabled={posting} className="min-h-11">
              {posting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Сохранить
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFormOpen(false)
                setForm(EMPTY_NOTE_FORM)
              }}
              className="min-h-11"
            >
              Отмена
            </Button>
          </div>
        </div>
      )}

      {/* Состояния */}
      {loading && <LoadingLines rows={4} />}

      {!loading && error && <PanelError message={error} onRetry={() => setReloadTick((t) => t + 1)} />}

      {!loading && !error && items.length === 0 && (
        <PanelEmpty
          icon={BookOpen}
          title="Пока пусто"
          hint="Сохраняйте заметки, цитаты и моменты — например голосом: «сохрани этот момент» во время просмотра."
        />
      )}

      {!loading && !error && items.length > 0 && (
        <>
          {total !== null && (
            <p className="mb-2 text-xs text-muted-foreground">
              Записей: {total}
              {q.length >= 2 ? ` · поиск: «${q}»` : ''}
            </p>
          )}
          <ul className="space-y-3">
            {items.map((n) => {
              const KindIcon = NOTE_KIND_ICONS[n.kind] ?? StickyNote
              const tags = Array.isArray(n.tags) ? n.tags : []
              const isEditing = editingId === n.id
              return (
                <li
                  key={n.id}
                  className="anime-card rounded-xl border border-border bg-card/60 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <Badge
                        variant="outline"
                        className="shrink-0 border-gold-400/40 bg-gold-400/10 text-gold-300"
                      >
                        <KindIcon className="mr-1 h-3 w-3" aria-hidden />
                        {NOTE_KIND_LABELS[n.kind] ?? n.kind}
                      </Badge>
                      <span className="min-w-0 truncate text-sm font-semibold">
                        {n.title ?? 'Без тайтла'}
                      </span>
                      {n.episode != null && (
                        <Badge variant="outline" className="shrink-0 border-border text-xs text-muted-foreground">
                          Эп. {n.episode}
                        </Badge>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(n.createdAt)}
                    </span>
                  </div>

                  {isEditing ? (
                    <div className="mt-2 space-y-2">
                      <Textarea
                        value={editText}
                        maxLength={NOTE_TEXT_MAX}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        aria-label={`Редактирование записи от ${formatDate(n.createdAt)}`}
                        className="min-h-20 border-border bg-background/40"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => void saveEdit(n.id)}
                          disabled={savingId === n.id}
                          className="min-h-11"
                        >
                          {savingId === n.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-4 w-4" aria-hidden />
                          )}
                          Сохранить
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(null)
                            setEditText('')
                          }}
                          className="min-h-11"
                        >
                          <X className="h-4 w-4" aria-hidden />
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {n.text}
                    </p>
                  )}

                  {tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full border border-border bg-background/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}

                  {!isEditing && (
                    <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(n.id)
                          setEditText(n.text)
                        }}
                        aria-label={`Редактировать запись от ${formatDate(n.createdAt)}`}
                        className="min-h-11 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        Изменить
                      </Button>
                      {armedDeleteId === n.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void removeNote(n.id)}
                            className="min-h-11 px-2.5 text-xs"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            Точно удалить?
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setArmedDeleteId(null)}
                            className="min-h-11 px-2.5 text-xs text-muted-foreground"
                          >
                            Отмена
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setArmedDeleteId(n.id)}
                          aria-label={`Удалить запись от ${formatDate(n.createdAt)}`}
                          className="min-h-11 px-2.5 text-xs text-muted-foreground hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Удалить
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

// --- 4. ВКУСЫ ----------------------------------------------------------------------

function TasteSub({ reloadCounter }: { reloadCounter: number }) {
  const [data, setData] = useState<TasteResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  const requestKey = `taste:${reloadTick}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    fetch('/api/companion/taste')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as TasteResponse
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e, 'Ошибка загрузки карты вкусов'))
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])

  const genres = data?.genres ?? []
  const studios = data?.studios ?? []
  const topRated = data?.topRated ?? []
  const signals = data?.signalCounts ?? null
  const isEmpty =
    !data || (!data.available || (genres.length === 0 && studios.length === 0 && topRated.length === 0))

  return (
    <section aria-label="Карта вкусов">
      {loading && <LoadingLines rows={4} />}

      {!loading && error && <PanelError message={error} onRetry={() => setReloadTick((t) => t + 1)} />}

      {!loading && !error && data && !data.available && (
        <PanelEmpty
          icon={Palette}
          title="Карта вкусов недоступна"
          hint={data.reason ?? 'Нет данных для построения карты.'}
        />
      )}

      {!loading && !error && data && data.available && isEmpty && (
        <PanelEmpty
          icon={Palette}
          title="Пока мало данных"
          hint="Оценивайте тайтлы и добавляйте любимые на сайте — карта вкусов построится из реальных оценок."
        />
      )}

      {!loading && !error && data && data.available && !isEmpty && (
        <div className="space-y-5">
          {/* Созвездие жанров: узлы с размером по весу */}
          {genres.length > 0 && (
            <div className="rounded-xl border border-border bg-card/60 p-6">
              <h3 className="mb-5 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Sparkles className="h-4 w-4 text-gold-300" aria-hidden />
                Созвездие жанров
              </h3>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-6">
                {genres.map((g) => {
                  const w = Number.isFinite(g.weight) ? Math.max(0, Math.min(1, g.weight)) : 0
                  const size = Math.round(12 + w * 36)
                  return (
                    <div
                      key={g.name}
                      className="flex w-36 flex-col items-center gap-1.5 text-center"
                      title={`${g.name}: ${g.count} совпадений`}
                    >
                      <span
                        aria-hidden
                        style={{ width: size, height: size }}
                        className="rounded-full border-2 border-gold-400/80 bg-gold-400/25 shadow-[0_0_12px_rgba(229,188,94,0.4)]"
                      />
                      <span className="text-sm font-medium leading-tight text-foreground">{g.name}</span>
                      <span className="text-xs text-muted-foreground">· {g.count}</span>
                      {g.evidence.length > 0 && (
                        <span className="line-clamp-3 text-[11px] leading-snug text-muted-foreground/80">
                          {g.evidence.slice(0, 3).join(' · ')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Студии */}
            {studios.length > 0 && (
              <div className="rounded-xl border border-border bg-card/60 p-4">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Студии
                </h3>
                <ul className="avc-scroll max-h-96 space-y-1.5 overflow-y-auto pr-1">
                  {studios.map((s) => (
                    <li
                      key={s.name}
                      className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border"
                    >
                      <span className="min-w-0 truncate text-sm">{s.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {s.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Выше всего оценено */}
            {topRated.length > 0 && (
              <div className="rounded-xl border border-border bg-card/60 p-4">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Ваши высшие оценки
                </h3>
                <div className="avc-scroll flex max-h-96 flex-wrap gap-2 overflow-y-auto">
                  {topRated.map((t) => (
                    <span
                      key={t.title}
                      className="flex items-center gap-1.5 rounded-full border border-gold-400/30 bg-gold-400/10 px-3 py-1.5 text-xs"
                    >
                      <span className="max-w-48 truncate text-foreground">{t.title}</span>
                      <Badge className="border-none bg-gold-400/30 px-1.5 text-[11px] font-bold text-gold-100">
                        ★ {t.rating}
                      </Badge>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Сигналы */}
          {signals && (
            <div className="rounded-xl border border-border bg-card/60 p-4">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Откуда сигналы
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {(
                  [
                    { key: 'rated', label: 'Оценок' },
                    { key: 'favorites', label: 'Любимых' },
                    { key: 'watching', label: 'Смотрю' },
                    { key: 'completed', label: 'Просмотрено' },
                    { key: 'dropped', label: 'Брошено' },
                  ] as const
                ).map(({ key, label }) => (
                  <div key={key} className="rounded-lg bg-background/40 p-3 text-center">
                    <p className="text-lg font-bold text-gold-300 tabular-nums">{signals[key]}</p>
                    <p className="text-[11px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// --- 5. КВЕСТЫ ----------------------------------------------------------------------

function QuestsSub({ reloadCounter }: { reloadCounter: number }) {
  const [data, setData] = useState<QuestsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  // Форма новой цели
  const [title, setTitle] = useState('')
  const [metric, setMetric] = useState('episodes')
  const [target, setTarget] = useState('')
  const [creating, setCreating] = useState(false)
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null)

  const requestKey = `quests:${reloadTick}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    fetch('/api/companion/quests')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as QuestsResponse
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(errText(e, 'Ошибка загрузки квестов'))
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])

  const createQuest = async () => {
    const t = title.trim()
    const n = parseInt(target, 10)
    if (!t) {
      toast.error('Придумайте название цели')
      return
    }
    if (!Number.isFinite(n) || n < 1 || n > 10000) {
      toast.error('Цель — число от 1 до 10000')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/companion/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, metric, target: n }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { item?: QuestCustom }
      if (d.item) {
        const item = d.item
        setData((prev) => (prev ? { ...prev, custom: [...prev.custom, item] } : prev))
      } else {
        setReloadTick((v) => v + 1)
      }
      setTitle('')
      setTarget('')
      toast('Цель добавлена')
    } catch (e) {
      toast.error(errText(e, 'Не удалось создать цель'))
    } finally {
      setCreating(false)
    }
  }

  const archiveQuest = async (id: string) => {
    try {
      const res = await fetch(`/api/companion/quests/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((prev) => (prev ? { ...prev, custom: prev.custom.filter((c) => c.id !== id) } : prev))
      setArmedDeleteId(null)
      toast('Цель убрана в архив')
    } catch (e) {
      toast.error(errText(e, 'Не удалось убрать цель'))
    }
  }

  const achievements = data?.achievements ?? []
  const custom = data?.custom ?? []

  return (
    <section aria-label="Квесты и достижения">
      {loading && <LoadingLines rows={4} />}

      {!loading && error && <PanelError message={error} onRetry={() => setReloadTick((t) => t + 1)} />}

      {!loading && !error && data && (
        <div className="space-y-5">
          {data.reason && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{data.reason}</span>
            </div>
          )}

          {/* Достижения — золотые узлы */}
          {achievements.length > 0 && (
            <div className="rounded-xl border border-border bg-card/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Trophy className="h-4 w-4 text-gold-300" aria-hidden />
                Достижения
              </h3>
              <ul className="space-y-2.5">
                {achievements.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-3 rounded-lg border border-transparent px-2 py-2 hover:border-border"
                  >
                    <GoldNode done={a.done} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {a.title}
                        {a.done && (
                          <Badge className="border border-emerald-400/40 bg-emerald-400/10 text-emerald-300">
                            получено
                          </Badge>
                        )}
                      </p>
                      {a.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
                      )}
                      {!a.done && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-background/60">
                            <div
                              className="h-full rounded-full bg-gold-400/70"
                              style={{ width: `${clampPct(a.progress, a.target)}%` }}
                            />
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {a.progress} / {a.target}
                          </span>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Свои цели */}
          <div className="rounded-xl border border-border bg-card/60 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-4 w-4 text-gold-300" aria-hidden />
              Свои цели
            </h3>

            {/* Создание */}
            <div className="mb-4 grid gap-2 rounded-lg border border-border bg-background/30 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="quest-title">Название цели</Label>
                <Input
                  id="quest-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Посмотреть 10 серий за неделю"
                  className="min-h-11 border-border bg-background/40"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quest-metric">Метрика</Label>
                <Select value={metric} onValueChange={setMetric}>
                  <SelectTrigger id="quest-metric" aria-label="Метрика цели" className="min-h-11 w-full sm:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUEST_METRICS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quest-target">Сколько</Label>
                <Input
                  id="quest-target"
                  inputMode="numeric"
                  value={target}
                  onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))}
                  placeholder="10"
                  className="min-h-11 w-full border-border bg-background/40 sm:w-24"
                />
              </div>
              <Button onClick={() => void createQuest()} disabled={creating} className="min-h-11">
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden />
                )}
                Добавить
              </Button>
            </div>

            {custom.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Своих целей пока нет — добавьте первую выше.
              </p>
            ) : (
              <ul className="avc-scroll max-h-96 space-y-2 overflow-y-auto pr-1">
                {custom.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-3 rounded-lg border border-border bg-background/30 p-3"
                  >
                    <GoldNode done={c.done} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{c.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {QUEST_METRIC_LABELS[c.metric] ?? c.metric}
                        {' · '}
                        {c.progress} / {c.target}
                        {c.done && ' — готово'}
                      </p>
                      <div className="mt-1.5 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-background/60">
                        <div
                          className="h-full rounded-full bg-gold-400/70"
                          style={{ width: `${clampPct(c.progress, c.target)}%` }}
                        />
                      </div>
                    </div>
                    {armedDeleteId === c.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void archiveQuest(c.id)}
                          className="min-h-11 shrink-0 px-2.5 text-xs"
                        >
                          В архив?
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setArmedDeleteId(null)}
                          className="min-h-11 shrink-0 px-2.5 text-xs text-muted-foreground"
                        >
                          Отмена
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setArmedDeleteId(c.id)}
                        aria-label={`Убрать в архив: ${c.title}`}
                        className="min-h-11 shrink-0 px-2.5 text-xs text-muted-foreground hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        В архив
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Квесты — добровольная игра: без стриков, штрафов и уведомлений.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

// --- 6. ПЕРСОНАЖИ --------------------------------------------------------------------

interface CharacterSource {
  animeId: number
  title: string
  slug: string
  poster: string | null
  episode: number | null
}

/** Защитная нормализация строки /api/watch-progress (WatchProgressItem): источник тайтлов для персонажей */
function normalizeHistoryItem(raw: unknown): CharacterSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const animeId = typeof r.animeId === 'number' && Number.isFinite(r.animeId) ? r.animeId : null
  if (animeId === null || animeId <= 0) return null
  const title =
    (typeof r.title === 'string' && r.title) ||
    (typeof r.animeTitle === 'string' && r.animeTitle) ||
    `Аниме #${animeId}`
  const slug =
    (typeof r.slug === 'string' && r.slug) || (typeof r.animeSlug === 'string' && r.animeSlug) || ''
  const poster = typeof r.poster === 'string' && r.poster ? r.poster : null
  const rawEp = r.episode ?? r.episodeNumber
  const episode = typeof rawEp === 'number' && Number.isFinite(rawEp) ? rawEp : null
  return { animeId, title, slug, poster, episode }
}

/** Защитная нормализация персонажа (контракт /api/companion/characters не зафиксирован в аудите) */
function normalizeCharacter(raw: unknown): CharacterDto | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return null
  let seiyuu: string | null = null
  if (typeof r.seiyuu === 'string' && r.seiyuu.trim()) seiyuu = r.seiyuu.trim()
  else if (typeof r.seiyuu === 'object' && r.seiyuu !== null) {
    const s = r.seiyuu as Record<string, unknown>
    if (typeof s.name === 'string' && s.name.trim()) seiyuu = s.name.trim()
    else if (typeof s.full === 'string' && s.full.trim()) seiyuu = s.full.trim()
  }
  const role = typeof r.role === 'string' ? r.role : null
  const image =
    typeof r.image === 'string' && r.image ? r.image : typeof r.imageUrl === 'string' ? r.imageUrl : null
  const id = typeof r.id === 'number' || typeof r.id === 'string' ? r.id : name
  return { id, name, role, image, seiyuu }
}

function roleLabel(role: string | null): string {
  return role && /main|главн/i.test(role) ? 'Главный' : 'Второстепенный'
}

function CharactersSub() {
  // Источник: история просмотров
  const [sources, setSources] = useState<CharacterSource[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [srcLoadedKey, setSrcLoadedKey] = useState('')
  const [srcTick, setSrcTick] = useState(0)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Детали тайтла (для MAL-ID)
  const [details, setDetails] = useState<AnimeDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detLoadedKey, setDetLoadedKey] = useState('')
  const [detTick, setDetTick] = useState(0)

  // Персонажи
  const [chars, setChars] = useState<CharacterDto[] | null>(null)
  const [charsError, setCharsError] = useState<string | null>(null)
  const [charsLoadedKey, setCharsLoadedKey] = useState('')
  const [charsTick, setCharsTick] = useState(0)

  const srcKey = `src:${srcTick}`
  const srcLoading = srcLoadedKey !== srcKey

  useEffect(() => {
    let cancelled = false
    // accountKey — тот же безопасный слот, что у библиотеки/трекинга (userId сайта или 'anon')
    const acc = useAvcStore.getState().yummyAccount
    const uid = acc.state === 'loggedIn' ? acc.user?.userId : null
    const accountKey = uid && /^[A-Za-z0-9_-]{1,64}$/.test(uid) ? uid : 'anon'
    fetch(`/api/watch-progress?accountKey=${encodeURIComponent(accountKey)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { items?: unknown[] }
      })
      .then((d) => {
        if (cancelled) return
        setSources((d.items ?? []).map(normalizeHistoryItem).filter((x): x is CharacterSource => x !== null))
        setSourcesError(null)
        setSrcLoadedKey(srcKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setSourcesError(errText(e, 'История просмотров недоступна'))
        setSrcLoadedKey(srcKey)
      })
    return () => {
      cancelled = true
    }
  }, [srcKey])

  const detKey = `det:${selectedId ?? ''}:${detTick}`
  const detLoading = selectedId !== null && detLoadedKey !== detKey
  const malId = details?.malId ?? null

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    fetch(`/api/site/anime/${encodeURIComponent(String(selectedId))}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as AnimeDetails
      })
      .then((d) => {
        if (cancelled) return
        setDetails(d)
        setDetailsError(null)
        setDetLoadedKey(detKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setDetailsError(errText(e, 'Не удалось открыть страницу тайтла'))
        setDetLoadedKey(detKey)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, detKey])

  const charsKey = `chars:${malId ?? ''}:${charsTick}`
  const charsLoading = malId !== null && charsLoadedKey !== charsKey

  useEffect(() => {
    if (malId === null) return
    let cancelled = false
    fetch(`/api/companion/characters?malId=${malId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { characters?: unknown[]; items?: unknown[] }
      })
      .then((d) => {
        if (cancelled) return
        const rawList = d.characters ?? d.items ?? []
        setChars(rawList.map(normalizeCharacter).filter((x): x is CharacterDto => x !== null))
        setCharsError(null)
        setCharsLoadedKey(charsKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setCharsError(errText(e, 'Не удалось загрузить персонажей'))
        setCharsLoadedKey(charsKey)
      })
    return () => {
      cancelled = true
    }
  }, [malId, charsKey])

  /** Выбор тайтла-источника: сброс прошлого результата — здесь, в обработчике события */
  const pickSource = (id: number) => {
    setSelectedId(id)
    setDetTick((t) => t + 1)
    setDetails(null)
    setDetailsError(null)
    setChars(null)
    setCharsError(null)
    setCharsLoadedKey('')
  }

  return (
    <section aria-label="Персонажи">
      {/* Политика спойлеров */}
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-gold-400/25 bg-gold-400/5 p-4 text-sm text-gold-100">
        <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-gold-400" aria-hidden />
        <span>
          Политика спойлеров: показываем только <b>имена</b>, <b>роль</b> и <b>постер</b> персонажа.
          Описания скрыты принципиально — чтобы случайный взгляд не испортил просмотр.
        </span>
      </div>

      {/* Выбор тайтла из истории */}
      <div className="mb-4 rounded-xl border border-border bg-card/60 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Откройте персонажей тайтла из вашей истории
        </h3>

        {srcLoading && (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-40 rounded-full bg-background/40" />
            ))}
          </div>
        )}

        {!srcLoading && sourcesError && (
          <PanelError message={sourcesError} onRetry={() => setSrcTick((t) => t + 1)} />
        )}

        {!srcLoading && !sourcesError && sources && sources.length === 0 && (
          <p className="text-sm text-muted-foreground">
            История просмотров пуста — откройте любое аниме, и оно появится здесь.
          </p>
        )}

        {!srcLoading && !sourcesError && sources && sources.length > 0 && (
          <div role="group" aria-label="Тайтлы из истории просмотров" className="flex flex-wrap gap-2">
            {sources.map((s) => {
              const active = selectedId === s.animeId
              return (
                <button
                  key={`${s.animeId}-${s.slug}`}
                  onClick={() => pickSource(s.animeId)}
                  aria-pressed={active}
                  className={cn(
                    'flex min-h-11 max-w-64 items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    active
                      ? 'border-gold-400/70 bg-gold-400/15 text-gold-200'
                      : 'border-border bg-background/40 text-foreground hover:border-gold-400/40',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      active ? 'bg-gold-200 shadow-[0_0_8px_rgba(242,221,164,0.9)]' : 'bg-night-500',
                    )}
                  />
                  <span className="truncate">{s.title}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Детали → персонажи */}
      {selectedId === null && (
        <p className="py-6 text-center text-sm text-muted-foreground">Выберите тайтл выше</p>
      )}

      {selectedId !== null && detLoading && <LoadingLines rows={2} />}

      {selectedId !== null && !detLoading && detailsError && (
        <PanelError message={detailsError} onRetry={() => setDetTick((t) => t + 1)} />
      )}

      {selectedId !== null && !detLoading && !detailsError && details && malId === null && (
        <PanelEmpty
          icon={Users}
          title="Персонажи недоступны"
          hint="У тайтла нет MAL-ID — персонажей взять неоткуда (источник — AniList по MAL-ID)."
        />
      )}

      {selectedId !== null && !detLoading && !detailsError && details && malId !== null && (
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4 text-gold-300" aria-hidden />
            Персонажи «{details.title}»
          </h3>

          {charsLoading && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl bg-card" />
              ))}
            </div>
          )}

          {!charsLoading && charsError && (
            <PanelError message={charsError} onRetry={() => setCharsTick((t) => t + 1)} />
          )}

          {!charsLoading && !charsError && chars !== null && chars.length === 0 && (
            <PanelEmpty
              icon={Users}
              title="Персонажей не найдено"
              hint="AniList не вернул данных по этому MAL-ID."
            />
          )}

          {!charsLoading && !charsError && chars !== null && chars.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {chars.map((c) => {
                const initial = c.name.charAt(0).toUpperCase()
                return (
                  <li
                    key={String(c.id)}
                    className="anime-card overflow-hidden rounded-xl border border-border bg-card/60"
                  >
                    {c.image ? (
                      <img
                        src={c.image}
                        alt={`Постер персонажа: ${c.name}`}
                        loading="lazy"
                        className="aspect-[3/4] w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-[3/4] w-full items-center justify-center bg-background/40">
                        <span
                          aria-hidden
                          className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-gold-400/60 bg-gold-400/10 text-2xl font-bold text-gold-300"
                        >
                          {initial}
                        </span>
                      </div>
                    )}
                    <div className="p-3">
                      <p className="line-clamp-2 text-sm font-semibold">{c.name}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            'border px-1.5 text-[11px]',
                            roleLabel(c.role) === 'Главный'
                              ? 'border-gold-400/50 bg-gold-400/10 text-gold-300'
                              : 'border-border text-muted-foreground',
                          )}
                        >
                          {roleLabel(c.role)}
                        </Badge>
                        {c.seiyuu && (
                          <span className="truncate text-[11px] text-muted-foreground">
                            Сэйю: {c.seiyuu}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
