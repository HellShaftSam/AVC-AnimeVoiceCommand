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
  /** «открой рекомендации» — вкладка персональных рекомендаций */
  OpenRecommendations = 'OpenRecommendations',
  /** «открой компаньон/хроники/заметки» — вкладка Anime Companion (payload.sub) */
  OpenCompanion = 'OpenCompanion',
  /** «сохрани/запомни этот момент» — закладка позиции воспроизведения */
  SaveMoment = 'SaveMoment',
  /** «напомни, что происходило» — честное резюме из своих заметок (без выдумок) */
  RecapRequest = 'RecapRequest',
  /** «покажи незаконченные аниме» — список начатых и не завершённых */
  ShowUnfinished = 'ShowUnfinished',
  /** «покажи порядок просмотра» — скролл к таймлайну франшизы открытого аниме */
  ShowWatchOrder = 'ShowWatchOrder',
  /** «сколько серий осталось» — арифметика по трекингу просмотра */
  HowManyEpisodesLeft = 'HowManyEpisodesLeft',
  /** «найди что-нибудь мрачное с сильным героем» — лексикон настроений → компас */
  MoodSearch = 'MoodSearch',
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
  /** «добавь в смотрю / планы…» — РЕАЛЬНОЕ действие через сессию сайта (EXE) */
  SetWatchStatus = 'SetWatchStatus',
  /** «добавь в избранное» — РЕАЛЬНОЕ действие через сессию сайта (EXE) */
  ToggleFavorite = 'ToggleFavorite',
  /** «оцени на 8» — РЕАЛЬНАЯ оценка 1..10 через сессию сайта (EXE) */
  RateAnime = 'RateAnime',
  /** «убери оценку» — DELETE /anime/{id}/rate через сессию сайта (EXE) */
  RemoveRating = 'RemoveRating',
  /** «убери из списка» — DELETE /anime/{id}/list: тайтл не должен молча застревать в списках */
  RemoveWatchStatus = 'RemoveWatchStatus',
  /** «пропусти опенинг/эндинг» — перемотка через Skip Segments (или fallback +N сек) */
  SkipSegment = 'SkipSegment',
  /** «вернись/отмени пропуск» — возврат к началу только что пропущенного сегмента */
  UndoSkip = 'UndoSkip',
  /** «включи/выключи автопропуск опенинга/эндинга» */
  SetAutoSkip = 'SetAutoSkip',
  /** «запомни начало/конец опенинга» — пользовательская отметка таймкода (P3) */
  MarkSegment = 'MarkSegment',
  ContinueWatching = 'ContinueWatching', // «продолжить просмотр» (по локальной сессионной метке)
  ShowLibrary = 'ShowLibrary', // «открой библиотеку» — панель библиотеки YummyAnime
  /** «что я смотрю», «на какой серии я» — ответ по локальному трекингу просмотра */
  WhatAmIWatching = 'WhatAmIWatching',
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

// --- Диагностика аутентификации (спецификация, секция 20) --------------------

export type YummySelfTestStatus = 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED'

/** Один шаг диагностического отчёта (только безопасные данные) */
export interface YummyAuthSelfTestStep {
  name: string
  status: YummySelfTestStatus
  /** Человекочитаемая деталь БЕЗ cookie/токенов/паролей (секция 15) */
  detail: string
}

/** Безопасный отчёт самопроверки аутентификации YummyAnime */
export interface YummyAuthSelfTestReport {
  ranAt: string
  website: string
  /** Тип браузерной сессии: постоянный профиль (требование секции 3) */
  sessionKind: 'persistent' | 'unknown'
  /** Машина состояний AuthenticationService (секция 5) */
  authState: string
  authenticated: boolean
  username: string | null
  profileAvailable: boolean
  lastVerifiedAt: string | null
  persistence: YummySelfTestStatus
  loginDetection: YummySelfTestStatus
  logoutDetection: YummySelfTestStatus
  network: 'ONLINE' | 'OFFLINE'
  steps: YummyAuthSelfTestStep[]
}

/** Ответ адаптера по избранному. unavailable = честно сообщаем, а не выдумываем */
export interface YummyFavoritesResult {
  available: boolean
  items: YummyFavoriteItem[]
  reason: string | null
  lastSync: string | null
}

// --- Библиотека YummyAnime (списки статусов с сайта) --------------------------
// Эндпоинт снят с живого сайта (октябрь 2026, session-проверка):
// GET /api/users/{numericId}/lists/{listId} → { response: [...] }
// listId — точные значения из бандла сайта (массив Rt) и профиля.

export type YummyListId = 0 | 1 | 2 | 3 | 4 | 5

/** Точные названия списков на сайте (list_id → название) */
export const YUMMY_LIST_NAMES: Record<YummyListId, string> = {
  0: 'Смотрю',
  1: 'В Планах',
  2: 'Просмотрено',
  3: 'Брошено',
  4: 'Любимые',
  5: 'Отложено',
}

export const YUMMY_LIST_IDS: readonly YummyListId[] = [0, 1, 2, 3, 4, 5]

/** Элемент списка библиотеки с сайта (защитно нормализованный) */
export interface YummyLibraryItem {
  animeId: number | null
  slug: string | null
  title: string
  poster: string | null
  year: number | null
  /** Рейтинг сайта (например 6.18) */
  siteRating: number | null
  /** Своя оценка (user.rating, 1..10; 0 → null) */
  ownRating: number | null
  /** В избранном (user.list.is_fav) */
  isFavorite: boolean
  /** Фактический список, в котором лежит тайтл (user.list.list.id) */
  listId: number | null
  /** Название списка как на сайте (user.list.list.title) */
  listTitle: string | null
  /** Статус тайтла: «вышел» / «онгоинг» / «анонс» */
  animeStatus: string | null
  /** released / ongoing / announced */
  animeStatusAlias: string | null
  /** Тип: TV / OVA / Фильм … */
  type: string | null
  /** Unix-время выхода следующей серии (0/нет → null) */
  nextEpisodeAt: number | null
  /** Unix-время добавления в список */
  addedAt: number | null
}

/** Один список библиотеки */
export interface YummyLibraryList {
  listId: YummyListId
  name: string
  count: number
  items: YummyLibraryItem[]
}

/** Ответ GET /api/yummy/library. unavailable → честная причина */
export interface YummyLibraryResult {
  available: boolean
  /** Порядок фиксированный: 0,1,2,3,5,4 (Любимые последними, как на сайте) */
  lists: YummyLibraryList[]
  reason: string | null
  lastSync: string | null
}

// --- Локальный трекинг просмотра (БД приложения) ------------------------------
// Сайт пишет прогресс внутри своей сессии (PUT /video/{id}), но наружу
// состояние серий не отдаёт — приложение ведёт собственную запись.

export interface WatchProgressItem {
  animeId: number
  slug: string
  title: string
  poster: string | null
  /** Последняя открытая серия (null — аниме открыто, но серия не включалась) */
  episode: number | null
  /** Всего серий известно приложению на момент записи */
  episodesTotal: number | null
  dubbing: string | null
  updatedAt: string
}

export interface WatchProgressResult {
  available: boolean
  items: WatchProgressItem[]
  reason: string | null
}

export interface PlaybackContext {
  animeId: number | null
  animeTitle: string | null
  animeSlug: string | null
  /** MAL ID тайтла (remote_ids с сайта) — нужен для Aniskip (пропуска опенингов) */
  malId: number | null
  currentEpisode: number | null
  episodesAired: number | null
  episodesTotal: number | null
  currentDub: string | null
  isPlaying: boolean
  volume: number // 0..100
  currentTime: number // сек
  duration: number // сек
  /** skips текущей открытой серии (для auto-skip в player.tsx) */
  currentSkips: VideoSkips | null
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
  /**
   * Unix-время (СЕКУНДЫ) выхода следующей серии, если сайту известно
   * (детали /api/anime/{id} → episodes.next_date; расписание → data-time).
   * null/undefined — дата неизвестна (честно не показываем).
   */
  nextEpisodeAt?: number | null
  /** Вышло серий (из деталей); для плиток онгоингов/анонсов */
  episodesAired?: number | null
  /** Всего серий (из деталей); null — неизвестно */
  episodesTotal?: number | null
  /**
   * Дата выхода с точностью (анонсы: батч release-meta); при undefined —
   * обычный бейдж по nextEpisodeAt. Заполняется секцией «Анонсы».
   */
  releaseDate?: ReleaseDateInfo | null
}

export interface DubOption {
  /** Название озвучки, как на сайте ("Озвучка AniDUB", "Субтитры...") */
  name: string
  /** Короткое имя для сопоставления ("AniDUB") */
  shortName: string
  /** Количество серий в этой озвучке */
  episodes: number[]
}

/** Сегмент пропуска из /api/anime/{id}/videos (проверено живым API: {time,length} в секундах) */
export interface VideoSkipSegment {
  /** Начало сегмента, сек */
  time: number
  /** Длина сегмента, сек */
  length: number
}

export interface VideoSkips {
  opening: VideoSkipSegment | null
  ending: VideoSkipSegment | null
}

export interface VideoEntry {
  videoId: number
  episode: number
  dubName: string
  playerName: string
  iframeUrl: string
  duration: number | null
  /** Тайминги опенинга/эндинга (сайт отдаёт в /videos; у части записей null) */
  skips: VideoSkips | null
}

/** Элемент франшизы (порядок просмотра с сайта, поле viewing_order /api/anime/{id}) */
export interface RelatedAnime {
  animeId: number
  slug: string
  title: string
  poster: string | null
  year: number | null
  type: string | null
  status: string | null
  /** Связь с текущим тайтлом: «1 сезон», «фильм 2», «адаптация манги», «после 141 серии»… */
  relation: string | null
  /** Порядок просмотра, как на сайте (data.index) */
  order: number
  /** Это то самое аниме, страница которого открыта (не кликается) */
  isCurrent?: boolean
}

export interface AnimeDetails extends AnimeCard {
  description: string | null
  genres: string[]
  studios: string[]
  episodesAired: number
  episodesTotal: number | null
  /** Unix-время (сек) следующей серии из details API (episodes.next_date); null — не известно */
  nextEpisodeAt?: number | null
  /** Unix-время (сек) предыдущей серии (episodes.prev_date) — для периодичности расписания */
  episodesPrevDate?: number | null
  /** Машинный статус сайта (anime_status.alias): released | ongoing | announcement */
  statusAlias?: string | null
  dubs: DubOption[]
  videos: VideoEntry[]
  /** MAL ID (MyAnimeList) с сайта — для Aniskip; null если сайт не отдал */
  malId?: number | null
  /** Франшиза в порядке просмотра (LIVE-VERIFY: /api/anime/{id} → viewing_order); пусто/нет — блок не показывается */
  viewingOrder?: RelatedAnime[]
  /** Откуда данные: live — реальный сайт; demo — сетевой fallback (честный бейдж в UI) */
  source?: 'live' | 'demo'
}

// ---------------------------------------------------------------------------
// Даты выхода и трейлеры анонсов (многоисточниковая система: YummyAnime +
// AniList GraphQL, резерв Jikan). Все времена — unix СЕКУНДЫ, отображение —
// Астана (Asia/Almaty) на клиенте.
// ---------------------------------------------------------------------------

/** Точность известной даты выхода (честная, без выдумок) */
export type ReleasePrecision = 'day' | 'month' | 'year' | 'unknown'

/** Дата выхода с указанием точности и происхождения (ТЗ §3: не придумывать даты) */
export interface ReleaseDateInfo {
  /** day → точная дата (unix); month/year → только m/y; unknown → ничего */
  precision: ReleasePrecision
  /** Точный момент (unix сек, UTC) — только при precision='day', иначе null */
  unix: number | null
  y: number | null
  /** 1..12 */
  m: number | null
  d: number | null
  /** Источник: 'yummy' | 'anilist' | 'jikan' */
  source: string
  /** true — подтверждено источником; false — расчётная/конфликт источников */
  confirmed: boolean
  /** Происхождение/конфликт: «по AniList: 11 октября 2026» и т.п. */
  note: string | null
}

/** Официальный видеоролик (трейлер/тизер/PV) анонсированного тайтла */
export interface TrailerInfo {
  /** YouTube ID (встраивание — youtube.com/embed/{id}; видео не храним) */
  youtubeId: string
  /** Подпись: «Тизер», «Трейлер 2», «PV» … */
  title: string
  /** Откуда ролик: yummy (сайт), anilist, jikan */
  source: string
}

/** Следующая серия с подтверждённым временем */
export interface NextEpisodeInfo {
  number: number
  /** Unix сек (UTC) */
  at: number
  source: string
}

/** Расписание серий (ТЗ §14: премьера ≠ расписание эпизодов) */
export interface EpisodeScheduleInfo {
  /** Подтверждённая следующая серия (точное время) */
  next: NextEpisodeInfo | null
  /** Подтверждённая еженедельная периодичность (day 1=Пн…7=Вс, время Астаны) */
  weekly: { weekday: number; hh: number; mm: number } | null
  /** Расчётные будущие серии (пометить «расчётная дата») — только при weekly */
  estimated: Array<{ number: number; at: number }>
  /** false → «Расписание серий пока не объявлено» */
  announced: boolean
}

/** Сводное состояние тайтла (логические состояния ТЗ §6) */
export type ReleaseStatus =
  | 'announced' // анонс, эпизодов нет
  | 'upcoming' // анонс + известна будущая дата премьеры
  | 'airing' // выходит, есть эпизоды
  | 'released' // вышел полностью
  | 'delayed' // дата прошла/перенос, эпизодов нет
  | 'unknown'

/** Полные метаданные выхода для одного тайтла (ответ /api/site/release-meta) */
export interface ReleaseMeta {
  status: ReleaseStatus
  releaseDate: ReleaseDateInfo
  nextEpisode: NextEpisodeInfo | null
  schedule: EpisodeScheduleInfo
  trailers: TrailerInfo[]
  /** Момент последней проверки (Date.now()) */
  checkedAt: number
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
// Расписание онгоингов по дням недели (/catalog/schedule)
// ---------------------------------------------------------------------------

/** Карточка расписания: аниме + время выхода следующей серии */
export interface ScheduleEntry extends AnimeCard {
  /** Unix-время выхода следующей серии, СЕКУНДЫ (site local-time[data-time]); null — не распознано */
  releaseAt: number | null
}

/** Один день недели с онгоингами */
export interface ScheduleDay {
  /** «Понедельник» … «Воскресенье» (метка «(сегодня)» убрана) */
  day: string
  /** 1..7, Пн=1 … Вс=7 */
  dayIndex: number
  /** Сайт пометил день как сегодняшний */
  isToday: boolean
  items: ScheduleEntry[]
}

export interface SchedulePage {
  days: ScheduleDay[]
  /** live — реальный сайт; demo — сайт недоступен */
  source: 'live' | 'demo'
  /** Момент загрузки (Date.now()) — для пересчёта «через N минут» */
  fetchedAt: number
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
export type SttEngine = 'auto' | 'browser' | 'server' | 'local'
/** Профиль производительности AI-слоя (спецификация §19) */
export type AiProfile = 'max_responsiveness' | 'balanced' | 'quality'

export interface AppSettings {
  baseUrl: string
  voiceMode: VoiceMode
  wakeWordEnabled: boolean
  wakeWord: string
  confidenceThreshold: number
  seekStep: number
  volumeStep: number
  defaultVolume: number
  autoplayNext: boolean
  couchMode: boolean
  saveHistory: boolean
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
  /** Жёсткий кап длительности фразы, мс (4000..30000; жалоба «обрезает на 15 с») */
  maxUtteranceMs: number
  /** Автопропуск опенинга/эндинга по skips из /videos (точные тайминги сайта) */
  autoSkipIntros: boolean
  /** Ручной автопропуск опенинга: первые N секунд серии (когда таймингов сайта нет) */
  autoSkipOpening: boolean
  /** Длительность опенинга для ручного пропуска, сек (слайдер у плеера) */
  autoSkipOpeningSec: number
  /** Ручной автопропуск эндинга: последние N секунд серии */
  autoSkipEnding: boolean
  /** Сколько секунд до конца считать эндингом, сек (слайдер у плеера) */
  autoSkipEndingSec: number
  // --- Skip Segments (пропуск опенинга/эндинга/рекапы) -------------------------
  /** Режим: off — ничего; button — только кнопка; auto — кнопка + автопропуск */
  skipMode: 'off' | 'button' | 'auto'
  /** Пропускать опенинги (тип сегмента op) */
  skipOp: boolean
  /** Пропускать эндинги (тип сегмента ed) */
  skipEd: boolean
  /** Пропускать рекапы (тип сегмента recap) */
  skipRecap: boolean
  /** Источник «тайминги сайта» (skips из /videos) включён */
  skipSourceSite: boolean
  /** Источник Aniskip (краудсорсинг по MAL ID) включён */
  skipSourceAniskip: boolean
  /** Порог уверенности для АВТОПРОПУСКА (0..1); кнопка показывается всегда */
  skipConfidence: number
  /** Задержка автопропуска после начала сегмента, сек */
  skipAutoDelaySec: number
  /** Fallback без данных: «пропусти опенинг» перематывает на N секунд */
  skipFallbackSec: number
  // --- Локальный AI-слой (спецификация §4–§134; работает только в EXE) --------
  /** Профиль производительности STT (§19); LLM/TTS удалены из релиза по решению владельца */
  aiProfile: AiProfile
  // --- Рекомендации (персональная вкладка; пороги/поведение движка) -----------
  /** Порог своей оценки: ниже — тайтл жёстко исключён (по умолчанию 5 из 10) */
  recRatingThreshold: number
  /** Исключать из выдачи уже известные тайтлы (любой список/история) */
  recExcludeKnown: boolean
  /** MMR-разнообразие против «двадцати одинаковых шоу» */
  recDiversity: boolean
  /** Внешние кандидаты AniList (экспериментально; по умолчанию выключено) */
  recAnilist: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://old.yummyani.me',
  voiceMode: 'push-to-talk',
  wakeWordEnabled: false,
  wakeWord: 'аниме',
  confidenceThreshold: 0.55,
  seekStep: 10,
  volumeStep: 10,
  defaultVolume: 70,
  autoplayNext: false,
  couchMode: false,
  saveHistory: true,
  micGain: 1,
  vadSensitivity: 50,
  sttEngine: 'auto',
  noiseSuppression: true,
  autoGainControl: true,
  echoCancellation: true,
  micDeviceId: '',
  maxUtteranceMs: 12000,
  autoSkipIntros: false,
  // Автопропуск по слайдерам — как на других сайтах: работает сразу, без таймингов
  // сайта; защита от коротких видео — в player.tsx (серию короче OP+4 мин не трогаем)
  autoSkipOpening: true,
  autoSkipOpeningSec: 85,
  autoSkipEnding: true,
  autoSkipEndingSec: 30,
  skipMode: 'button',
  skipOp: true,
  skipEd: true,
  skipRecap: false,
  skipSourceSite: true,
  skipSourceAniskip: true,
  skipConfidence: 0.5,
  skipAutoDelaySec: 3,
  skipFallbackSec: 85,
  aiProfile: 'max_responsiveness',
  recRatingThreshold: 5,
  recExcludeKnown: true,
  recDiversity: true,
  recAnilist: false,
}

// ---------------------------------------------------------------------------
// РЕАЛЬНЫЕ действия аккаунта YummyAnime через постоянную сессию (EXE).
// Эндпоинты и тела проверены по собственному бандлу сайта (build.min.js v3.0.308):
//   PUT /anime/{id}/list {list} · DELETE /anime/{id}/list
//   PUT /anime/{id}/list/fav {date?} · DELETE /anime/{id}/list/fav
//   PUT /anime/{id}/rate {rate} · DELETE /anime/{id}/rate
// ---------------------------------------------------------------------------

/** Реестр статусов библиотеки сайта (массив Rt бандла — ТОЧНЫЕ имена) */
export const LIBRARY_STATUSES: Array<{ id: number; title: string; alias: string }> = [
  { id: 0, title: 'Смотрю', alias: 'watching' },
  { id: 1, title: 'В Планах', alias: 'planned' },
  { id: 2, title: 'Просмотрено', alias: 'completed' },
  { id: 3, title: 'Брошено', alias: 'dropped' },
  { id: 5, title: 'Отложено', alias: 'on_hold' },
]

export type YummyAnimeActionKind =
  | 'setList'
  | 'removeList'
  | 'setFavorite'
  | 'removeFavorite'
  | 'setRate'
  | 'removeRate'

/** Пользовательская отметка таймкода (Skip Segments P3) — строка из БД */
export interface SkipMarkRow {
  animeId: number
  dubbing: string | null
  type: string
  startSec: number | null
  endSec: number | null
  updatedAt: string
}

export interface YummyAnimeActionRequest {
  kind: YummyAnimeActionKind
  animeId: number
  /** list_id (0..5) для setList; 1..10 для setRate */
  value?: number
  /** slug страницы тайтла — нужен для reload-верификации по серверному HTML */
  slug?: string
}

/** Собственное состояние тайтла, прочитанное с серверного HTML страницы аниме */
export interface YummyAnimeOwnState {
  listId: number | null
  isFavorite: boolean
  rating: number | null
  /** страница отрисовалась для залогиненного (нет маркера гостя) */
  authenticatedPage: boolean | null
}

export interface YummyAnimeActionResponse {
  ok: boolean
  /** HTTP-статус действия на сайте (0 — сеть недоступна) */
  httpStatus: number
  /** 'pass' — состояние подтверждено чтением; 'mismatch' — не совпало; 'unconfirmed' — прочитать не удалось */
  verification: 'pass' | 'mismatch' | 'unconfirmed' | 'skipped'
  /** Состояние после действия (если удалось прочитать) */
  state: YummyAnimeOwnState | null
  message: string
}

// ---------------------------------------------------------------------------
// Вкладки (Browser layer)
// ---------------------------------------------------------------------------

export type TabKind =
  | 'home'
  | 'section'
  | 'search'
  | 'anime'
  | 'help'
  | 'recommendations'
  | 'companion'

/** Подразделы вкладки Anime Companion (payload.sub) */
export type CompanionSub =
  | 'overview'
  | 'compass'
  | 'chronicles'
  | 'taste'
  | 'quests'
  | 'characters'

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
