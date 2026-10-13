'use client'
/**
 * NavBar — единая навигационная панель (ТЗ «вкладки → стрелки назад/вперёд»).
 *
 * Переход в Каталог/поиск/аниме больше НЕ создаёт вкладок: каждое открытие
 * попадает в единую историю, а стрелки листают её как в браузере. Плюс
 * живой поиск: пишешь «Н» — все на Н, «На» — все на «На», «Наруто» — все
 * где есть название (ранжирование по приоритету букв — /api/site/suggest).
 *
 * Горячие клавиши: Alt+← назад, Alt+→ вперёд, Ctrl+F — фокус в поиск.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Compass,
  Dices,
  Home,
  Library,
  Search,
  Sparkles,
  Trophy,
  User,
} from 'lucide-react'
import { useAvcStore } from '@/lib/avc/store'
import type { BrowserTab } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Статичная карта иконок мест: kind или payload.section → иконка (без создания в рендере) */
const KIND_ICONS: Record<string, typeof Home> = {
  home: Home,
  search: Search,
  anime: Sparkles,
  recommendations: Compass,
  companion: User,
  catalog: Library,
  top100: Trophy,
  ongoing: Sparkles,
  announcements: CalendarClock,
  schedule: CalendarDays,
  random: Dices,
}

/** Иконка текущего места (рядом с адресом, как favicon в браузере) — статичный компонент */
function LocationIcon({ tab }: { tab: BrowserTab | null }) {
  const key = tab ? (tab.kind === 'section' ? String(tab.payload.section ?? '') : tab.kind) : 'home'
  const Icon = KIND_ICONS[key] ?? Library
  return <Icon className="h-4 w-4 shrink-0 text-gold-300" aria-hidden />
}

export function NavBar() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const navIndex = useAvcStore((s) => s.navIndex)
  const navHistoryLen = useAvcStore((s) => s.navHistory.length)
  const active: BrowserTab | null = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null

  const canBack = navIndex > 0
  const canForward = navIndex < navHistoryLen - 1

  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const focusedRef = useRef(false)

  // Синхронизация поля с активным местом: голос «найди наруто» заполняет строку,
  // уход из поиска — очищает. Пока поле в фокусе — не мешаем печатать.
  // (setState — в отложенном таймауте: правило react-hooks/set-state-in-effect)
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (focusedRef.current) return
      if (active?.kind === 'search') {
        setQuery(typeof active.payload.query === 'string' ? active.payload.query : '')
      } else {
        setQuery('')
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [active?.kind, active?.payload.query])

  const navigateSearch = useCallback((q: string) => {
    const st = useAvcStore.getState()
    const cur = st.tabs.find((t) => t.id === st.activeTabId)
    if (cur?.kind === 'search' && cur.payload.live === true) {
      // живой ввод продолжается: патчим payload без новой записи истории
      st.patchTab(cur.id, { payload: { ...cur.payload, query: q } })
    } else {
      st.navigate({ kind: 'search', title: 'Поиск', payload: { query: q, live: true } })
    }
  }, [])

  const onQueryChange = (v: string) => {
    setQuery(v)
    const trimmed = v.trim()
    if (trimmed.length === 0) return // пустое поле не навигирует
    navigateSearch(trimmed)
  }

  // Горячие клавиши панели
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        useAvcStore.getState().goBack()
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        useAvcStore.getState().goForward()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <nav
      aria-label="Навигация"
      className="glass relative flex items-center gap-1.5 border-b border-gold-300/15 px-2 py-1.5 sm:gap-2 sm:px-3"
    >
      {/* Стрелки истории (ТЗ: «стрелками переходить в прошлые или вперед») */}
      <button
        aria-label="Назад по истории"
        title="Назад (Alt+←)"
        data-testid="nav-back"
        disabled={!canBack}
        onClick={() => useAvcStore.getState().goBack()}
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          canBack
            ? 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300'
            : 'cursor-not-allowed border-border/40 bg-card/30 text-muted-foreground/40',
        )}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden />
      </button>
      <button
        aria-label="Вперёд по истории"
        title="Вперёд (Alt+→)"
        data-testid="nav-forward"
        disabled={!canForward}
        onClick={() => useAvcStore.getState().goForward()}
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          canForward
            ? 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300'
            : 'cursor-not-allowed border-border/40 bg-card/30 text-muted-foreground/40',
        )}
      >
        <ArrowRight className="h-5 w-5" aria-hidden />
      </button>

      {/* Адрес текущего места */}
      <span
        aria-current="location"
        className="flex max-w-[220px] min-w-0 shrink items-center gap-1.5 rounded-lg border border-gold-400/25 bg-gold-400/5 px-2.5 py-2 text-sm font-medium text-gold-200"
        title={active?.title ?? 'Главная'}
      >
        <LocationIcon tab={active} />
        <span className="truncate">{active?.title ?? 'Главная'}</span>
      </span>

      {/* Живой поиск (ТЗ: «написать и там уже появлялись тайтлы по названиям») */}
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          role="searchbox"
          aria-label="Поиск аниме по названию"
          placeholder="Поиск аниме: начните вводить название… (Ctrl+F)"
          data-testid="nav-search"
          value={query}
          onFocus={() => (focusedRef.current = true)}
          onBlur={() => (focusedRef.current = false)}
          onChange={(e) => onQueryChange(e.target.value)}
          className={cn(
            'h-10 w-full rounded-lg border border-border bg-card/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/70',
            'transition-colors focus:border-gold-400/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        />
      </div>

      {/* золотая линия под панелью (референс — золотая горизонталь) */}
      <span aria-hidden className="gold-hairline absolute inset-x-0 bottom-0 h-px" />
    </nav>
  )
}
