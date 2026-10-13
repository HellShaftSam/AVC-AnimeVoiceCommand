/**
 * Парсер эпизодов YummyAnime (Task 23, спека §3–§23).
 *
 * ЧИСТЫЕ функции без сети — каждая стадия тестируется независимо:
 *   Source Extraction (adapter) → parseEpisodeLabel → buildEpisodeIndex
 *     → validateEpisodeData → parseWatchOrder → buildEpisodeReport
 *
 * Что выяснено при реверсе реального сайта (old.yummyani.me):
 *  - /api/anime/{id} отдаёт episodes:{count, aired, next_date} и viewing_order[].
 *  - /api/anime/{id}/videos — ОДНА большая матрица (без пагинации), запись =
 *    «серия × озвучка × плеер»; поле number — СТРОКА ("1", "1168.5", "119+120").
 *  - Плеер сайта показывает серии ВЫБРАННОЙ озвучки (и плеера), чипы озвучек —
 *    «(N эп.)» по уникальным меткам серий озвучки (функция Ln в react.min.js).
 *  - Инфоблок страницы показывает «Серий: {count}», тултип — «Вышло серий:
 *    {aired} из {count}»; ПОЛЕ aired БЫВАЕТ ГРЯЗНЫМ (Шиппуден: aired=58,
 *    матрица покрывает 1..500) — доверять ему без валидации нельзя (§5).
 *  - «Порядок просмотра» сайта приходит структурой viewing_order:
 *    {anime_id, anime_url, title, type, year, data:{text, id, index}}.
 */
import {
  CanonicalEpisode,
  DubCoverage,
  DubOption,
  EpisodeKind,
  EpisodeStatistics,
  EpisodeVariant,
  ValidationIssue,
  VideoEntry,
  WatchOrderEntry,
  WatchOrderPlacement,
} from '@/lib/avc/types'

// ---------------------------------------------------------------------------
// Стадия 1: разбор метки серии (§5: «максимальное число на странице» ≠ счётчик;
// parseInt здесь запрещён — он путает 1168.5 → 1168 и «119+120» → 119)
// ---------------------------------------------------------------------------

export interface ParsedLabel {
  primary: number | null
  kind: EpisodeKind
  /** Ключ сортировки: normal → число, special → дробное (1168.5 между 1168 и 1169),
   *  range → число+0.05, unparseable → в конец */
  sortKey: number
}

export function parseEpisodeLabel(raw: string): ParsedLabel {
  const s = String(raw ?? '').trim()
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    return { primary: n, kind: 'normal', sortKey: n }
  }
  // Диапазон: "119+120", "119-120", "119–120" (двухсерийники)
  const range = s.match(/^(\d{1,5})\s*[+–—-]\s*(\d{1,5})$/)
  if (range) {
    const a = parseInt(range[1], 10)
    const b = parseInt(range[2], 10)
    const lo = Math.min(a, b)
    return { primary: lo, kind: 'range', sortKey: lo + 0.05 }
  }
  // Дробная метка-спешл: "1168.5" (серия между 1168 и 1169)
  const dec = s.match(/^(\d{1,5})\.(\d{1,3})$/)
  if (dec) {
    const n = parseInt(dec[1], 10)
    return { primary: n, kind: 'special', sortKey: Number(`${dec[1]}.${dec[2]}`) }
  }
  // Начинается числом, но с мусором ("1 OVA") — честно помечаем 'other'
  const lead = s.match(/^(\d{1,5})(?!\.\d)/)
  if (lead) {
    const n = parseInt(lead[1], 10)
    return { primary: n, kind: 'other', sortKey: n + 0.5 }
  }
  return { primary: null, kind: 'other', sortKey: Number.MAX_SAFE_INTEGER }
}

const KIND_PRIORITY: Record<EpisodeKind, number> = {
  normal: 0,
  range: 1,
  special: 2,
  other: 3,
}

// ---------------------------------------------------------------------------
// Стадия 2: вход адаптера — сырые записи видео-матрицы
// ---------------------------------------------------------------------------

/** Минимальная сырая запись /api/anime/{id}/videos (метка сохраняется КАК ЕСТЬ) */
export interface RawVideoRecord {
  videoId: number
  rawNumber: string
  dubName: string
  playerName: string
  iframeUrl: string
  duration: number | null
}

// ---------------------------------------------------------------------------
// Стадия 3: канонический индекс серий (группировка + покрытие озвучек)
// ---------------------------------------------------------------------------

export interface EpisodeIndex {
  episodes: CanonicalEpisode[]
  dubs: DubCoverage[]
  stats: EpisodeStatistics
  warnings: ValidationIssue[]
}

const DUB_SHORT_RE = /^(Озвучка|Субтитры)\s*/i

function shortDubName(name: string): string {
  return name.replace(DUB_SHORT_RE, '').trim() || name
}

/**
 * Строит канонический индекс из сырой матрицы.
 * Идентичность серии = метка сайта (§9: НЕ title и НЕ parseInt).
 * Дедуп вариантов — по videoId (повторный video_id не плодит серий).
 * Озвучки/плееры НЕ считаются сериями (§21): 220 серий × 5 озвучек = 220.
 */
export function buildEpisodeIndex(
  animeId: number,
  records: RawVideoRecord[],
  opts: { declaredCount?: number | null; releasedCount?: number | null; nextEpisodeAt?: number | null } = {},
): EpisodeIndex {
  // --- канонические серии по метке
  const byLabel = new Map<string, CanonicalEpisode>()
  const seenVideoIds = new Set<number>()
  for (const r of records) {
    if (!r.iframeUrl) continue // без плеера запись недоступна — это не серия
    const label = String(r.rawNumber ?? '').trim() || '?'
    let ep = byLabel.get(label)
    if (!ep) {
      const p = parseEpisodeLabel(label)
      ep = { label, primary: p.primary, kind: p.kind, variants: [] }
      byLabel.set(label, ep)
    }
    if (!seenVideoIds.has(r.videoId)) {
      seenVideoIds.add(r.videoId)
      ep.variants.push({
        videoId: r.videoId,
        dubName: r.dubName || 'Неизвестная озвучка',
        playerName: r.playerName || '',
        iframeUrl: r.iframeUrl,
        duration: r.duration ?? null,
      })
    }
  }

  // --- сортировка: primary → kind → метка
  const episodes = [...byLabel.values()].sort((a, b) => {
    const ka = parseEpisodeLabel(a.label)
    const kb = parseEpisodeLabel(b.label)
    if (ka.sortKey !== kb.sortKey) return ka.sortKey - kb.sortKey
    if (KIND_PRIORITY[a.kind] !== KIND_PRIORITY[b.kind]) return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
    return a.label.localeCompare(b.label, 'en', { numeric: true })
  })

  // --- покрытие озвучек (как чипы сайта: уникальные МЕТКИ на озвучку)
  const dubMap = new Map<string, { labels: Set<string>; maxNumber: number | null; players: Set<string> }>()
  for (const ep of episodes) {
    for (const v of ep.variants) {
      let d = dubMap.get(v.dubName)
      if (!d) {
        d = { labels: new Set(), maxNumber: null, players: new Set() }
        dubMap.set(v.dubName, d)
      }
      d.labels.add(ep.label)
      if (ep.kind === 'normal' && ep.primary !== null) {
        d.maxNumber = d.maxNumber === null ? ep.primary : Math.max(d.maxNumber, ep.primary)
      }
      if (v.playerName) d.players.add(v.playerName)
    }
  }
  const dubs: DubCoverage[] = [...dubMap.entries()]
    .map(([name, d]) => ({
      name,
      shortName: shortDubName(name),
      labelCount: d.labels.size,
      maxNumber: d.maxNumber,
      players: [...d.players].sort(),
    }))
    .sort((a, b) => b.labelCount - a.labelCount)

  // --- статистика (§28)
  const normal = episodes.filter((e) => e.kind === 'normal')
  const specials = episodes.filter((e) => e.kind === 'special')
  const ranges = episodes.filter((e) => e.kind === 'range')
  const stats: EpisodeStatistics = {
    declaredCount: opts.declaredCount ?? null,
    releasedCount: opts.releasedCount ?? null,
    availableCount: episodes.length,
    normalCount: normal.length,
    specialCount: specials.length,
    rangeCount: ranges.length,
    latestEpisodeNumber: normal.reduce<number | null>((m, e) => (e.primary !== null && (m === null || e.primary > m) ? e.primary : m), null),
    nextEpisodeAt: opts.nextEpisodeAt ?? null,
  }

  const warnings = validateEpisodeData(stats, episodes, dubs)
  return { episodes, dubs, stats, warnings }
}

// ---------------------------------------------------------------------------
// Стадия 4: валидация (§18/§19) — НЕ молча чиним, а честно помечаем
// ---------------------------------------------------------------------------

export function validateEpisodeData(
  stats: EpisodeStatistics,
  episodes: CanonicalEpisode[],
  dubs: DubCoverage[],
): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const { declaredCount, releasedCount, availableCount, normalCount, specialCount, rangeCount, latestEpisodeNumber } = stats

  if (availableCount === 0) {
    out.push({
      code: 'NO_VIDEOS',
      severity: 'warning',
      message: 'В видео-матрице сайта нет доступных серий',
    })
    return out
  }

  // Главное противоречие источника: «Вышло серий: 58», а в матрице 500+ (Шиппуден).
  // Допуск 2 — на двусерийники/спешлы у краёв.
  if (releasedCount !== null && latestEpisodeNumber !== null && releasedCount + 2 < latestEpisodeNumber) {
    out.push({
      code: 'SUSPICIOUS_AIRED_BELOW_MAX',
      severity: 'warning',
      message: `Сайт сообщает «Вышло серий: ${releasedCount}», но в плеере есть серии до ${latestEpisodeNumber} — поле сайта устарело, счётчик берётся из видео-матрицы`,
      details: { releasedCount, latestEpisodeNumber, availableCount },
    })
  }

  // Несоответствие объявленного количества (для завершённых тайтлов)
  if (
    declaredCount !== null &&
    latestEpisodeNumber !== null &&
    declaredCount + 2 < latestEpisodeNumber
  ) {
    out.push({
      code: 'EPISODE_COUNT_MISMATCH',
      severity: 'warning',
      message: `«Количество серий: ${declaredCount}» по сайту, но в плеере есть серии до ${latestEpisodeNumber}`,
      details: { declaredCount, latestEpisodeNumber, availableCount },
    })
  }
  if (
    declaredCount !== null &&
    releasedCount !== null &&
    releasedCount > 0 &&
    declaredCount >= releasedCount &&
    normalCount + rangeCount < releasedCount - 2 &&
    // для онгоинга озвучки часто отстают от эфира — это норма, не ошибка источника
    !(declaredCount > releasedCount)
  ) {
    out.push({
      code: 'EPISODE_COUNT_MISMATCH',
      severity: 'info',
      message: `В матрице ${normalCount + rangeCount} серий, сайт сообщает «Вышло: ${releasedCount} из ${declaredCount}»`,
      details: { parsedCount: normalCount + rangeCount, releasedCount, declaredCount },
    })
  }

  if (declaredCount === null) {
    out.push({
      code: 'DECLARED_COUNT_MISSING',
      severity: 'info',
      message: 'Сайт не указывает «Количество серий» (онгоинг/анонс) — счётчик берётся из видео-матрицы',
    })
  }
  if (specialCount > 0) {
    out.push({
      code: 'NON_INTEGER_EPISODES',
      severity: 'info',
      message: `Есть спец-серии с дробной меткой (${specialCount} шт.) — показываются отдельными кнопками, как на сайте`,
    })
  }
  if (rangeCount > 0) {
    out.push({
      code: 'RANGE_EPISODES',
      severity: 'info',
      message: `Есть двухсерийники с меткой-диапазоном (${rangeCount} шт., напр. «119+120»)`,
    })
  }
  const unparseable = episodes.filter((e) => e.primary === null).length
  if (unparseable > 0) {
    out.push({
      code: 'UNPARSEABLE_LABELS',
      severity: 'warning',
      message: `${unparseable} меток серий не распознаны числом — показаны как есть`,
    })
  }
  // Разброс покрытия озвучек — честная подсказка, почему «серий то 1157, то 1180»
  const withMax = dubs.filter((d) => d.maxNumber !== null)
  if (withMax.length >= 2) {
    const best = Math.max(...withMax.map((d) => d.maxNumber as number))
    const worst = Math.min(...withMax.map((d) => d.maxNumber as number))
    if (best - worst > 2) {
      out.push({
        code: 'DUB_COVERAGE_GAP',
        severity: 'info',
        message: `Озвучки покрывают разное число серий: от ${worst} до ${best} — сетка серий зависит от выбранной озвучки`,
        details: { best, worst },
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Стадия 5: выбор варианта серии (голос «серия N» / клик по кнопке)
// ---------------------------------------------------------------------------

export interface EpisodePick {
  episode: CanonicalEpisode
  variant: EpisodeVariant
  /** Озвучка выбранного варианта не совпала с предпочитаемой */
  switchedDub: boolean
}

/** Детерминированный выбор: normal > range > special > other, внутри — предпочитаемая озвучка */
export function pickEpisodeVariant(
  index: EpisodeIndex,
  requestedNumber: number,
  preferDub: string | null,
): EpisodePick | null {
  const matches = index.episodes.filter((e) => e.primary === requestedNumber)
  if (matches.length === 0) return null
  matches.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
  const episode = matches[0]
  const inDub = preferDub ? episode.variants.filter((v) => v.dubName === preferDub) : []
  const variant = inDub[0] ?? episode.variants[0]
  return { episode, variant, switchedDub: inDub.length === 0 }
}

/** Кнопки сетки серий: серии ВЫБРАННОЙ озвучки (семантика плеера сайта);
 *  без озвучки — все канонические серии */
export function episodeLabelsForDub(
  episodes: CanonicalEpisode[],
  dubName: string | null,
): CanonicalEpisode[] {
  if (!dubName) return episodes
  const own = episodes.filter((e) => e.variants.some((v) => v.dubName === dubName))
  return own.length > 0 ? own : episodes
}

/** Следующая/предыдущая каноническая серия относительно primary (в пределах озвучки) */
export function neighborEpisode(
  episodes: CanonicalEpisode[],
  currentPrimary: number,
  direction: 1 | -1,
  dubName: string | null,
): CanonicalEpisode | null {
  const list = episodeLabelsForDub(episodes, dubName)
  const idx = list.findIndex((e) => e.primary === currentPrimary)
  const sorted = [...list].sort((a, b) => {
    const ka = parseEpisodeLabel(a.label)
    const kb = parseEpisodeLabel(b.label)
    return ka.sortKey - kb.sortKey
  })
  if (idx === -1) {
    // текущей нет в списке (сменили озвучку) — берём ближайшую по направлению
    if (direction === 1) return sorted.find((e) => (e.primary ?? -Infinity) > currentPrimary) ?? null
    return [...sorted].reverse().find((e) => (e.primary ?? Infinity) < currentPrimary) ?? null
  }
  const cur = sorted.findIndex((e) => e.label === list[idx].label)
  return sorted[cur + direction] ?? null
}

/** Плоский список VideoEntry из индекса (обратная совместимость с VideoEntry-кодом) */
export function indexToVideoEntries(index: EpisodeIndex): VideoEntry[] {
  const out: VideoEntry[] = []
  for (const ep of index.episodes) {
    for (const v of ep.variants) {
      out.push({
        videoId: v.videoId,
        episode: ep.primary ?? 0,
        rawNumber: ep.label,
        dubName: v.dubName,
        playerName: v.playerName,
        iframeUrl: v.iframeUrl,
        duration: v.duration,
      })
    }
  }
  return out
}

export function dubsFromIndex(dubs: DubCoverage[]): DubOption[] {
  return dubs.map((d) => ({
    name: d.name,
    shortName: d.shortName,
    episodes: [],
    labelCount: d.labelCount,
    maxNumber: d.maxNumber,
  }))
}

// ---------------------------------------------------------------------------
// Стадия 6: порядок просмотра (§12–13) — viewing_order сайта
// ---------------------------------------------------------------------------

export interface RawViewingOrderEntry {
  anime_id: number
  anime_url: string
  title: string
  type?: { shortname?: string; name?: string }
  year?: number
  anime_status?: { title?: string }
  data?: { text?: string; id?: number; index?: number }
  poster?: { medium?: string; big?: string }
  rating?: number
}

/**
 * Отношение из сырого текста сайта. «после 101 серии» НЕ превращается в
 * «Серия 102» (§14) — модль хранит режим + число, а текст показывается как есть.
 */
export function parsePlacement(text: string | null | undefined): WatchOrderPlacement {
  const s = (text ?? '').trim()
  if (!s) return { mode: 'unknown' }
  let m = s.match(/(?:после|через)\s+(\d{1,4})\s*(?:сери|эпизод)/i)
  if (m) return { mode: 'afterEpisode', episodeNumber: parseInt(m[1], 10) }
  m = s.match(/(?:перед|до)\s+(\d{1,4})\s*(?:сери|эпизод)/i)
  if (m) return { mode: 'before', episodeNumber: parseInt(m[1], 10) }
  m = s.match(/(?:после|через)\s+(\d{1,3})\s*(?:сезон)/i)
  if (m) return { mode: 'afterSeason', seasonNumber: parseInt(m[1], 10) }
  if (/дополн|спешл|спин-офф|адапт|суммарн|рекап|фильм|особ|бонус|пародия|описание/i.test(s)) {
    return { mode: 'optional' }
  }
  return { mode: 'unknown' }
}

export function parseWatchOrder(
  currentAnimeId: number,
  entries: RawViewingOrderEntry[] | null | undefined,
): WatchOrderEntry[] {
  if (!Array.isArray(entries)) return []
  const out: WatchOrderEntry[] = []
  entries.forEach((e, i) => {
    if (!e || typeof e.anime_id !== 'number') return
    const poster = e.poster?.medium
      ? e.poster.medium.startsWith('//')
        ? `https:${e.poster.medium}`
        : e.poster.medium
      : null
    out.push({
      animeId: e.anime_id,
      slug: e.anime_url ?? '',
      title: e.title ?? `Аниме #${e.anime_id}`,
      type: e.type?.shortname ?? e.type?.name ?? null,
      year: typeof e.year === 'number' && e.year > 0 ? e.year : null,
      status: e.anime_status?.title ?? null,
      relationText: e.data?.text?.trim() || null,
      position: typeof e.data?.index === 'number' ? e.data.index : i,
      placement: parsePlacement(e.data?.text),
      poster,
      rating: typeof e.rating === 'number' ? e.rating : null,
      available: null, // заполняется опциональной проверкой видео-матрицы
    })
  })
  // позиция 0 у самого тайтла — норм (сайт ставит текущее аниме первым)
  void currentAnimeId
  return out.sort((a, b) => a.position - b.position)
}

// ---------------------------------------------------------------------------
// Стадия 7: отчёт диагностики (§23/§24) — объясняет расхождения числами
// ---------------------------------------------------------------------------

export interface EpisodeReport {
  animeId: number
  parserVersion: number
  generatedAt: number
  raw: {
    videoRecords: number
    uniqueLabels: number
    byDub: Array<{ dub: string; labels: number; maxNumber: number | null; players: number }>
  }
  parsed: {
    availableCount: number
    normalCount: number
    specialCount: number
    rangeCount: number
    latestEpisodeNumber: number | null
  }
  source: {
    declaredCount: number | null
    releasedCount: number | null
    nextEpisodeAt: number | null
  }
  validation: ValidationIssue[]
  watchOrderCount: number
}

export function buildEpisodeReport(
  animeId: number,
  index: EpisodeIndex,
  rawRecordCount: number,
  watchOrderCount: number,
  parserVersion: number,
): EpisodeReport {
  return {
    animeId,
    parserVersion,
    generatedAt: Date.now(),
    raw: {
      videoRecords: rawRecordCount,
      uniqueLabels: index.episodes.length,
      byDub: index.dubs.map((d) => ({
        dub: d.name,
        labels: d.labelCount,
        maxNumber: d.maxNumber,
        players: d.players.length,
      })),
    },
    parsed: {
      availableCount: index.stats.availableCount,
      normalCount: index.stats.normalCount,
      specialCount: index.stats.specialCount,
      rangeCount: index.stats.rangeCount,
      latestEpisodeNumber: index.stats.latestEpisodeNumber,
    },
    source: {
      declaredCount: index.stats.declaredCount,
      releasedCount: index.stats.releasedCount,
      nextEpisodeAt: index.stats.nextEpisodeAt,
    },
    validation: index.warnings,
    watchOrderCount,
  }
}
