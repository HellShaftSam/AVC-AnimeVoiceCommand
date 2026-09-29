/**
 * Command Executor — исполняет VoiceCommand[] над состоянием приложения
 * (Browser + Player Control layers). CLI-agnostic: работает только со store
 * и REST API адаптера. Импортируется только из клиентского кода.
 *
 * Пайплайн executeText:
 *   RAW → [подтверждение озвучки «да/нет» — до парсинга] → normalize (parseCommand)
 *   → [анти-дубль < 2.5 c] → [LLM fallback] → выполнение по очереди
 *   → pipeline steps → история → lastExecuted → voiceMessage
 *
 * Task 9-a: SelectVoice через Voice Provider Resolver (с подтверждением при
 * сомнительной уверенности), Mute/Unmute, SetWatchStatus/ToggleFavorite/
 * ContinueWatching/ShowLibrary/AddVoiceAlias, автосинхронизация библиотеки.
 */
import { toast } from '@/hooks/use-toast'
import { rankMatches } from '@/lib/voice/fuzzy'
import { LABELS, parseCommand } from '@/lib/voice/parser'
import {
  buildUserAliasMap,
  DEFAULT_VOICE_ALIASES,
  DubCandidate,
  resolveVoiceProvider,
} from '@/lib/voice/provider-resolver'
import { avcApi } from './api'
import type { PutLibraryPayload } from './api'
import {
  AnimeCard,
  AnimeDetails,
  BrowserContext,
  CommandResult,
  LibraryEntryDto,
  SiteSectionId,
  TabKind,
  VideoEntry,
  VoiceCommand,
  VoiceCommandType,
  VOICE_CONFIDENCE_ASK,
  VOICE_CONFIDENCE_AUTO,
  VoiceProviderMatch,
  WATCH_STATUS_LABELS,
  WatchStatus,
} from './types'
import { makeTabSnapshot, useAvcStore } from './store'

// --- кэш деталей (модульный, переживает переключения вкладок) ------------------

const detailsCache = new Map<number, AnimeDetails>()

// --- анти-дубль команд (баг #12) ------------------------------------------------

/** Одна и та же команда подряд в пределах 2.5 с — пропускается */
const DEBOUNCE_MS = 2500
let lastCommand: { hash: string; ts: number } | null = null

/** Быстрая нормализация для фраз подтверждения (пунктуация → пробелы) */
function simpleNormalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Голосовое подтверждение предложенной озвучки */
const CONFIRM_YES = new Set([
  'да',
  'да переключай',
  'подтверждаю',
  'точно',
  'давай',
  'первый',
  'первая',
  'первое',
  '1',
])
const CONFIRM_NO = new Set([
  'нет',
  'отмена',
  'не',
  'неа',
  'неверно',
  'второй',
  'вторая',
  'второе',
  '2',
])

// --- служебные ----------------------------------------------------------------

const SECTION_LABELS: Record<SiteSectionId, string> = {
  home: 'Главная',
  catalog: 'Каталог',
  ongoing: 'Онгоинги',
  announcements: 'Анонсы',
  schedule: 'Расписание',
  top100: 'ТОП-100',
  random: 'Случайное',
}

function fail(message: string, error?: string): CommandResult {
  return { success: false, message, error }
}

function ok(message: string, data?: unknown): CommandResult {
  return { success: true, message, data }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

async function apiGetJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function step(stage: 'RAW' | 'NORMALIZED' | 'COMMAND' | 'PARAMS' | 'CONFIDENCE' | 'RESULT' | 'SOURCE', text: string): void {
  useAvcStore.getState().pushPipeline([{ stage, text, ts: Date.now() }])
}

function paramNumber(cmd: VoiceCommand, key: string): number | null {
  const v = cmd.params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function paramString(cmd: VoiceCommand, key: string): string {
  const v = cmd.params[key]
  return typeof v === 'string' ? v.trim() : ''
}

// --- детали аниме ---------------------------------------------------------------

export async function fetchDetails(idOrSlug: number | string): Promise<AnimeDetails | null> {
  if (typeof idOrSlug === 'number') {
    const cached = detailsCache.get(idOrSlug)
    if (cached) return cached
  }
  const data = await apiGetJson<AnimeDetails>(
    `/api/site/anime/${encodeURIComponent(String(idOrSlug))}`,
  )
  if (data) detailsCache.set(data.animeId, data)
  return data
}

export function getCachedDetails(
  animeId: number | null,
  slug: string | null,
): AnimeDetails | null {
  if (animeId !== null) {
    const c = detailsCache.get(animeId)
    if (c) return c
  }
  if (slug) {
    for (const d of detailsCache.values()) {
      if (d.slug === slug) return d
    }
  }
  return null
}

/** Максимальный номер серии, доступный в видео-матрице/деталях */
export function maxEpisodeOf(details: AnimeDetails): number {
  if (details.episodesAired > 0) return details.episodesAired
  let max = 0
  for (const v of details.videos) max = Math.max(max, v.episode)
  return max
}

function pickVideo(
  details: AnimeDetails,
  episode: number,
  preferDub: string | null,
): VideoEntry | null {
  const forEp = details.videos.filter((v) => v.episode === episode && !!v.iframeUrl)
  if (forEp.length === 0) return null
  if (preferDub) {
    const m = forEp.find((v) => v.dubName === preferDub)
    if (m) return m
  }
  return forEp[0]
}

/** Записать детали открытого аниме в playback (сброс серии/озвучки) */
function applyDetailsToPlayback(details: AnimeDetails | null, card?: AnimeCard): void {
  const st = useAvcStore.getState()
  const aired = details ? maxEpisodeOf(details) : 0
  st.patchPlayback({
    animeId: details?.animeId ?? card?.animeId ?? null,
    animeTitle: details?.title ?? card?.title ?? null,
    animeSlug: details?.slug ?? card?.slug ?? null,
    episodesAired: aired > 0 ? aired : null,
    episodesTotal: details?.episodesTotal ?? null,
    currentEpisode: null,
    currentDub: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
  })
  st.setPlayer(null, null)
}

// --- библиотека (аккаунт) -------------------------------------------------------

/** Заменить/добавить запись библиотеки в store */
function upsertLibraryEntry(entry: LibraryEntryDto): void {
  const st = useAvcStore.getState()
  const exists = st.library.some((e) => e.animeId === entry.animeId)
  st.setLibrary(
    exists
      ? st.library.map((e) => (e.animeId === entry.animeId ? entry : e))
      : [...st.library, entry],
  )
}

/**
 * Автосинхронизация прогресса просмотра после открытия серии (fire-and-forget:
 * не блокирует основной поток, ошибки глушатся). Статус 'watching' передаётся
 * только при СОЗДАНИИ записи — 'completed'/'dropped' не перетираются.
 */
function syncLibraryProgress(details: AnimeDetails | null): void {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!st.user || pb.animeId === null) return
  const existing = st.library.find((e) => e.animeId === pb.animeId) ?? null
  void avcApi
    .putLibrary({
      animeId: pb.animeId,
      title: pb.animeTitle ?? existing?.title ?? 'Без названия',
      slug: pb.animeSlug ?? existing?.slug ?? null,
      poster: details?.poster ?? existing?.poster ?? null,
      ...(existing ? {} : { status: 'watching' as WatchStatus }),
      episode: pb.currentEpisode ?? existing?.episode ?? null,
      totalEpisodes: details
        ? details.episodesTotal ??
          (details.episodesAired > 0 ? details.episodesAired : (existing?.totalEpisodes ?? null))
        : (existing?.totalEpisodes ?? null),
      currentDub: pb.currentDub ?? existing?.currentDub ?? null,
    })
    .then((entry) => {
      if (entry) upsertLibraryEntry(entry)
    })
    .catch(() => undefined)
}

type LibraryUpdateResult =
  | { ok: true; entry: LibraryEntryDto }
  | { ok: false; message: string }

/** putLibrary для ТЕКУЩЕГО открытого аниме (статус/избранное). Без user — открывает auth. */
async function updateLibraryForCurrentAnime(patch: {
  status?: WatchStatus
  favorite?: boolean
}): Promise<LibraryUpdateResult> {
  const st = useAvcStore.getState()
  if (!st.user) {
    st.setAuthOpen(true)
    return { ok: false, message: 'Войдите в аккаунт, чтобы вести библиотеку' }
  }
  const pb = st.playback
  if (pb.animeId === null) return { ok: false, message: 'Сначала откройте аниме' }
  const existing = st.library.find((e) => e.animeId === pb.animeId) ?? null
  const details = getCachedDetails(pb.animeId, pb.animeSlug)
  const payload: PutLibraryPayload = {
    animeId: pb.animeId,
    title: pb.animeTitle ?? existing?.title ?? 'Без названия',
    slug: pb.animeSlug ?? existing?.slug ?? null,
    poster: details?.poster ?? existing?.poster ?? null,
    episode: pb.currentEpisode ?? existing?.episode ?? null,
    totalEpisodes: details
      ? details.episodesTotal ?? (details.episodesAired > 0 ? details.episodesAired : null)
      : (existing?.totalEpisodes ?? null),
    currentDub: pb.currentDub ?? existing?.currentDub ?? null,
  }
  if (patch.status !== undefined) payload.status = patch.status
  else if (!existing) payload.status = 'watching' // новая запись — базовый статус
  if (patch.favorite !== undefined) payload.favorite = patch.favorite
  try {
    const entry = await avcApi.putLibrary(payload)
    if (!entry) {
      useAvcStore.getState().setAuthOpen(true)
      return { ok: false, message: 'Войдите в аккаунт, чтобы вести библиотеку' }
    }
    upsertLibraryEntry(entry)
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка библиотеки' }
  }
}

/** Синхронизация playback, если вкладка аниме открыта напрямую (сессия и т.п.) */
export function syncPlaybackToDetails(details: AnimeDetails): void {
  const st = useAvcStore.getState()
  if (st.playback.animeId === details.animeId) return
  applyDetailsToPlayback(details)
}

// --- открытие аниме / секций ---------------------------------------------------

async function navigateToAnime(
  card: AnimeCard,
  newTab: boolean,
  prefetched?: AnimeDetails | null,
): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const payload: Record<string, unknown> = { slug: card.slug, animeId: card.animeId }
  if (newTab || !st.activeTabId) {
    st.addTab({ kind: 'anime', title: card.title, payload })
  } else {
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    if (active) {
      st.pushBackStack(active.id, makeTabSnapshot(active))
      st.patchTab(active.id, { kind: 'anime', title: card.title, payload })
    } else {
      st.addTab({ kind: 'anime', title: card.title, payload })
    }
  }
  const details = prefetched ?? (await fetchDetails(card.animeId))
  applyDetailsToPlayback(details, card)
  toast({ description: `Открыто: ${card.title}` })
  return ok(`Открыто: ${card.title}`, details)
}

/** Открыть карточку аниме из сетки (клик мышью) — в новой вкладке */
export async function openAnimeCard(card: AnimeCard, newTab = true): Promise<CommandResult> {
  return navigateToAnime(card, newTab)
}

function openSectionTab(sectionId: SiteSectionId): CommandResult {
  const st = useAvcStore.getState()
  if (sectionId === 'home') {
    st.addTab({ kind: 'home', title: SECTION_LABELS.home, payload: {} })
  } else {
    st.addTab({
      kind: 'section',
      title: SECTION_LABELS[sectionId],
      payload: { section: sectionId, page: 1 },
    })
  }
  return ok(`Открыто: ${SECTION_LABELS[sectionId]}`)
}

const SECTION_COMMAND: Partial<Record<SiteSectionId, VoiceCommandType>> = {
  catalog: VoiceCommandType.OpenCatalog,
  ongoing: VoiceCommandType.OpenOngoing,
  announcements: VoiceCommandType.OpenAnnouncements,
  schedule: VoiceCommandType.OpenSchedule,
  top100: VoiceCommandType.OpenTop100,
}

/** Хелпер для UI-кнопок: открыть секцию как голосовая команда */
export function openSection(sectionId: SiteSectionId): Promise<CommandResult> {
  const type =
    sectionId === 'home'
      ? VoiceCommandType.OpenHome
      : sectionId === 'random'
        ? VoiceCommandType.OpenRandom
        : SECTION_COMMAND[sectionId]
  if (!type) return Promise.resolve(fail(`Неизвестная секция: ${sectionId}`))
  return executeCommand({
    type,
    params: {},
    confidence: 1,
    label: SECTION_LABELS[sectionId],
  })
}

// --- серии / плеер ----------------------------------------------------------------

async function playEpisode(episode: number): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(pb.animeId)
  if (!details) return fail('Не удалось загрузить данные аниме')
  const max = maxEpisodeOf(details)
  if (!Number.isFinite(episode) || episode < 1 || (max > 0 && episode > max)) {
    return fail(`Серия ${episode} не найдена`)
  }
  const video = pickVideo(details, episode, pb.currentDub)
  if (!video) return fail(`Серия ${episode} не найдена`)
  st.patchPlayback({
    currentEpisode: episode,
    isPlaying: true,
    currentTime: 0,
    duration: video.duration ?? 0,
    currentDub: pb.currentDub ?? video.dubName,
  })
  st.setPlayer(video.iframeUrl, video.playerName)
  syncLibraryProgress(details)
  toast({ description: `▶ Серия ${episode}` })
  return ok(`Серия ${episode}`)
}

// --- основной switch ------------------------------------------------------------

async function executeOpenRandom(): Promise<CommandResult> {
  const details = await apiGetJson<AnimeDetails>('/api/site/random')
  if (!details) return fail('Не удалось получить случайное аниме')
  return navigateToAnime(details, false, details)
}

async function executeSearchAnime(cmd: VoiceCommand): Promise<CommandResult> {
  const query = paramString(cmd, 'query')
  if (!query) return fail('Пустой поисковый запрос')
  const open = cmd.params.open === true
  const newTab = cmd.params.newTab === true
  const data = await apiGetJson<{ items: AnimeCard[] }>(
    `/api/site/search?q=${encodeURIComponent(query)}`,
  )
  const items = data?.items ?? []
  if (items.length === 0) return fail(`Ничего не найдено по запросу «${query}»`)

  const ranked = rankMatches(query, items, (i) => i.title)
  const bestScore = ranked.length > 0 ? ranked[0].score : 0
  if ((open || items.length === 1) && bestScore >= 0.55) {
    const best = ranked[0].item
    return navigateToAnime(best, newTab)
  }
  const candidates = (ranked.length > 0 ? ranked.map((r) => r.item) : items).slice(0, 6)
  useAvcStore.getState().setPendingOptions({ query, items: candidates })
  return ok('Найдено несколько вариантов. Скажите номер.', candidates)
}

async function executeSelectOption(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const opts = st.pendingOptions
  if (!opts) return fail('Нет вариантов для выбора — сначала выполните поиск')
  const index = paramNumber(cmd, 'index')
  if (index === null) return fail('Не указан номер варианта')
  const item = opts.items[index - 1]
  if (!item) {
    return fail(`Вариант ${index} не найден. Доступно вариантов: ${opts.items.length}`)
  }
  st.setPendingOptions(null)
  return navigateToAnime(item, false)
}

/** Применить выбранную озвучку: запомнить и, если серия открыта, перезапустить плеер */
function applyDubChoice(details: AnimeDetails, dubName: string): void {
  const st = useAvcStore.getState()
  st.patchPlayback({ currentDub: dubName })
  const ep = st.playback.currentEpisode
  if (ep !== null) {
    const video = pickVideo(details, ep, dubName)
    if (video) st.setPlayer(video.iframeUrl, video.playerName)
  }
}

async function executeSelectVoice(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  if (!st.playback.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(st.playback.animeId)
  if (!details) return fail('Не удалось загрузить данные аниме')
  const dubs = details.dubs
  if (dubs.length === 0) return fail('Для этого аниме нет доступных озвучек')

  // {next: true} — циклически следующая озвучка
  if (cmd.params.next === true) {
    const curIdx = dubs.findIndex((d) => d.name === st.playback.currentDub)
    const next = dubs[(curIdx + 1) % dubs.length]
    applyDubChoice(details, next.name)
    return ok(`Озвучка: ${next.name}`)
  }

  // {index: N} — N-я озвучка в списке
  const idx = paramNumber(cmd, 'index')
  if (idx !== null) {
    if (idx < 1 || idx > dubs.length) {
      return fail(`Озвучка №${idx} не найдена. Доступно озвучек: ${dubs.length}`)
    }
    const chosen = dubs[idx - 1]
    applyDubChoice(details, chosen.name)
    return ok(`Озвучка: ${chosen.name}`)
  }

  // {name} — резолвинг через Voice Provider Resolver (Task 8-b)
  const spoken = paramString(cmd, 'name') || paramString(cmd, 'dub')
  if (!spoken) return fail('Не указана озвучка')
  const aliasMap = buildUserAliasMap(
    useAvcStore.getState().voiceAliases.map((r) => ({
      targetName: r.targetName,
      alias: r.alias,
    })),
  )
  const match = resolveVoiceProvider(
    spoken,
    dubs.map((d) => ({ name: d.name, shortName: d.shortName })),
    aliasMap,
    VOICE_CONFIDENCE_ASK,
  )
  if (!match) {
    const available = dubs.map((d) => d.shortName).slice(0, 6).join(', ')
    return fail(`Озвучка «${spoken}» не найдена. Доступны: ${available}`)
  }
  if (match.confidence >= VOICE_CONFIDENCE_AUTO) {
    // уверенное совпадение — переключаем молча
    applyDubChoice(details, match.name)
    return ok(`Озвучка: ${match.name} (${Math.round(match.confidence * 100)}%)`)
  }
  // 0.55..0.85 — спрашиваем подтверждение (диалог + голос «да/нет»)
  useAvcStore.getState().setVoiceConfirm({ spoken, match })
  return ok(`Вы имеете в виду «${match.name}»? Скажите ДА или НЕТ`)
}

// --- подтверждение озвучки (голос «да/нет» / диалог) ------------------------------

/** Пользователь подтвердил предложенную озвучку (диалог/голос «да») */
export function confirmVoiceMatch(): void {
  const st = useAvcStore.getState()
  const vc = st.voiceConfirm
  if (!vc) return
  st.setVoiceConfirm(null)
  void (async () => {
    try {
      const animeId = useAvcStore.getState().playback.animeId
      const details = animeId !== null ? await fetchDetails(animeId) : null
      if (!details) {
        useAvcStore.getState().setVoiceMessage('Не удалось применить озвучку')
        toast({ variant: 'destructive', description: 'Не удалось применить озвучку' })
        return
      }
      applyDubChoice(details, vc.match.name)
      const msg = `Озвучка: ${vc.match.name} (${Math.round(vc.match.confidence * 100)}%)`
      useAvcStore.getState().setVoiceMessage(msg)
      toast({ description: msg })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось применить озвучку' })
    }
  })()
}

/** Пользователь отклонил предложенную озвучку (диалог/голос «нет») */
export function cancelVoiceMatch(): void {
  const st = useAvcStore.getState()
  if (!st.voiceConfirm) return
  st.setVoiceConfirm(null)
  st.setVoiceMessage('Отменено')
}

// --- аккаунт: статус просмотра / избранное / продолжить / библиотека / алиасы ------

const WATCH_STATUSES: readonly WatchStatus[] = [
  'watching',
  'planned',
  'completed',
  'dropped',
  'on_hold',
]

async function executeSetWatchStatus(cmd: VoiceCommand): Promise<CommandResult> {
  const statusRaw = paramString(cmd, 'status')
  if (!(WATCH_STATUSES as readonly string[]).includes(statusRaw)) {
    return fail(`Неизвестный статус просмотра: ${statusRaw || '—'}`)
  }
  const status = statusRaw as WatchStatus
  const res = await updateLibraryForCurrentAnime({ status })
  if (!res.ok) return fail(res.message)
  const title = useAvcStore.getState().playback.animeTitle ?? res.entry.title
  return ok(`${title}: ${WATCH_STATUS_LABELS[status]}`)
}

async function executeToggleFavorite(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const existing =
    st.playback.animeId !== null
      ? (st.library.find((e) => e.animeId === st.playback.animeId) ?? null)
      : null
  // favorite приходит от парсера; без параметра — честный toggle текущего состояния
  const favorite =
    cmd.params.favorite === true
      ? true
      : cmd.params.favorite === false
        ? false
        : !(existing?.favorite ?? false)
  const res = await updateLibraryForCurrentAnime({ favorite })
  if (!res.ok) return fail(res.message)
  const title = useAvcStore.getState().playback.animeTitle ?? res.entry.title
  return ok(favorite ? `Добавлено в избранное: ${title}` : `Убрано из избранного: ${title}`)
}

/**
 * Продолжить просмотр из записи библиотеки: открыть аниме, восстановить
 * озвучку и серию (и позицию, если сохранена). Экспортируется для UI
 * (кнопка «Продолжить» в LibraryPanel).
 */
export async function continueWatchingFromEntry(entry: LibraryEntryDto): Promise<void> {
  const card: AnimeCard = {
    animeId: entry.animeId,
    slug: entry.slug ?? '',
    title: entry.title,
    poster: entry.poster,
    year: null,
    rating: null,
    status: null,
    type: null,
  }
  await navigateToAnime(card, false)
  const st = useAvcStore.getState()
  if (entry.currentDub) st.patchPlayback({ currentDub: entry.currentDub })
  if (entry.episode !== null && entry.episode > 0) {
    const res = await playEpisode(entry.episode)
    if (!res.success) {
      toast({ variant: 'destructive', description: res.message })
      return
    }
    if (entry.positionSec !== null && entry.positionSec > 0) {
      useAvcStore.getState().patchPlayback({ currentTime: entry.positionSec })
    }
  }
}

async function executeContinueWatching(): Promise<CommandResult> {
  const st = useAvcStore.getState()
  if (st.library.length === 0) {
    return fail('Библиотека пуста — скажи «найди ...» чтобы начать')
  }
  // свежая запись среди «смотрю», иначе — любая свежая
  const watching = st.library.filter((e) => e.status === 'watching')
  const pool = watching.length > 0 ? watching : st.library
  const latest = pool.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
  try {
    await continueWatchingFromEntry(latest)
  } catch (e) {
    return fail('Не удалось продолжить просмотр', e instanceof Error ? e.message : String(e))
  }
  return ok(`Продолжаю: ${latest.title}${latest.episode ? `, серия ${latest.episode}` : ''}`)
}

async function executeAddVoiceAlias(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const alias = paramString(cmd, 'alias')
  const target = paramString(cmd, 'target')
  if (!alias || !target) return fail('Укажите алиас и название озвучки')

  const aliasMap = buildUserAliasMap(
    st.voiceAliases.map((r) => ({ targetName: r.targetName, alias: r.alias })),
  )

  // 1) резолвим target по озвучкам текущего аниме (если открыто)
  let match: VoiceProviderMatch | null = null
  if (st.playback.animeId !== null) {
    const details = await fetchDetails(st.playback.animeId)
    if (details && details.dubs.length > 0) {
      match = resolveVoiceProvider(
        target,
        details.dubs.map((d) => ({ name: d.name, shortName: d.shortName })),
        aliasMap,
        VOICE_CONFIDENCE_ASK,
      )
    }
  }
  // 2) fallback — встроенный словарь известных озвучек
  if (!match) {
    const defaults: DubCandidate[] = Object.keys(DEFAULT_VOICE_ALIASES).map((k) => ({
      name: k,
      shortName: k,
    }))
    match = resolveVoiceProvider(target, defaults, aliasMap, VOICE_CONFIDENCE_ASK)
  }
  if (!match) return fail(`Не знаю такую озвучку: «${target}»`)

  try {
    const row = await avcApi.addAlias(match.name, alias, 'voice')
    if (!row) {
      useAvcStore.getState().setAuthOpen(true)
      return fail('Войдите, чтобы сохранять алиасы')
    }
    const cur = useAvcStore.getState().voiceAliases
    useAvcStore
      .getState()
      .setVoiceAliases(
        cur.some((r) => r.id === row.id)
          ? cur.map((r) => (r.id === row.id ? row : r))
          : [row, ...cur],
      )
    return ok(`Запомнил: «${alias}» → ${match.name}`)
  } catch (e) {
    return fail('Не удалось сохранить алиас', e instanceof Error ? e.message : String(e))
  }
}

async function executeEpisodeCommand(cmd: VoiceCommand): Promise<CommandResult> {
  const episode = paramNumber(cmd, 'episode')
  if (episode === null) return fail('Не указан номер серии')
  return playEpisode(episode)
}

async function executeNextPrevEpisode(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(pb.animeId)
  const max = details ? maxEpisodeOf(details) : pb.episodesAired ?? 0
  const current = pb.currentEpisode
  if (cmd.type === VoiceCommandType.NextEpisode) {
    if (current === null || current === 0) return playEpisode(1)
    if (max > 0 && current >= max) return fail(`Это последняя серия (${max})`)
    return playEpisode(current + 1)
  }
  if (current === null || current <= 1) return fail('Это первая серия')
  return playEpisode(current - 1)
}

function executePlayPause(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  const wantPlay =
    cmd.type === VoiceCommandType.Play ||
    (cmd.type === VoiceCommandType.TogglePlayPause && !pb.isPlaying)
  if (wantPlay) {
    if (!pb.currentEpisode && pb.animeId) return playEpisode(1)
    st.patchPlayback({ isPlaying: true })
    return Promise.resolve(ok('Воспроизведение'))
  }
  st.patchPlayback({ isPlaying: false })
  return Promise.resolve(ok('Пауза'))
}

function executeSeek(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  const seconds = paramNumber(cmd, 'seconds') ?? st.settings.seekStep
  const delta = cmd.type === VoiceCommandType.SeekBackward ? -Math.abs(seconds) : Math.abs(seconds)
  const max = pb.duration > 0 ? pb.duration : Number.POSITIVE_INFINITY
  const next = clamp(pb.currentTime + delta, 0, max)
  st.patchPlayback({ currentTime: next })
  // позиция синхронизируется в библиотеку (fire-and-forget, только если запись есть)
  if (st.user && pb.animeId !== null) {
    const existing = st.library.find((e) => e.animeId === pb.animeId)
    if (existing) {
      void avcApi
        .putLibrary({ animeId: pb.animeId, title: existing.title, positionSec: Math.round(next) })
        .then((entry) => {
          if (entry) upsertLibraryEntry(entry)
        })
        .catch(() => undefined)
    }
  }
  return ok(`${delta > 0 ? 'Вперёд' : 'Назад'} на ${Math.abs(seconds)} с`)
}

function executeMuteUnmute(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (cmd.type === VoiceCommandType.Mute) {
    // запоминаем громкость для восстановления (0 не затирает прежнее значение)
    st.setPrevVolume(pb.volume > 0 ? pb.volume : st.prevVolume)
    st.patchPlayback({ volume: 0 })
    return ok('Звук выключен')
  }
  const v = st.prevVolume > 0 ? st.prevVolume : 70
  st.patchPlayback({ volume: v })
  return ok(`Громкость ${v}%`)
}

function executeVolume(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  let volume: number
  if (cmd.type === VoiceCommandType.SetVolume) {
    const v = paramNumber(cmd, 'volume')
    if (v === null) return fail('Не указана громкость')
    volume = clamp(v, 0, 100)
  } else {
    const delta = cmd.type === VoiceCommandType.VolumeUp ? st.settings.volumeStep : -st.settings.volumeStep
    volume = clamp(pb.volume + delta, 0, 100)
  }
  st.patchPlayback({ volume })
  return ok(`Громкость ${volume}%`)
}

function executeTabCommand(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  switch (cmd.type) {
    case VoiceCommandType.OpenNewTab: {
      st.addTab({ kind: 'home', title: 'Главная', payload: {} })
      return ok('Открыта новая вкладка')
    }
    case VoiceCommandType.CloseTab: {
      const target = st.activeTabId ?? st.tabs[st.tabs.length - 1]?.id
      if (!target) return fail('Нет вкладок')
      const wasLast = st.tabs.length <= 1
      st.closeTab(target)
      return ok(wasLast ? 'Вкладка закрыта. Открыта главная' : 'Вкладка закрыта')
    }
    case VoiceCommandType.NextTab:
    case VoiceCommandType.PreviousTab: {
      if (st.tabs.length === 0) return fail('Нет вкладок')
      const idx = st.tabs.findIndex((t) => t.id === st.activeTabId)
      const cur = idx >= 0 ? idx : 0
      const dir = cmd.type === VoiceCommandType.NextTab ? 1 : -1
      const next = st.tabs[(cur + dir + st.tabs.length) % st.tabs.length]
      st.setActiveTab(next.id)
      return ok(`Вкладка: ${next.title}`)
    }
    case VoiceCommandType.SelectTab: {
      const n = paramNumber(cmd, 'index')
      if (n === null) return fail('Не указан номер вкладки')
      const tab = st.tabs[n - 1]
      if (!tab) return fail(`Вкладка ${n} не найдена. Открыто вкладок: ${st.tabs.length}`)
      st.setActiveTab(tab.id)
      return ok(`Вкладка: ${tab.title}`)
    }
    default:
      return fail('Неизвестная команда вкладок')
  }
}

function executeBack(): CommandResult {
  const st = useAvcStore.getState()
  const id = st.activeTabId
  if (!id) return fail('Нет активной вкладки')
  const entry = st.popBackStack(id)
  if (!entry) return fail('История вкладки пуста')
  const snap = entry as {
    kind?: TabKind
    title?: string
    payload?: Record<string, unknown>
  }
  st.patchTab(id, {
    kind: snap.kind ?? 'home',
    title: snap.title ?? 'Главная',
    payload: snap.payload ?? {},
  })
  return ok('Назад')
}

function executeScroll(cmd: VoiceCommand): CommandResult {
  const el = document.getElementById('avc-content')
  if (!el) return fail('Контейнер контента недоступен')
  const dir = cmd.type === VoiceCommandType.ScrollDown ? 1 : -1
  el.scrollBy({ top: dir * 600, behavior: 'smooth' })
  return ok(dir > 0 ? 'Прокрутка вниз' : 'Прокрутка вверх')
}

/** Выполнить одну команду. Экспортируется для UI-кнопок (дабы дублировать логику). */
export async function executeCommand(cmd: VoiceCommand): Promise<CommandResult> {
  switch (cmd.type) {
    case VoiceCommandType.OpenHome:
    case VoiceCommandType.OpenCatalog:
    case VoiceCommandType.OpenTop100:
    case VoiceCommandType.OpenOngoing:
    case VoiceCommandType.OpenAnnouncements:
    case VoiceCommandType.OpenSchedule: {
      const reverse: Partial<Record<VoiceCommandType, SiteSectionId>> = {
        [VoiceCommandType.OpenHome]: 'home',
        [VoiceCommandType.OpenCatalog]: 'catalog',
        [VoiceCommandType.OpenTop100]: 'top100',
        [VoiceCommandType.OpenOngoing]: 'ongoing',
        [VoiceCommandType.OpenAnnouncements]: 'announcements',
        [VoiceCommandType.OpenSchedule]: 'schedule',
      }
      const section = reverse[cmd.type]
      return section ? openSectionTab(section) : fail('Неизвестная секция')
    }
    case VoiceCommandType.OpenRandom:
      return executeOpenRandom()
    case VoiceCommandType.SearchAnime:
    case VoiceCommandType.OpenAnime:
      return executeSearchAnime({ ...cmd, params: cmd.type === VoiceCommandType.OpenAnime ? { ...cmd.params, open: true } : cmd.params })
    case VoiceCommandType.SelectOption:
      return executeSelectOption(cmd)
    case VoiceCommandType.SelectEpisode:
      return executeEpisodeCommand(cmd)
    case VoiceCommandType.NextEpisode:
    case VoiceCommandType.PreviousEpisode:
      return executeNextPrevEpisode(cmd)
    case VoiceCommandType.Play:
    case VoiceCommandType.Pause:
    case VoiceCommandType.TogglePlayPause:
      return executePlayPause(cmd)
    case VoiceCommandType.SeekForward:
    case VoiceCommandType.SeekBackward:
      return executeSeek(cmd)
    case VoiceCommandType.VolumeUp:
    case VoiceCommandType.VolumeDown:
    case VoiceCommandType.SetVolume:
      return executeVolume(cmd)
    case VoiceCommandType.Fullscreen:
      useAvcStore.getState().setPlayerFullscreen(true)
      return ok('Полный экран')
    case VoiceCommandType.ExitFullscreen:
      useAvcStore.getState().setPlayerFullscreen(false)
      return ok('Выход из полного экрана')
    case VoiceCommandType.ToggleFullscreen: {
      const cur = useAvcStore.getState().playerFullscreen
      useAvcStore.getState().setPlayerFullscreen(!cur)
      return ok(cur ? 'Выход из полного экрана' : 'Полный экран')
    }
    case VoiceCommandType.OpenNewTab:
    case VoiceCommandType.CloseTab:
    case VoiceCommandType.NextTab:
    case VoiceCommandType.PreviousTab:
    case VoiceCommandType.SelectTab:
      return executeTabCommand(cmd)
    case VoiceCommandType.Reload: {
      const st = useAvcStore.getState()
      if (!st.activeTabId) return fail('Нет активной вкладки')
      st.bumpReload(st.activeTabId)
      return ok('Обновляю страницу')
    }
    case VoiceCommandType.Back:
      return executeBack()
    case VoiceCommandType.Forward:
      return ok('Нет данных для перехода вперёд')
    case VoiceCommandType.ScrollUp:
    case VoiceCommandType.ScrollDown:
      return executeScroll(cmd)
    case VoiceCommandType.SelectVoice:
      return executeSelectVoice(cmd)
    case VoiceCommandType.ShowEpisodes:
      useAvcStore.getState().setEpisodesPanelOpen(true)
      return ok('Показываю серии')
    case VoiceCommandType.ShowHelp:
      useAvcStore.getState().setHelpOpen(true)
      return ok('Открываю справку')
    case VoiceCommandType.Mute:
    case VoiceCommandType.Unmute:
      return executeMuteUnmute(cmd)
    case VoiceCommandType.SetWatchStatus:
      return executeSetWatchStatus(cmd)
    case VoiceCommandType.ToggleFavorite:
      return executeToggleFavorite(cmd)
    case VoiceCommandType.ContinueWatching:
      return executeContinueWatching()
    case VoiceCommandType.ShowLibrary: {
      useAvcStore.getState().setLibraryOpen(true)
      return ok('Библиотека открыта')
    }
    case VoiceCommandType.AddVoiceAlias:
      return executeAddVoiceAlias(cmd)
    case VoiceCommandType.Unknown:
      return fail('Команда не распознана')
    default:
      return fail('Команда не поддерживается')
  }
}

// --- интерпретация LLM (fallback) --------------------------------------------------

async function llmInterpret(raw: string, context: BrowserContext): Promise<VoiceCommand[] | null> {
  try {
    const res = await fetch('/api/voice/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw, context }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { commands?: VoiceCommand[] | null }
    return data.commands && data.commands.length > 0 ? data.commands : null
  } catch {
    return null
  }
}

// --- executeText ------------------------------------------------------------------

export interface ExecuteTextResult {
  raw: string
  normalized: string
  commands: VoiceCommand[]
  results: CommandResult[]
}

export function getBrowserContext(): BrowserContext {
  const s = useAvcStore.getState()
  return { navigation: s.navigation, playback: s.playback }
}

export async function executeText(
  raw: string,
  source: 'voice' | 'text',
): Promise<ExecuteTextResult> {
  const initial = useAvcStore.getState()
  initial.resetPipeline()
  step('RAW', raw)

  // --- подтверждение озвучки ДО парсинга: «...анилибрию?» → «да» ---------------
  const vc = useAvcStore.getState().voiceConfirm
  if (vc) {
    const t = simpleNormalize(raw)
    const isYes = CONFIRM_YES.has(t)
    const isNo = CONFIRM_NO.has(t)
    if (isYes || isNo) {
      const result = isYes
        ? ok(`Озвучка: ${vc.match.name} (${Math.round(vc.match.confidence * 100)}%)`)
        : ok('Отменено')
      step('RESULT', `✓ ${result.message}`)
      if (isYes) confirmVoiceMatch()
      else cancelVoiceMatch()
      const st = useAvcStore.getState()
      st.setLastExecuted({ raw, result })
      st.setVoiceMessage(result.message)
      return { raw, normalized: raw, commands: [], results: [result] }
    }
    // любой другой текст: снимаем подтверждение и продолжаем обычный парсинг,
    // чтобы диалог не «застревал» (исправление можно произнести сразу)
    cancelVoiceMatch()
    step('RESULT', '✓ Подтверждение отменено — выполняю команду')
  }

  const context = getBrowserContext()
  const parsed = parseCommand(raw, context)
  step('NORMALIZED', parsed.normalized || raw)

  // --- анти-дубль: та же команда подряд в пределах 2.5 с — пропустить (баг #12) ---
  const hash = (parsed.normalized || raw).trim().toLowerCase()
  const now = Date.now()
  if (lastCommand && lastCommand.hash === hash && now - lastCommand.ts < DEBOUNCE_MS) {
    const skip = ok('Дубликат команды пропущен')
    step('RESULT', '✓ Дубликат команды пропущен')
    const st = useAvcStore.getState()
    st.setLastExecuted({ raw, result: skip })
    st.setVoiceMessage(skip.message)
    return { raw, normalized: parsed.normalized, commands: [], results: [skip] }
  }

  let commands = parsed.commands
  let usedLlm = false

  const threshold = initial.settings.confidenceThreshold
  const needsLlm = parsed.failed || (commands.length > 0 && parsed.confidence < threshold)
  if (needsLlm && initial.settings.llmFallback) {
    const llm = await llmInterpret(raw, context)
    if (llm) {
      commands = llm
      usedLlm = true
      step('SOURCE', 'LLM fallback')
    }
  }

  const results: CommandResult[] = []

  if (commands.length === 0) {
    const r = fail('Не удалось распознать команду')
    results.push(r)
    step('RESULT', `✗ ${r.message}`)
  } else {
    for (const cmd of commands) {
      const label = cmd.label || LABELS[cmd.type] || cmd.type
      step('COMMAND', usedLlm ? `${label} (LLM)` : label)
      step('PARAMS', JSON.stringify(cmd.params))
      step('CONFIDENCE', `${Math.round(cmd.confidence * 100)}%`)
      let result: CommandResult
      try {
        result = await executeCommand(cmd)
      } catch (e) {
        result = fail('Ошибка выполнения команды', e instanceof Error ? e.message : String(e))
      }
      results.push(result)
      step('RESULT', `${result.success ? '✓' : '✗'} ${result.message}`)

      const st = useAvcStore.getState()
      if (st.settings.saveHistory) {
        void fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw,
            normalized: parsed.normalized,
            command: cmd.type,
            params: cmd.params,
            confidence: cmd.confidence,
            success: result.success,
            message: result.message,
            source: usedLlm ? 'llm' : source,
          }),
        })
          .then(() => useAvcStore.getState().bumpHistoryVersion())
          .catch(() => undefined)
      }
    }
  }

  // Успешные И проваленные команды обновляют ts: «пауза пауза» подряд — дубль,
  // но с интервалом больше DEBOUNCE_MS та же команда выполняется снова
  lastCommand = { hash, ts: Date.now() }

  const final = results[results.length - 1]
  if (!final.success) {
    toast({ variant: 'destructive', description: final.message })
  }

  const st = useAvcStore.getState()
  st.setLastExecuted({ raw, result: final })
  st.setVoiceMessage(final.message)

  return { raw, normalized: parsed.normalized, commands, results }
}
