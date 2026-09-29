/**
 * Anime Voice Controller — общие типы (слой контрактов между уровнями).
 *
 * Архитектура:
 *   Voice (ASR) → Command Parser → Command Executor
 *     → Browser (вкладки/навигация) + Player Control
 *     → Site Adapter (YummyAnime)
 */

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

export enum VoiceCommandType {
  OpenHome = 'OpenHome',
  OpenCatalog = 'OpenCatalog',
  OpenTop100 = 'OpenTop100',
  OpenOngoing = 'OpenOngoing',
  OpenAnnouncements = 'OpenAnnouncements',
  OpenSchedule = 'OpenSchedule',
  OpenRandom = 'OpenRandom',
  SearchAnime = 'SearchAnime',
  OpenAnime = 'OpenAnime',
  SelectEpisode = 'SelectEpisode',
  NextEpisode = 'NextEpisode',
  PreviousEpisode = 'PreviousEpisode',
  Play = 'Play',
  Pause = 'Pause',
  TogglePlayPause = 'TogglePlayPause',
  SeekForward = 'SeekForward',
  SeekBackward = 'SeekBackward',
  VolumeUp = 'VolumeUp',
  VolumeDown = 'VolumeDown',
  SetVolume = 'SetVolume',
  Fullscreen = 'Fullscreen',
  ExitFullscreen = 'ExitFullscreen',
  ToggleFullscreen = 'ToggleFullscreen',
  OpenNewTab = 'OpenNewTab',
  CloseTab = 'CloseTab',
  NextTab = 'NextTab',
  PreviousTab = 'PreviousTab',
  SelectTab = 'SelectTab',
  Reload = 'Reload',
  Back = 'Back',
  Forward = 'Forward',
  ScrollUp = 'ScrollUp',
  ScrollDown = 'ScrollDown',
  SelectVoice = 'SelectVoice',
  ShowEpisodes = 'ShowEpisodes',
  ShowHelp = 'ShowHelp',
  SelectOption = 'SelectOption', // выбор варианта из списка найденного (1..N)
  Unknown = 'Unknown',
}

export interface VoiceCommand {
  type: VoiceCommandType
  /** Параметры команды (query, episode, seconds, volume, index...) */
  params: Record<string, string | number | boolean | undefined>
  /** Уверенность парсера 0..1 */
  confidence: number
  /** Человекочитаемое описание */
  label: string
}

export interface CommandResult {
  success: boolean
  message: string
  error?: string
  /** Дополнительные данные (например, варианты для выбора) */
  data?: unknown
}

// ---------------------------------------------------------------------------
// Контекст (мастер-промпт #39, #108)
// ---------------------------------------------------------------------------

export type SiteSectionId =
  | 'home'
  | 'catalog'
  | 'ongoing'
  | 'announcements'
  | 'schedule'
  | 'top100'
  | 'random'

export interface PlaybackContext {
  animeId: number | null
  animeTitle: string | null
  animeSlug: string | null
  currentEpisode: number | null
  episodesAired: number | null
  episodesTotal: number | null
  currentDub: string | null
  isPlaying: boolean
  volume: number // 0..100
  currentTime: number // сек
  duration: number // сек
}

export interface NavigationContext {
  currentSection: SiteSectionId
  activeTabIndex: number
  tabCount: number
  /** Ожидается выбор варианта (список найденных аниме) */
  pickingFromList: boolean
}

export interface BrowserContext {
  navigation: NavigationContext
  playback: PlaybackContext
}

// ---------------------------------------------------------------------------
// Модель данных сайта (через адаптер)
// ---------------------------------------------------------------------------

export interface AnimeCard {
  animeId: number
  slug: string
  title: string
  poster: string | null
  year: number | null
  rating: number | null
  status: string | null
  type: string | null
}

export interface DubOption {
  /** Название озвучки, как на сайте ("Озвучка AniDUB", "Субтитры...") */
  name: string
  /** Короткое имя для сопоставления ("AniDUB") */
  shortName: string
  /** Количество серий в этой озвучке */
  episodes: number[]
}

export interface VideoEntry {
  videoId: number
  episode: number
  dubName: string
  playerName: string
  iframeUrl: string
  duration: number | null
}

export interface AnimeDetails extends AnimeCard {
  description: string | null
  genres: string[]
  studios: string[]
  episodesAired: number
  episodesTotal: number | null
  dubs: DubOption[]
  videos: VideoEntry[]
}

export interface SectionPage {
  section: SiteSectionId
  title: string
  page: number
  totalPages: number | null
  items: AnimeCard[]
  source: 'live' | 'cache' | 'demo'
}

// ---------------------------------------------------------------------------
// Пайплайн распознавания (для debug-панели, мастер-промпт #105)
// ---------------------------------------------------------------------------

export interface PipelineStep {
  stage: 'RAW' | 'NORMALIZED' | 'COMMAND' | 'PARAMS' | 'CONFIDENCE' | 'RESULT' | 'SOURCE'
  text: string
  ts: number
}

export type VoiceMode = 'push-to-talk' | 'always-listening'

export interface AppSettings {
  baseUrl: string
  voiceMode: VoiceMode
  wakeWordEnabled: boolean
  wakeWord: string
  confidenceThreshold: number
  ttsEnabled: boolean
  seekStep: number
  volumeStep: number
  defaultVolume: number
  autoplayNext: boolean
  couchMode: boolean
  saveHistory: boolean
  llmFallback: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://old.yummyani.me',
  voiceMode: 'push-to-talk',
  wakeWordEnabled: false,
  wakeWord: 'аниме',
  confidenceThreshold: 0.55,
  ttsEnabled: false,
  seekStep: 10,
  volumeStep: 10,
  defaultVolume: 70,
  autoplayNext: false,
  couchMode: false,
  saveHistory: true,
  llmFallback: true,
}

// ---------------------------------------------------------------------------
// Вкладки (Browser layer)
// ---------------------------------------------------------------------------

export type TabKind = 'home' | 'section' | 'search' | 'anime' | 'help'

export interface BrowserTab {
  id: string
  kind: TabKind
  title: string
  /** sectionId | query | slug */
  payload: Record<string, unknown>
  createdAt: number
}
