'use client'
/**
 * RecommendationsView — вкладка «Рекомендации» (ТЗ «Персональные рекомендации»).
 *
 * Честные состояния: загрузка / гость / холодный старт (общая подборка с меткой) /
 * ошибка с повтором / устаревшие данные (stale) / пусто.
 * Настройки: порог оценки (4–10), исключать известные, разнообразие, AniList.
 * Обратная связь: «Не интересно» / «Уже видел» с кнопкой возврата.
 * Счёт = ВНУТРЕННЯЯ оценка соответствия (не вероятность) — подпись обязателен.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Compass,
  EyeOff,
  Info,
  Loader2,
  LogIn,
  RefreshCw,
  Settings2,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { openAnimeCard } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { AnimeCard } from '@/lib/avc/types'
import type { RecCard } from '@/lib/recs/types'
import { cn } from '@/lib/utils'

// --- контракт ответа /api/recs (дублируем узко, чтобы не тянуть серверный модуль) ---

interface RecsResponse {
  ok: boolean
  mode: 'personalized' | 'discovery' | 'logged-out' | 'unavailable'
  items: RecCard[]
  profileSummary: {
    anchors: number
    positiveAnchors: number
    negativeAnchors: number
    knownTitles: number
    candidates: number
    excludedKnown: number
    excludedDropped: number
    excludedLowRated: number
    excludedFeedback: number
    duplicatesRemoved: number
    topGenres: string[]
  } | null
  message: string | null
  reason: string | null
  stale: boolean
  cached: boolean
  computedAt: string | null
  feedback: Array<{ animeId: number; action: string; title: string }>
}

const PAGE_STEP = 24

export function RecommendationsView() {
  const settings = useAvcStore((s) => s.settings)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const recsVersion = useAvcStore((s) => s.recsVersion)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const patchTab = useAvcStore((s) => s.patchTab)
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)

  const [data, setData] = useState<RecsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(PAGE_STEP)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set())
  const reqSeq = useRef(0)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const isRecommendationsTab = activeTab?.kind === 'recommendations'
  // «Обновить» голосом/кнопкой повторно (openRecommendations при уже открытой вкладке)
  const reloadCounter = useAvcStore((s) => (s.activeTabId ? s.tabReloadCounter[s.activeTabId] ?? 0 : 0))
  const reloadRef = useRef(reloadCounter)

  const buildUrl = useCallback(
    (refresh: boolean) => {
      const sp = new URLSearchParams({
        threshold: String(settings.recRatingThreshold),
        excludeKnown: settings.recExcludeKnown ? '1' : '0',
        diversity: settings.recDiversity ? '1' : '0',
        anilist: settings.recAnilist ? '1' : '0',
      })
      if (refresh) sp.set('refresh', '1')
      return `/api/recs?${sp.toString()}`
    },
    [settings.recRatingThreshold, settings.recExcludeKnown, settings.recDiversity, settings.recAnilist],
  )

  const load = useCallback(
    async (refresh: boolean) => {
      const seq = ++reqSeq.current
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(buildUrl(refresh))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as RecsResponse
        if (seq !== reqSeq.current) return // старый ответ не перезаписывает новый (ТЗ §12)
        setData(json)
        setVisible(PAGE_STEP)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setError(e instanceof Error ? e.message : 'Ошибка загрузки рекомендаций')
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [buildUrl],
  )

  // Первая загрузка: refresh=0 — мгновенный снапшот при неизменных данных
  useEffect(() => {
    void load(false)
    // load стабилен (useCallback от buildUrl от стабильных настроек)
  }, [load])

  // Повторный «открой рекомендации» по активной вкладке = принудительный пересчёт
  useEffect(() => {
    if (reloadCounter === reloadRef.current) return
    reloadRef.current = reloadCounter
    void load(true)
  }, [reloadCounter, load])

  // Профиль изменился (оценка/статус/избранное подтверждены) — честный пересчёт
  const versionRef = useRef(recsVersion)
  useEffect(() => {
    if (versionRef.current === recsVersion) return
    versionRef.current = recsVersion
    if (!isRecommendationsTab) return
    const t = setTimeout(() => {
      toast('Данные аккаунта изменились — рекомендации пересчитываются')
      void load(true)
    }, 800)
    return () => clearTimeout(t)
  }, [recsVersion, isRecommendationsTab, load])

  // Заголовок вкладки (однократно)
  useEffect(() => {
    if (activeTab && activeTab.title !== 'Рекомендации') {
      patchTab(activeTab.id, { title: 'Рекомендации' })
    }
  }, [activeTab, patchTab])

  const changeSetting = (partial: Partial<typeof settings>) => {
    updateSettings(partial)
    // Настройки влияют на скоринг — честный пересчёт после debounce
    setTimeout(() => void load(true), 300)
  }

  const giveFeedback = async (card: RecCard, action: 'hide' | 'seen') => {
    setHiddenIds((prev) => new Set(prev).add(card.card.animeId))
    toast(
      action === 'hide' ? `«${card.card.title}» скрыто из рекомендаций` : `«${card.card.title}» отмечено просмотренным`,
      {
        description: 'Можно вернуть в списке скрытых',
        duration: 4000,
      },
    )
    try {
      await fetch('/api/recs/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ animeId: card.card.animeId, action, title: card.card.title }),
      })
    } catch {
      toast.error('Не удалось сохранить отметку')
    }
    // фидбек — жёсткий фильтр входа → пересчёт без полного refetch профиля
    setTimeout(() => void load(true), 400)
  }

  const undoFeedback = async (animeId: number) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      next.delete(animeId)
      return next
    })
    try {
      await fetch(`/api/recs/feedback?animeId=${animeId}`, { method: 'DELETE' })
    } catch {
      /* несущественно — пересчёт покажет актуальное */
    }
    setTimeout(() => void load(true), 300)
  }

  const openCard = (card: AnimeCard) => void openAnimeCard(card, true)

  const items = (data?.items ?? []).filter((it) => !hiddenIds.has(it.card.animeId))
  const shown = items.slice(0, visible)
  const hiddenCount = data?.feedback?.length ?? 0

  return (
    <div className="mx-auto max-w-6xl py-2">
      {/* --- шапка --- */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Compass className="h-6 w-6 text-sky-400" aria-hidden />
          <h2 className="text-lg font-bold">Рекомендации</h2>
          {data?.mode === 'personalized' && !loading && (
            <Badge className="border border-emerald-400/40 bg-emerald-400/10 text-emerald-300">
              персональные
            </Badge>
          )}
          {data?.mode === 'discovery' && !loading && (
            <Badge className="border border-sky-400/40 bg-sky-400/40 text-sky-100">
              общая подборка
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Настройки рекомендаций"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            className="h-11 w-11 text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="h-5 w-5" aria-hidden />
          </Button>
          <Button
            variant="outline"
            onClick={() => void load(true)}
            disabled={loading}
            className="min-h-11 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Обновить
          </Button>
        </div>
      </div>

      {/* --- настройки (раскрывающаяся панель) --- */}
      {settingsOpen && (
        <div className="mb-4 grid gap-4 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-2">
          <div>
            <Label className="text-sm">
              Порог оценки: исключать, если моя оценка ниже{' '}
              <span className="font-bold text-sky-300">{settings.recRatingThreshold}</span> из 10
            </Label>
            <Slider
              aria-label="Порог своей оценки"
              min={1}
              max={10}
              step={1}
              value={[settings.recRatingThreshold]}
              onValueChange={([v]) => updateSettings({ recRatingThreshold: v })}
              onValueCommit={() => changeSetting({})}
              className="mt-3"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Тайтл с оценкой ниже порога не будет рекомендован, даже если похож на любимые
            </p>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="rec-exclude-known" className="text-sm">
                Скрывать уже известные тайтлы
              </Label>
              <Switch
                id="rec-exclude-known"
                checked={settings.recExcludeKnown}
                onCheckedChange={(v) => changeSetting({ recExcludeKnown: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="rec-diversity" className="text-sm">
                Разнообразие в выдаче
              </Label>
              <Switch
                id="rec-diversity"
                checked={settings.recDiversity}
                onCheckedChange={(v) => changeSetting({ recDiversity: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="rec-anilist" className="text-sm">
                  Кандидаты AniList
                </Label>
                <p className="text-xs text-muted-foreground">Экспериментально, нужен MAL ID на сайте</p>
              </div>
              <Switch
                id="rec-anilist"
                checked={settings.recAnilist}
                onCheckedChange={(v) => changeSetting({ recAnilist: v })}
              />
            </div>
          </div>
        </div>
      )}

      {/* --- честные состояния --- */}
      {loading && !data && <RecsSkeleton />}

      {!loading && error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
          ✗ {error}
          <div className="mt-3">
            <Button variant="outline" onClick={() => void load(true)} className="min-h-11 border-border">
              Повторить
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && data && data.mode === 'logged-out' && (
        <div className="rounded-xl border border-border bg-card/60 p-8 text-center">
          <LogIn className="mx-auto h-10 w-10 text-sky-400" aria-hidden />
          <h3 className="mt-3 text-lg font-semibold">Нужен аккаунт YummyAnime</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {data.reason ??
              'Персональные рекомендации строятся по вашей библиотеке, оценкам и избранному в аккаунте на сайте'}
          </p>
          <Button onClick={() => setAuthOpen(true)} className="mt-4 min-h-11">
            <LogIn className="h-4 w-4" aria-hidden />
            Войти на сайте
          </Button>
        </div>
      )}

      {!loading && !error && data && data.mode === 'unavailable' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center text-sm text-amber-200">
          {data.reason ?? 'Сайт недоступен'}
          <div className="mt-3">
            <Button variant="outline" onClick={() => void load(true)} className="min-h-11 border-border">
              Повторить
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && data && data.ok && data.message && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-sky-400/30 bg-sky-400/5 p-4 text-sm text-sky-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{data.message}</span>
        </div>
      )}

      {!loading && !error && data && data.stale && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          Показан сохранённый результат — сайт был недоступен для свежего пересчёта. Нажмите
          «Обновить» позже.
        </div>
      )}

      {/* --- сводка профиля --- */}
      {!loading && !error && data?.ok && data.profileSummary && data.mode !== 'logged-out' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Якорей вкуса: {data.profileSummary.positiveAnchors}
            {data.profileSummary.negativeAnchors > 0 && ` · исключено: ${data.profileSummary.excludedDropped + data.profileSummary.excludedLowRated}`}
            {` · известных: ${data.profileSummary.knownTitles}`}
            {` · кандидатов: ${data.profileSummary.candidates}`}
          </span>
          {data.profileSummary.topGenres.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              · ваши жанры:
              {data.profileSummary.topGenres.map((g) => (
                <Badge key={g} variant="outline" className="border-border px-1.5 py-0 text-[11px] text-muted-foreground">
                  {g}
                </Badge>
              ))}
            </span>
          )}
          {data.computedAt && (
            <span>· пересчитано {new Date(data.computedAt).toLocaleTimeString('ru-RU')}</span>
          )}
        </div>
      )}

      {/* --- карточки --- */}
      {!loading && !error && items.length === 0 && data?.ok && data.mode !== 'logged-out' && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Пока нечего предложить — добавьте оценки/статусы на сайте и нажмите «Обновить»
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((item) => (
          <RecCardView
            key={`${item.card.animeId}-${item.card.slug}`}
            item={item}
            onOpen={openCard}
            onFeedback={giveFeedback}
          />
        ))}
      </div>

      {/* --- «показать ещё» (инкрементальная загрузка, не сотни страниц разом) --- */}
      {!loading && items.length > visible && (
        <div className="mt-6 text-center">
          <Button
            variant="outline"
            onClick={() => setVisible((v) => v + PAGE_STEP)}
            className="min-h-11 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300"
          >
            Показать ещё ({items.length - visible})
          </Button>
        </div>
      )}

      {/* --- возврат скрытых (отзыв обратной связи — ТЗ §15) --- */}
      {!loading && hiddenCount > 0 && (
        <div className="mt-6 rounded-xl border border-border bg-card/60 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <EyeOff className="h-4 w-4" aria-hidden />
            Скрыто/отмечено: {hiddenCount}
          </p>
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {(data?.feedback ?? []).map((f) => (
              <button
                key={`${f.animeId}-${f.action}`}
                onClick={() => void undoFeedback(f.animeId)}
                title="Вернуть в рекомендации"
                className="flex min-h-9 items-center gap-1 rounded-full border border-border bg-background/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-sky-400/40 hover:text-sky-300"
              >
                <Undo2 className="h-3 w-3" aria-hidden />
                <span className="max-w-40 truncate">{f.title || `Аниме #${f.animeId}`}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- карточка рекомендации ---------------------------------------------------------

function RecCardView({
  item,
  onOpen,
  onFeedback,
}: {
  item: RecCard
  onOpen: (card: AnimeCard) => void
  onFeedback: (item: RecCard, action: 'hide' | 'seen') => Promise<void>
}) {
  const score = Math.round(item.score)
  const scoreTone =
    score >= 55 ? 'text-emerald-300' : score >= 30 ? 'text-sky-300' : 'text-muted-foreground'
  return (
    <div
      data-testid="rec-card"
      className="group flex gap-3 rounded-xl border border-border bg-card/60 p-3 transition-all hover:border-sky-400/40 hover:shadow-[0_0_18px_rgba(56,189,248,0.10)]"
    >
      <button
        onClick={() => onOpen(item.card)}
        aria-label={`Открыть: ${item.card.title}`}
        className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-lg"
      >
        {item.card.poster ? (
          <img
            src={item.card.poster}
            alt={item.card.title}
            loading="lazy"
            className="aspect-[3/4] w-20 rounded-lg object-cover transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex aspect-[3/4] w-20 items-center justify-center rounded-lg bg-background/60 text-[10px] text-muted-foreground">
            Нет постера
          </div>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <button
            onClick={() => onOpen(item.card)}
            className="line-clamp-2 text-left text-sm font-semibold text-foreground transition-colors hover:text-sky-300"
          >
            {item.card.title}
          </button>
          <span
            title="Внутренняя оценка соответствия вашим вкусам — не вероятность"
            className={cn('shrink-0 rounded-md bg-background/70 px-1.5 py-0.5 text-xs font-bold tabular-nums', scoreTone)}
          >
            {score}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
          {item.card.year !== null && <span>{item.card.year}</span>}
          {item.card.type && <span>· {item.card.type}</span>}
          {item.card.rating !== null && item.card.rating > 0 && <span>· ★ {item.card.rating.toFixed(1)}</span>}
          {item.card.status && <span>· {item.card.status}</span>}
        </div>
        {item.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {item.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-1 text-xs leading-snug text-sky-200/90">
                <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-sky-400/70" aria-hidden />
                <span className="line-clamp-2">{r}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpen(item.card)}
            className="h-8 border-border bg-background/40 px-2.5 text-xs hover:border-sky-400/40 hover:text-sky-300"
          >
            Открыть
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Не интересно: ${item.card.title}`}
            onClick={() => void onFeedback(item, 'hide')}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            Не интересно
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Уже видел: ${item.card.title}`}
            onClick={() => void onFeedback(item, 'seen')}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Уже видел
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- скелетон -----------------------------------------------------------------------

function RecsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-xl border border-border bg-card/40 p-3">
          <div className="aspect-[3/4] w-20 shrink-0 animate-pulse rounded-lg bg-background/60" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-4 w-4/5 animate-pulse rounded bg-background/60" />
            <div className="h-3 w-2/5 animate-pulse rounded bg-background/60" />
            <div className="h-3 w-full animate-pulse rounded bg-background/60" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-background/60" />
          </div>
        </div>
      ))}
    </div>
  )
}
