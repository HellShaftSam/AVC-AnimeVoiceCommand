/**
 * Anime Voice Controller — Zustand store (клиентское состояние приложения).
 *
 * Держит: вкладки (Browser layer), playback (Player Control), disambiguation,
 * голосовой статус, пайплайн распознавания (debug), настройки, back-stack вкладок.
 * Используется executor'ом и UI-компонентами.
 */
import { create } from 'zustand'
import {
  AnimeCard,
  AppSettings,
  BrowserTab,
  CommandResult,
  DEFAULT_SETTINGS,
  NavigationContext,
  PlaybackContext,
  PipelineStep,
  SiteSectionId,
  TabKind,
} from './types'

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'executing' | 'error'

export interface PendingOptions {
  query: string
  items: AnimeCard[]
}

export interface AddTabData {
  kind: TabKind
  title: string
  payload?: Record<string, unknown>
}

/** Снимок состояния вкладки для back-stack (kind+title+payload) */
export type BackStackEntry = Record<string, unknown>

export interface AvcState {
  // --- состояние ---
  tabs: BrowserTab[]
  activeTabId: string | null
  playback: PlaybackContext
  playerIframeUrl: string | null
  playerPlayerName: string | null
  pendingOptions: PendingOptions | null
  navigation: NavigationContext
  voiceStatus: VoiceStatus
  voiceMessage: string
  pipeline: PipelineStep[]
  lastExecuted: { raw: string; result: CommandResult } | null
  playerFullscreen: boolean
  episodesPanelOpen: boolean
  helpOpen: boolean
  settingsOpen: boolean
  debugOpen: boolean
  settings: AppSettings
  tabReloadCounter: Record<string, number>
  tabBackStack: Record<string, BackStackEntry[]>
  /** Инкрементится после записи в историю — HistoryPanel перезагружается */
  historyVersion: number

  // --- действия: вкладки ---
  addTab: (data: AddTabData) => string
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  patchTab: (
    id: string,
    patch: Partial<Pick<BrowserTab, 'kind' | 'title' | 'payload'>>,
  ) => void
  restoreSession: (tabs: BrowserTab[], activeId: string | null) => void

  // --- действия: плеер ---
  patchPlayback: (partial: Partial<PlaybackContext>) => void
  setPlayer: (url: string | null, playerName?: string | null) => void
  setPlayerFullscreen: (v: boolean) => void

  // --- действия: voice/диалоги ---
  setPendingOptions: (opts: PendingOptions | null) => void
  setVoiceStatus: (status: VoiceStatus, message?: string) => void
  setVoiceMessage: (message: string) => void
  pushPipeline: (steps: PipelineStep[]) => void
  resetPipeline: () => void
  setLastExecuted: (entry: { raw: string; result: CommandResult } | null) => void
  setEpisodesPanelOpen: (v: boolean) => void
  setHelpOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setDebugOpen: (v: boolean) => void

  // --- действия: настройки/прочее ---
  updateSettings: (partial: Partial<AppSettings>) => void
  bumpReload: (tabId: string) => void
  pushBackStack: (tabId: string, payload: BackStackEntry) => void
  popBackStack: (tabId: string) => BackStackEntry | null
  bumpHistoryVersion: () => void
}

// --- служебное ---------------------------------------------------------------

let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${Date.now().toString(36)}-${tabSeq}`
}

const INITIAL_TAB_ID = 'tab-home'

function makeHomeTab(id: string): BrowserTab {
  return { id, kind: 'home', title: 'Главная', payload: {}, createdAt: 0 }
}

const INITIAL_PLAYBACK: PlaybackContext = {
  animeId: null,
  animeTitle: null,
  animeSlug: null,
  currentEpisode: null,
  episodesAired: null,
  episodesTotal: null,
  currentDub: null,
  isPlaying: false,
  volume: 70,
  currentTime: 0,
  duration: 0,
}

function deriveNavigation(
  tabs: BrowserTab[],
  activeTabId: string | null,
  pendingOptions: PendingOptions | null,
): NavigationContext {
  const idx = tabs.findIndex((t) => t.id === activeTabId)
  const active = idx >= 0 ? tabs[idx] : null
  const raw = active && active.kind === 'section' ? active.payload.section : undefined
  const section: SiteSectionId = typeof raw === 'string' ? (raw as SiteSectionId) : 'home'
  return {
    currentSection: section,
    activeTabIndex: idx + 1,
    tabCount: tabs.length,
    pickingFromList: pendingOptions !== null,
  }
}

// --- store -------------------------------------------------------------------

export const useAvcStore = create<AvcState>()((set, get) => ({
  tabs: [makeHomeTab(INITIAL_TAB_ID)],
  activeTabId: INITIAL_TAB_ID,
  playback: INITIAL_PLAYBACK,
  playerIframeUrl: null,
  playerPlayerName: null,
  pendingOptions: null,
  navigation: deriveNavigation([makeHomeTab(INITIAL_TAB_ID)], INITIAL_TAB_ID, null),
  voiceStatus: 'idle',
  voiceMessage: '',
  pipeline: [],
  lastExecuted: null,
  playerFullscreen: false,
  episodesPanelOpen: false,
  helpOpen: false,
  settingsOpen: false,
  debugOpen: false,
  settings: { ...DEFAULT_SETTINGS },
  tabReloadCounter: {},
  tabBackStack: {},
  historyVersion: 0,

  // --- вкладки ---------------------------------------------------------------

  addTab: (data) => {
    const id = nextTabId()
    const tab: BrowserTab = {
      id,
      kind: data.kind,
      title: data.title,
      payload: data.payload ?? {},
      createdAt: Date.now(),
    }
    set((s) => {
      const tabs = [...s.tabs, tab]
      return { tabs, activeTabId: id, navigation: deriveNavigation(tabs, id, s.pendingOptions) }
    })
    return id
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return s
      let tabs = s.tabs.filter((t) => t.id !== id)
      const backStacks = { ...s.tabBackStack }
      delete backStacks[id]
      let activeTabId = s.activeTabId
      if (tabs.length === 0) {
        const home = makeHomeTab(nextTabId())
        home.createdAt = Date.now()
        tabs = [home]
        activeTabId = home.id
      } else if (activeTabId === id) {
        const neighbour = tabs[Math.min(idx, tabs.length - 1)]
        activeTabId = neighbour.id
      }
      return {
        tabs,
        activeTabId,
        tabBackStack: backStacks,
        navigation: deriveNavigation(tabs, activeTabId, s.pendingOptions),
      }
    }),

  setActiveTab: (id) =>
    set((s) =>
      s.tabs.some((t) => t.id === id)
        ? { activeTabId: id, navigation: deriveNavigation(s.tabs, id, s.pendingOptions) }
        : s,
    ),

  patchTab: (id, patch) =>
    set((s) => {
      const tabs = s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
      return { tabs, navigation: deriveNavigation(tabs, s.activeTabId, s.pendingOptions) }
    }),

  restoreSession: (tabs, activeId) =>
    set((s) => {
      const list: BrowserTab[] = tabs.length
        ? tabs
        : [makeHomeTab(nextTabId())]
      const active =
        activeId && list.some((t) => t.id === activeId) ? activeId : list[0].id
      return {
        tabs: list,
        activeTabId: active,
        navigation: deriveNavigation(list, active, s.pendingOptions),
      }
    }),

  // --- плеер -------------------------------------------------------------------

  patchPlayback: (partial) => set((s) => ({ playback: { ...s.playback, ...partial } })),

  setPlayer: (url, playerName = null) =>
    set({ playerIframeUrl: url, playerPlayerName: url ? playerName : null }),

  setPlayerFullscreen: (v) => set({ playerFullscreen: v }),

  // --- voice / диалоги ----------------------------------------------------------

  setPendingOptions: (opts) =>
    set((s) => ({
      pendingOptions: opts,
      navigation: deriveNavigation(s.tabs, s.activeTabId, opts),
    })),

  setVoiceStatus: (status, message) =>
    set((s) => ({ voiceStatus: status, voiceMessage: message ?? s.voiceMessage })),

  setVoiceMessage: (message) => set({ voiceMessage: message }),

  pushPipeline: (steps) =>
    set((s) => ({ pipeline: [...s.pipeline, ...steps].slice(-40) })),

  resetPipeline: () => set({ pipeline: [] }),

  setLastExecuted: (entry) => set({ lastExecuted: entry }),

  setEpisodesPanelOpen: (v) => set({ episodesPanelOpen: v }),
  setHelpOpen: (v) => set({ helpOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setDebugOpen: (v) => set({ debugOpen: v }),

  // --- настройки / прочее ---------------------------------------------------------

  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

  bumpReload: (tabId) =>
    set((s) => ({
      tabReloadCounter: {
        ...s.tabReloadCounter,
        [tabId]: (s.tabReloadCounter[tabId] ?? 0) + 1,
      },
    })),

  pushBackStack: (tabId, payload) =>
    set((s) => ({
      tabBackStack: {
        ...s.tabBackStack,
        [tabId]: [...(s.tabBackStack[tabId] ?? []), payload].slice(-20),
      },
    })),

  popBackStack: (tabId) => {
    const stack = get().tabBackStack[tabId] ?? []
    if (stack.length === 0) return null
    const entry = stack[stack.length - 1]
    set((s) => ({
      tabBackStack: { ...s.tabBackStack, [tabId]: stack.slice(0, -1) },
    }))
    return entry
  },

  bumpHistoryVersion: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
}))

/** Типизированный доступ к действию pushBackStack (payload-снимок вкладки) */
export function makeTabSnapshot(tab: BrowserTab): BackStackEntry {
  return { kind: tab.kind, title: tab.title, payload: tab.payload }
}
