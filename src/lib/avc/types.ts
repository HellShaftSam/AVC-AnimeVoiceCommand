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
  Mute = 'Mute',
  Unmute = 'Unmute',
  /** «добавь в смотрю / планы…» — статусы ведёт сайт; команда откроет страницу тайтла */
  SetWatchStatus = 'SetWatchStatus',
  /** «добавь в избранное» — избранное ведётся на сайте; команда подскажет/откроет сайт */
  ToggleFavorite = 'ToggleFavorite',
  ContinueWatching = 'ContinueWatching', // «продолжить просмотр» (по локальной сессионной метке)
  ShowLibrary = 'ShowLibrary', // «открой библиотеку» — панель избранного YummyAnime
  /** «открой мой профиль», «проверь аккаунт», «выйди из аккаунта» */
  OpenProfile = 'OpenProfile',
  CheckAccount = 'CheckAccount',
  AccountLogout = 'AccountLogout',
  AddVoiceAlias = 'AddVoiceAlias', // «добавь "ани либрия" как команду для AniLibria»
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

// ---------------------------------------------------------------------------
// Аккаунт YummyAnime — РЕАЛЬНАЯ сессия сайта (сайт = источник истины).
// Локального аккаунта больше нет: thin client (спецификация «YummyAnime
// Real-Site Account Integration», секции 1, 4, 6, 10).
// ---------------------------------------------------------------------------

/** Машина состояний авторизации (спецификация, секция 4) */
export type YummyAuthState =
  | 'unknown' // ещё не проверяли
  | 'checking' // идёт проверка
  | 'loggedOut' // гость: сессии нет или сайт подтвердил выход
  | 'loggedIn' // сайт подтвердил сессию
  | 'sessionExpired' // cookie была, но сайт отвечает 401
  | 'unavailable' // сайт недоступен — используем кеш (спецификация, секция 25)

/**
 * Снимок пользователя с сайта. Локальный кеш только для отрисовки UI,
 * НЕ источник истины (спецификация, секция 6).
 */
export interface YummyUserSnapshot {
  userId: string | null
  username: string | null
  displayName: string | null
  avatarUrl: string | null
}

/** Результат синхронизации аккаунта */
export interface YummyAccountSnapshot {
  state: YummyAuthState
  user: YummyUserSnapshot | null
  /** ISO-время последней успешной синхронизации */
  lastSync: string | null
  source: 'live' | 'cache' | 'no-session' | 'error'
  /** Человекочитаемое сообщение (без секретов — секция 37) */
  message: string | null
}

/** Элемент избранного с сайта */
export interface YummyFavoriteItem {
  animeId: number | null
  slug: string | null
  title: string
  poster: string | null
}

/** Ответ адаптера по избранному. unavailable = честно сообщаем, а не выдумываем */
export interface YummyFavoritesResult {
  available: boolean
  items: YummyFavoriteItem[]
  reason: string | null
  lastSync: string | null
}

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
export type SttEngine = 'auto' | 'browser' | 'server'

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
  // --- Микрофон и распознавание (улучшенный голосовой ввод) ---
  /** Программное усиление микрофона 1..4 (WebAudio GainNode) */
  micGain: number
  /** Чувствительность VAD 0..100: выше = срабатывает от тише речи */
  vadSensitivity: number
  /** Какой движок STT использовать: авто / браузерный / серверный (Whisper) */
  sttEngine: SttEngine
  noiseSuppression: boolean
  autoGainControl: boolean
  echoCancellation: boolean
  /** deviceId выбранного микрофона ('' = по умолчанию) */
  micDeviceId: string
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
  micGain: 1,
  vadSensitivity: 50,
  sttEngine: 'auto',
  noiseSuppression: true,
  autoGainControl: true,
  echoCancellation: true,
  micDeviceId: '',
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

// ---------------------------------------------------------------------------
// Резолвер озвучек (Voice Provider Resolver) — пороги принятия решения
// ---------------------------------------------------------------------------

/** >= AUTO — переключаем молча */
export const VOICE_CONFIDENCE_AUTO = 0.85
/** >= ASK — спрашиваем подтверждение; ниже — отказ */
export const VOICE_CONFIDENCE_ASK = 0.55

export interface VoiceProviderMatch {
  /** Название на сайте (как в dubs[].name) */
  name: string
  shortName: string
  confidence: number
  matchedVia: 'exact' | 'alias' | 'translit' | 'fuzzy'
}

/** Пользовательские алиасы озвучек (из БД) */
export type VoiceAliasMap = Record<string, string[]> // нормализованное имя озвучки -> варианты

/** Строка алиаса, как её отдаёт /api/aliases */
export interface VoiceAliasRow {
  id: string
  targetType: string
  targetName: string
  alias: string
}
