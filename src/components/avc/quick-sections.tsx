'use client'
/**
 * QuickSections — быстрый ряд кнопок секций (мобильно — горизонтальный скролл).
 * Клик = вызов executeCommand через хелпер openSection.
 */
import type { LucideIcon } from 'lucide-react'
import {
  CalendarClock,
  CalendarDays,
  Compass,
  Dices,
  Home,
  Library,
  Sparkles,
  Trophy,
} from 'lucide-react'
import { openSection } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { SiteSectionId } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

interface SectionDef {
  id: SiteSectionId
  label: string
  icon: LucideIcon
}

const SECTIONS: SectionDef[] = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'catalog', label: 'Каталог', icon: Library },
  { id: 'top100', label: 'ТОП-100', icon: Trophy },
  { id: 'ongoing', label: 'Онгоинги', icon: Sparkles },
  { id: 'announcements', label: 'Анонсы', icon: CalendarClock },
  { id: 'schedule', label: 'Расписание', icon: CalendarDays },
  { id: 'random', label: 'Случайное', icon: Dices },
]

/** Отдельная кнопка рекомендаций — это вкладка (kind), а не секция сайта */
function RecommendationsButton() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) ?? null
  const activeBtn = active?.kind === 'recommendations'
  return (
    <button
      onClick={() => void executeOpenRecommendations()}
      aria-label="Открыть: Рекомендации"
      aria-current={activeBtn ? 'page' : undefined}
      className={cn(
        'group flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        activeBtn
          ? 'border-gold-400/60 bg-gold-400/15 text-gold-200 shadow-[0_0_16px_rgba(229,188,94,0.22)]'
          : 'border-border bg-card/60 text-foreground hover:border-gold-400/35 hover:text-gold-200',
      )}
    >
      {/* узел-созвездие слева (референс: круглые светящиеся узлы на золотой линии) */}
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
          activeBtn
            ? 'bg-gold-200 shadow-[0_0_8px_rgba(242,221,164,0.9)]'
            : 'bg-night-500 group-hover:bg-gold-400/70',
        )}
      />
      <Compass className="h-5 w-5" aria-hidden />
      Рекомендации
    </button>
  )
}

/** Открыть вкладку рекомендаций (используется и кнопкой, и голосом через executor) */
async function executeOpenRecommendations(): Promise<unknown> {
  const { openRecommendations } = await import('@/lib/avc/executor')
  return openRecommendations()
}

/** Отдельная кнопка Anime Companion — это вкладка (kind), а не секция сайта */
function CompanionButton() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) ?? null
  const activeBtn = active?.kind === 'companion'
  return (
    <button
      onClick={() => void executeOpenCompanion()}
      aria-label="Открой: Anime Companion"
      aria-current={activeBtn ? 'page' : undefined}
      data-testid="quick-companion"
      className={cn(
        'group flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        activeBtn
          ? 'border-gold-400/60 bg-gold-400/15 text-gold-200 shadow-[0_0_16px_rgba(229,188,94,0.22)]'
          : 'border-border bg-card/60 text-foreground hover:border-gold-400/35 hover:text-gold-200',
      )}
    >
      {/* узел-созвездие слева (как у всех кнопок ряда) */}
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
          activeBtn
            ? 'bg-gold-200 shadow-[0_0_8px_rgba(242,221,164,0.9)]'
            : 'bg-night-500 group-hover:bg-gold-400/70',
        )}
      />
      <Sparkles className="h-5 w-5" aria-hidden />
      Компаньон
    </button>
  )
}

/** Открыть вкладку Anime Companion (используется и кнопкой, и голосом через executor) */
async function executeOpenCompanion(): Promise<unknown> {
  const { openCompanionTab } = await import('@/lib/avc/executor')
  return openCompanionTab()
}

export function QuickSections() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) ?? null

  const isActive = (id: SiteSectionId): boolean => {
    if (!active) return false
    if (id === 'home') return active.kind === 'home'
    return active.kind === 'section' && active.payload.section === id
  }

  return (
    <div className="avc-scroll glass overflow-x-auto border-b border-gold-300/15 px-3 py-2 sm:px-4">
      <div className="flex gap-2">
        <RecommendationsButton />
        <CompanionButton />
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const activeBtn = isActive(id)
          return (
            <button
              key={id}
              onClick={() => void openSection(id)}
              aria-label={`Открыть: ${label}`}
              aria-current={activeBtn ? 'page' : undefined}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                activeBtn
                  ? 'border-gold-400/60 bg-gold-400/15 text-gold-200 shadow-[0_0_16px_rgba(229,188,94,0.22)]'
                  : 'border-border bg-card/60 text-foreground hover:border-gold-400/35 hover:text-gold-200',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
                  activeBtn
                    ? 'bg-gold-200 shadow-[0_0_8px_rgba(242,221,164,0.9)]'
                    : 'bg-night-500',
                )}
              />
              <Icon className="h-5 w-5" aria-hidden />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
