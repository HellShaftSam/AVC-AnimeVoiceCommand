/**
 * VoiceCommandParser — ЛОКАЛЬНЫЙ, ДЕТЕРМИНИРОВАННЫЙ парсер русских команд
 * (мастер-промпт #83, #109). Без AI API: быстрый, локальный, предсказуемый.
 *
 * Пайплайн: RAW → normalize → stripFillers → сегментация ("и") →
 *           alias matching / извлечение параметров → VoiceCommand[]
 */
import { BrowserContext, VoiceCommand, VoiceCommandType } from '@/lib/avc/types'
import { COMMAND_ALIASES, OPEN_TRIGGERS, SEARCH_TRIGGERS } from './aliases'
import { normalizeCommandText, stripFillers } from './normalizer'
import { consumeLeadingNumber } from './russian-numbers'

interface ParseCtx {
  navigation: BrowserContext['navigation']
  playback: BrowserContext['playback']
}

// --- вспомогательные -------------------------------------------------------

const EPISODE_NOUNS = ['серию', 'серия', 'серии', 'серую', 'эпизод', 'эпизода', 'эпизоде']
const SECTION_WORDS: Record<string, VoiceCommandType> = {
  'главн': VoiceCommandType.OpenHome,
  'каталог': VoiceCommandType.OpenCatalog,
  'топ': VoiceCommandType.OpenTop100,
  'онгоинг': VoiceCommandType.OpenOngoing,
  'анонс': VoiceCommandType.OpenAnnouncements,
  'расписан': VoiceCommandType.OpenSchedule,
  'случайн': VoiceCommandType.OpenRandom,
  'рандом': VoiceCommandType.OpenRandom,
}

function hasEpisodeNoun(words: string[]): boolean {
  return words.some((w) => EPISODE_NOUNS.some((n) => w.startsWith(n.slice(0, 5))))
}

function isSectionWord(word: string): boolean {
  return Object.keys(SECTION_WORDS).some((s) => word.startsWith(s))
}

function sectionCommandFor(word: string): VoiceCommandType | null {
  for (const [prefix, cmd] of Object.entries(SECTION_WORDS)) {
    if (word.startsWith(prefix)) return cmd
  }
  return null
}

/** Точное/частичное совпадение с алиасами команд без параметров */
function matchAlias(full: string): VoiceCommand | null {
  let best: { cmd: VoiceCommandType; score: number } | null = null
  for (const [typeKey, aliases] of Object.entries(COMMAND_ALIASES)) {
    for (const alias of aliases) {
      const aliasLen = alias.split(' ').length
      let score = 0
      if (full === alias) score = 1
      else if (aliasLen >= 2 && full.includes(alias)) score = 0.8
      // односложные алиасы-глаголы ("включи") — только точное совпадение,
      // иначе "включи берсерка" стало бы Play
      if (score > 0 && (!best || score > best.score)) {
        best = { cmd: typeKey as VoiceCommandType, score }
      }
    }
  }
  if (!best) return null
  const type = best.cmd
  return {
    type,
    params: {},
    confidence: Math.min(0.98, 0.72 + best.score * 0.26),
    label: LABELS[type] ?? type,
  }
}

export const LABELS: Record<VoiceCommandType, string> = {
  [VoiceCommandType.OpenHome]: 'Открыть главную',
  [VoiceCommandType.OpenCatalog]: 'Открыть каталог',
  [VoiceCommandType.OpenTop100]: 'Открыть ТОП-100',
  [VoiceCommandType.OpenOngoing]: 'Открыть онгоинги',
  [VoiceCommandType.OpenAnnouncements]: 'Открыть анонсы',
  [VoiceCommandType.OpenSchedule]: 'Открыть расписание',
  [VoiceCommandType.OpenRandom]: 'Случайное аниме',
  [VoiceCommandType.SearchAnime]: 'Поиск аниме',
  [VoiceCommandType.OpenAnime]: 'Открыть аниме',
  [VoiceCommandType.SelectEpisode]: 'Выбрать серию',
  [VoiceCommandType.NextEpisode]: 'Следующая серия',
  [VoiceCommandType.PreviousEpisode]: 'Предыдущая серия',
  [VoiceCommandType.Play]: 'Воспроизведение',
  [VoiceCommandType.Pause]: 'Пауза',
  [VoiceCommandType.TogglePlayPause]: 'Play/Pause',
  [VoiceCommandType.SeekForward]: 'Перемотка вперёд',
  [VoiceCommandType.SeekBackward]: 'Перемотка назад',
  [VoiceCommandType.VolumeUp]: 'Громче',
  [VoiceCommandType.VolumeDown]: 'Тише',
  [VoiceCommandType.SetVolume]: 'Установить громкость',
  [VoiceCommandType.Fullscreen]: 'Полный экран',
  [VoiceCommandType.ExitFullscreen]: 'Выйти из полного экрана',
  [VoiceCommandType.ToggleFullscreen]: 'Полный экран (переключить)',
  [VoiceCommandType.OpenNewTab]: 'Новая вкладка',
  [VoiceCommandType.CloseTab]: 'Закрыть вкладку',
  [VoiceCommandType.NextTab]: 'Следующая вкладка',
  [VoiceCommandType.PreviousTab]: 'Предыдущая вкладка',
  [VoiceCommandType.SelectTab]: 'Выбрать вкладку',
  [VoiceCommandType.Reload]: 'Обновить',
  [VoiceCommandType.Back]: 'Назад',
  [VoiceCommandType.Forward]: 'Вперёд',
  [VoiceCommandType.ScrollUp]: 'Прокрутить вверх',
  [VoiceCommandType.ScrollDown]: 'Прокрутить вниз',
  [VoiceCommandType.SelectVoice]: 'Выбрать озвучку',
  [VoiceCommandType.ShowEpisodes]: 'Показать серии',
  [VoiceCommandType.ShowHelp]: 'Помощь',
  [VoiceCommandType.SelectOption]: 'Выбор варианта',
  [VoiceCommandType.Unknown]: 'Не распознано',
}

// --- извлечение отдельных команд -------------------------------------------

const NUM_WORDS_RE = /^(один|одну|две|два|три|четыре|пять|шесть|семь|восемь|девять|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|девяносто|сто|\d{1,3})$/
const SEEK_NOUN_RE = /^(секунд|сек|секунды|секунду|секундочку|секундку)/

function extractSeek(words: string[]): VoiceCommand | null {
  const isBackward = words.includes('назад')
  const isForward = words.includes('вперед') || (words.includes('перемотай') && !isBackward)
  if (!isForward && !isBackward) return null

  const hasSecondsWord = words.some((w) => SEEK_NOUN_RE.test(w))
  // "перемотай вперед/назад" без секунд — тоже валидно (шаг из настроек)
  const bareRewind = words.includes('перемотай')
  if (!hasSecondsWord && !bareRewind) return null

  // ищем число прямо перед словом "секунд*"
  let seconds: number | null = null
  for (let i = 1; i < words.length; i++) {
    if (SEEK_NOUN_RE.test(words[i]) && NUM_WORDS_RE.test(words[i - 1])) {
      const c = consumeLeadingNumber([words[i - 1]])
      if (c) seconds = c.value
    }
  }
  // seconds === null -> будет использован шаг из настроек (executor)
  return {
    type: isBackward ? VoiceCommandType.SeekBackward : VoiceCommandType.SeekForward,
    params: seconds ? { seconds } : {},
    confidence: seconds ? 0.92 : 0.85,
    label: isBackward ? 'Перемотка назад' : 'Перемотка вперёд',
  }
}

function extractVolume(words: string[]): VoiceCommand | null {
  const text = words.join(' ')
  const m = text.match(/громкость\s+(\d{1,3})/)
  if (m) {
    const vol = Math.min(100, parseInt(m[1], 10))
    return { type: VoiceCommandType.SetVolume, params: { volume: vol }, confidence: 0.95, label: `Громкость ${vol}%` }
  }
  return null
}

function extractTabNumber(words: string[]): VoiceCommand | null {
  const text = words.join(' ')
  const m = text.match(/(?:вкладку|вкладка)\s+(\d{1,2})\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    return { type: VoiceCommandType.SelectTab, params: { index: n }, confidence: 0.92, label: `Вкладка ${n}` }
  }
  // "перейди на третью вкладку" (числительное перед словом вкладка)
  const idx = words.findIndex((w) => w.startsWith('вкладк'))
  if (idx > 0) {
    const c = consumeLeadingNumber([words[idx - 1]])
    if (c) {
      return { type: VoiceCommandType.SelectTab, params: { index: c.value }, confidence: 0.9, label: `Вкладка ${c.value}` }
    }
  }
  return null
}

/** "озвучка X" / "перевод X" */
function extractDub(words: string[]): VoiceCommand | null {
  const idx = words.findIndex((w) => w.startsWith('озвучк') || w.startsWith('озвуч') || w === 'перевод' || w.startsWith('перевод') || w === 'дубляж' || w === 'озвучку')
  if (idx >= 0 && idx + 1 < words.length) {
    const dub = words.slice(idx + 1).join(' ')
    return { type: VoiceCommandType.SelectVoice, params: { dub }, confidence: 0.88, label: `Озвучка: ${dub}` }
  }
  return null
}

function extractSearch(words: string[]): VoiceCommand | null {
  const trigIdx = words.findIndex((w) => SEARCH_TRIGGERS.includes(w))
  if (trigIdx >= 0 && trigIdx + 1 < words.length) {
    const query = words.slice(trigIdx + 1).filter((w) => w !== 'аниме').join(' ').trim()
    if (query) {
      return { type: VoiceCommandType.SearchAnime, params: { query }, confidence: 0.95, label: `Найти «${query}»` }
    }
  }
  return null
}

/**
 * Открытие по названию: "открой берсерк" -> SearchAnime("берсерк", open=true).
 * Если после триггера идёт секция (топ/онгоинги...) — это навигация, не поиск.
 */
function extractOpen(words: string[]): VoiceCommand | null {
  const trigIdx = words.findIndex((w) => OPEN_TRIGGERS.includes(w))
  if (trigIdx < 0) return null

  const after = words.slice(trigIdx + 1)
  if (after.length === 0) return null

  // служебные секции уже обработаны алиасами; но на всякий случай:
  if (isSectionWord(after[0]) || after[0] === 'главную' || after[0] === 'вкладку' || after[0] === 'серию') {
    return null
  }

  // "открой берсерк и включи десятую серию" — сегментация выполнена выше,
  // здесь название — всё до конца сегмента
  // "открой берсерк в новой вкладке" -> SearchAnime(берсерк, newTab=true)
  let newTab = false
  let tail = [...after]
  if (tail.length >= 4 && tail.slice(-3).join(' ') === 'в новой вкладке') {
    newTab = true
    tail = tail.slice(0, -3)
  }
  const query = tail.filter((w) => w !== 'аниме').join(' ').trim()
  if (!query) return null
  return {
    type: VoiceCommandType.SearchAnime,
    params: { query, open: true, ...(newTab ? { newTab } : {}) },
    confidence: 0.85,
    label: `Открыть «${query}»`,
  }
}

function extractEpisodeSelect(words: string[], ctx: ParseCtx): VoiceCommand | null {
  // паттерн 1: "серию 5", "серия 12", "открой серию 15"
  const joined = words.join(' ')
  const m = joined.match(/(?:сери[ауюя]|эпизод[ау]?)\s+(\d{1,3})\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    return { type: VoiceCommandType.SelectEpisode, params: { episode: n }, confidence: 0.96, label: `Серия ${n}` }
  }
  const m2 = joined.match(/^(\d{1,3})\s+(?:сери[ауюя]|эпизод[ау]?)/)
  if (m2) {
    const n = parseInt(m2[1], 10)
    return { type: VoiceCommandType.SelectEpisode, params: { episode: n }, confidence: 0.95, label: `Серия ${n}` }
  }

  // паттерн 2: глагол + числительное + "серию" ("включи пятую серию")
  const trigIdx = words.findIndex((w) => OPEN_TRIGGERS.includes(w))
  const after = trigIdx >= 0 ? words.slice(trigIdx + 1) : words
  if (hasEpisodeNoun(after)) {
    // первое числительное в after
    for (let i = 0; i < after.length; i++) {
      const c = consumeLeadingNumber(after.slice(i))
      if (c) {
        return { type: VoiceCommandType.SelectEpisode, params: { episode: c.value }, confidence: 0.93, label: `Серия ${c.value}` }
      }
    }
  }

  // паттерн 3 (контекст): bare числительное при просмотре ("двадцать", "пятая",
  // "открой двадцать первую" при открытом аниме)
  const watching = ctx.playback.animeTitle !== null
  const picking = ctx.navigation.pickingFromList
  if (watching || picking) {
    let bare = [...words]
    const trigIdx = bare.findIndex((w) => OPEN_TRIGGERS.includes(w))
    if (trigIdx === 0) bare = bare.slice(1)
    if (bare.length >= 1 && bare.length <= 3) {
      const c = consumeLeadingNumber(bare)
      if (c && c.rest.length === 0) {
        return {
          type: picking ? VoiceCommandType.SelectOption : VoiceCommandType.SelectEpisode,
          params: { [picking ? 'index' : 'episode']: c.value },
          confidence: 0.8,
          label: picking ? `Вариант ${c.value}` : `Серия ${c.value}`,
        }
      }
    }
  }
  return null
}

function extractContextual(words: string[], ctx: ParseCtx): VoiceCommand | null {
  const text = words.join(' ')
  const watchingVideo = ctx.playback.animeTitle !== null

  // "назад": в контексте видео -> предыдущая серия, иначе -> история назад
  if (text === 'назад') {
    if (watchingVideo) {
      return { type: VoiceCommandType.PreviousEpisode, params: {}, confidence: 0.75, label: 'Предыдущая серия (контекст)' }
    }
    return { type: VoiceCommandType.Back, params: {}, confidence: 0.85, label: 'Назад' }
  }
  return null
}

// --- основной парсер --------------------------------------------------------

/** Разбить фразу на сегменты по " и " (только когда обе части осмысленны) */
function splitCombined(normalized: string): string[] {
  const rough = normalized.split(/ и | и\b/).map((s) => s.trim()).filter(Boolean)
  if (rough.length <= 1) return [normalized]
  // принимаем разбиение, только если каждый сегмент начинается с триггера
  // или является известной командой
  return rough
}

function parseSegment(segment: string, ctx: ParseCtx): VoiceCommand | null {
  const words = segment.split(' ').filter(Boolean)
  if (words.length === 0) return null

  // 1. Озвучка: "озвучка anidub", "перевод fronda"
  const dub = extractDub(words)
  if (dub) return dub

  // 2. Громкость N
  const volume = extractVolume(words)
  if (volume) return volume

  // 3. Вкладка по номеру
  const tabNum = extractTabNumber(words)
  if (tabNum) return tabNum

  // 4. Поиск: "найди берсерк"
  const search = extractSearch(words)
  if (search) return search

  // 5. Перемотка: "вперед на десять секунд"
  const seek = extractSeek(words)
  if (seek) return seek

  // 6. Выбор серии
  const episode = extractEpisodeSelect(words, ctx)
  if (episode) return episode

  // 7. Алиасы простых команд (после специализированных извлечений,
  //     чтобы "включи пятую серию" не стало Play)
  const alias = matchAlias(segment)
  if (alias) return alias

  // 8. Контекстные ("назад")
  const contextual = extractContextual(words, ctx)
  if (contextual) return contextual

  // 9. Открытие по названию: "открой берсерк"
  const open = extractOpen(words)
  if (open) return open

  return null
}

export interface ParseResult {
  normalized: string
  commands: VoiceCommand[]
  /** Средняя уверенность */
  confidence: number
  /** Не удалось распознать */
  failed: boolean
}

export function parseCommand(rawText: string, context: BrowserContext): ParseResult {
  const normalized = normalizeCommandText(rawText)
  const stripped = stripFillers(normalized)

  // wake word: "аниме, следующая серия" -> срезаем wake word
  let text = stripped
  const wake = 'аниме'
  if (text.startsWith(wake + ' ') && text !== wake) {
    text = text.slice(wake.length + 1).trim()
  }

  const ctx: ParseCtx = {
    navigation: context.navigation,
    playback: context.playback,
  }

  const segments = splitCombined(text)
  const commands: VoiceCommand[] = []

  for (const seg of segments) {
    const cmd = parseSegment(seg, ctx)
    if (cmd) commands.push(cmd)
  }

  // "пауза" — точный короткий случай, alias matching уже ловит.
  // Если ничего не распознано — Unknown
  if (commands.length === 0) {
    return { normalized, commands: [], confidence: 0, failed: true }
  }

  const avg = commands.reduce((s, c) => s + c.confidence, 0) / commands.length
  return { normalized, commands, confidence: avg, failed: false }
}

/** Тестовая таблица для debug-панели (#85) */
export function parserSelfTest(): Array<{ input: string; expect: string }> {
  return [
    { input: 'следующая серия', expect: 'NextEpisode' },
    { input: 'включи следующую', expect: 'NextEpisode' },
    { input: 'предыдущая серия', expect: 'PreviousEpisode' },
    { input: 'включи пятую серию', expect: 'SelectEpisode(5)' },
    { input: 'двадцать первая', expect: 'SelectEpisode(21)' },
    { input: 'серия 5', expect: 'SelectEpisode(5)' },
    { input: 'открой топ сто', expect: 'OpenTop100' },
    { input: 'покажи онгоинги', expect: 'OpenOngoing' },
    { input: 'найди берсерк', expect: 'SearchAnime(берсерк)' },
    { input: 'открой берсерк', expect: 'SearchAnime(берсерк, open)' },
    { input: 'пауза', expect: 'Pause' },
    { input: 'громче', expect: 'VolumeUp' },
    { input: 'громкость 50', expect: 'SetVolume(50)' },
    { input: 'вперед на десять секунд', expect: 'SeekForward(10)' },
    { input: 'назад на тридцать секунд', expect: 'SeekBackward(30)' },
    { input: 'полный экран', expect: 'Fullscreen' },
    { input: 'новая вкладка', expect: 'OpenNewTab' },
    { input: 'открой случайное', expect: 'OpenRandom' },
    { input: 'расписание', expect: 'OpenSchedule' },
    { input: 'анонсы', expect: 'OpenAnnouncements' },
  ]
}
