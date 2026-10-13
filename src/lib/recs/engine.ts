/**
 * Рекомендации — ЧИСТЫЙ детерминированный гибридный движок (ТЗ §5–§8).
 *
 * Конвейер (порядок принципиален — фильтрация ДО ранжирования):
 *   1. Нормализация и дедупликация кандидатов (по animeId и slug)
 *   2. ЖЁСТКИЕ исключения (до любого скоринга):
 *      брошено / своя оценка ниже порога / уже известен / скрыт фидбеком
 *   3. Контентная похожесть (взвешенный Жаккар жанров + студий) vs позитивные якоря
 *   4. Аффинитет вкуса (взвешенный вектор жанров профиля, минус слабый негатив)
 *   5. Сигналы франшизы (по типу связи, гаснут от негативных родителей)
 *   6. Качество тайтла (рейтинг сайта; нет данных → нейтраль, НЕ негатив)
 *   7. Итоговый скор = 100 × (0.42·sim + 0.28·aff + 0.20·fr + 0.10·q)
 *   8. MMR-разнообразие (переключаемо)
 *   9. Объяснения только из реальных компонентов
 *
 * Без внешних вызовов, без LLM, без рандома — одинаковые входы → одинаковый выход.
 */
import type { AnimeCard } from '@/lib/avc/types'
import type {
  RecCandidate,
  RecCard,
  RecEngineSettings,
  RecProfile,
  RecResult,
} from './types'
import { topGenres } from './profile'

// --- служебные ----------------------------------------------------------------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Нормализованный жанр: нижний регистр, без лишних пробелов */
function normTag(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(normTag).filter(Boolean))
  const sb = new Set(b.map(normTag).filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * Взвешенная похожесть двух тайтлов: жанры ×1.0 + студии ×0.5.
 * Студии — «более специфичный» сигнал, но они редки/шумны → вес ниже (ТЗ §5.1).
 * Отсутствующие метаданные НЕ считаются негативом: знаменатель уменьшается
 * (у обоих есть студии → учитываем; иначе компонент студий выпадает честно).
 */
export function weightedTitleSimilarity(
  a: { genres: string[]; studios: string[] },
  b: { genres: string[]; studios: string[] },
): number {
  const g = jaccard(a.genres, b.genres)
  const hasStudios = a.studios.length > 0 && b.studios.length > 0
  const s = hasStudios ? jaccard(a.studios, b.studios) : 0
  const denom = hasStudios ? 1.5 : 1.0
  return clamp01((g * 1.0 + s * 0.5) / denom)
}

/** Классификация связи франшизы по тексту сайта («2 сезон», «фильм», «адаптация манги») */
export function franchiseKind(relation: string | null): number {
  // sequels/prequels сильнее всего: «1 сезон», «2 сезон», «продолжение»
  const r = (relation ?? '').toLowerCase()
  if (/сезон|продолжени|сиквел|sequel|prequel|приквел/.test(r)) return 1.0
  if (/фильм|movie|кино/.test(r)) return 0.7
  if (/ova|ona|спешл|special|эпизод/.test(r)) return 0.5
  if (/адаптац|манги|первоисточник/.test(r)) return 0.3
  return 0.4
}

/** Нормализованный «качество тайтла» из рейтинга сайта: нет данных → 0.5 (нейтраль) */
export function qualityOf(siteRating: number | null): number {
  if (siteRating === null || !Number.isFinite(siteRating) || siteRating <= 0) return 0.5
  // Шкала сайта ~1..10, реальный разброс 5.5–9 → мягкое отображение в 0..1
  return clamp01((siteRating - 5.5) / 3.5)
}

/** Порог холодного старта: меньше суммарной силы — персонализации нет (честно) */
const COLD_START_EVIDENCE = 1.0

// --- основные вычисления --------------------------------------------------------

/** Аффинитет кандидата к вектору вкуса 0..1 (негативные жанры штрафуют слабо) */
export function affinityOf(
  candidateGenres: string[],
  genreWeights: Map<string, number>,
  negativeGenreWeights: Map<string, number>,
): number {
  if (candidateGenres.length === 0 || genreWeights.size === 0) return 0
  const totalPos = [...genreWeights.values()].reduce((s, v) => s + v, 0)
  if (totalPos <= 0) return 0
  let hit = 0
  for (const g of candidateGenres) {
    hit += genreWeights.get(normTag(g)) ?? 0
  }
  let pos = clamp01(hit / totalPos)
  // Негативный вектор: штраф ≤ 0.3 от позитива — жанр не отвергается целиком
  if (negativeGenreWeights.size > 0) {
    const totalNeg = [...negativeGenreWeights.values()].reduce((s, v) => s + v, 0)
    if (totalNeg > 0) {
      let neg = 0
      for (const g of candidateGenres) {
        neg += negativeGenreWeights.get(normTag(g)) ?? 0
      }
      pos = Math.max(0, pos - 0.3 * clamp01(neg / totalNeg))
    }
  }
  return pos
}

/** Лучший якорь-родитель франшизы для кандидата (только позитивные!) */
function bestFranchiseSignal(
  candidate: RecCandidate,
  profile: RecProfile,
): { parent: { title: string; strength: number }; kind: number } | null {
  const fp = candidate.franchiseParent
  if (!fp) return null
  // Родитель должен быть ПОЗИТИВНЫМ якорем (брошенное/низкооценённое не рекламирует сиквел)
  const parent = profile.franchiseParents.get(fp.animeId)
  if (!parent || parent.strength <= 0) return null
  return { parent, kind: franchiseKind(fp.relation) }
}

/** Похожесть кандидата на ЛУЧШИЙ позитивный якорь + кто этот якорь */
function bestSimilarity(
  candidate: RecCandidate,
  positiveAnchors: Array<{ genres: string[]; studios: string[]; title: string; strength: number }>,
): { sim: number; anchor: (typeof positiveAnchors)[number] | null; sharedGenres: string[] } {
  let best: { sim: number; anchor: (typeof positiveAnchors)[number] | null; sharedGenres: string[] } = {
    sim: 0,
    anchor: null,
    sharedGenres: [],
  }
  for (const anchor of positiveAnchors) {
    const sim = weightedTitleSimilarity(candidate, anchor)
    if (sim > best.sim) {
      const shared = candidate.genres.filter((g) => anchor.genres.some((x) => normTag(x) === normTag(g)))
      best = { sim, anchor, sharedGenres: shared }
    }
  }
  return best
}

// --- скоринг ---------------------------------------------------------------------

/**
 * Скоринг одного кандидата. Тяжёлые исключения должны быть применены ДО вызова.
 * Компоненты нормализованы в 0..1 и хранятся раздельно (объяснимость).
 */
export function scoreCandidate(
  candidate: RecCandidate,
  profile: RecProfile,
  positiveAnchors: Array<{ genres: string[]; studios: string[]; title: string; strength: number }>,
  discovery: boolean,
): RecCard {
  const simRes = discovery
    ? { sim: 0, anchor: null, sharedGenres: [] as string[] }
    : bestSimilarity(candidate, positiveAnchors)
  const sim = clamp01(simRes.sim)

  const aff = discovery ? 0 : affinityOf(candidate.genres, profile.genreWeights, profile.negativeGenreWeights)

  const fr = discovery
    ? 0
    : (() => {
        const sig = bestFranchiseSignal(candidate, profile)
        return sig ? clamp01(sig.kind * sig.parent.strength) : 0
      })()

  const q = qualityOf(candidate.rating)

  // Холодный старт: честная «общая» оценка = качество тайтла, без мнимой персонализации
  if (discovery) {
    return {
      card: {
        animeId: candidate.animeId,
        slug: candidate.slug,
        title: candidate.title,
        poster: candidate.poster,
        year: candidate.year,
        rating: candidate.rating,
        status: candidate.status,
        type: candidate.type,
      },
      components: { similarity: 0, affinity: 0, franchise: 0, quality: q },
      score: Math.round(q * 1000) / 10,
      reasons: candidate.rating !== null && candidate.rating > 0
        ? ['Общая подборка — популярное на сайте', `Рейтинг сайта: ${candidate.rating.toFixed(1)}`]
        : ['Общая подборка — популярное на сайте'],
      discovery: true,
    }
  }

  const score = 100 * (0.42 * sim + 0.28 * aff + 0.2 * fr + 0.1 * q)

  // --- объяснения: только из реальных данных и ненулевых компонентов (ТЗ §8) ---
  const reasons: string[] = []
  if (fr > 0) {
    const sig = bestFranchiseSignal(candidate, profile)!
    reasons.push(
      `Связано с «${sig.parent.title}»${candidate.franchiseParent?.relation ? ` (${candidate.franchiseParent.relation})` : ''}`,
    )
  } else if (sim >= 0.15 && simRes.anchor) {
    const shared = simRes.sharedGenres.slice(0, 3).join(', ')
    reasons.push(
      shared
        ? `Похоже на «${simRes.anchor.title}» — совпадают жанры: ${shared}`
        : `Похоже на «${simRes.anchor.title}»`,
    )
  } else if (aff >= 0.12) {
    const top = topGenreMatches(candidate.genres, profile)
    if (top.length > 0) reasons.push(`Подходит вашим предпочтениям: ${top.slice(0, 3).join(', ')}`)
  }
  if (reasons.length < 2 && candidate.rating !== null && candidate.rating >= 7.5) {
    reasons.push(`Высокий рейтинг сайта: ${candidate.rating.toFixed(1)}`)
  }

  return {
    card: {
      animeId: candidate.animeId,
      slug: candidate.slug,
      title: candidate.title,
      poster: candidate.poster,
      year: candidate.year,
      rating: candidate.rating,
      status: candidate.status,
      type: candidate.type,
    },
    components: { similarity: sim, affinity: aff, franchise: fr, quality: q },
    score: Math.round(score * 10) / 10,
    reasons: reasons.slice(0, 2),
    discovery: discovery || undefined,
  }
}

function topGenreMatches(candidateGenres: string[], profile: RecProfile): string[] {
  return [...profile.genreWeights.entries()]
    .filter(([g]) => candidateGenres.some((c) => normTag(c) === normTag(g)))
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g)
}

// --- MMR-разнообразие -------------------------------------------------------------

/** MMR-переранжирование: λ=0.72 — релевантность доминирует, повторы жанров разбавляются */
export function diversify(items: RecCard[], candidates: Map<number, RecCandidate>): RecCard[] {
  const LAMBDA = 0.72
  const out: RecCard[] = []
  const pool = [...items]
  while (pool.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]
      let maxSimToSelected = 0
      for (const sel of out) {
        const candMeta = candidates.get(item.card.animeId)
        const selMeta = candidates.get(sel.card.animeId)
        const sim =
          candMeta && selMeta
            ? weightedTitleSimilarity(candMeta, selMeta)
            : jaccard(item.card.title.split(' '), sel.card.title.split(' '))
        if (sim > maxSimToSelected) maxSimToSelected = sim
      }
      const val = item.score * (1 - (1 - LAMBDA) * maxSimToSelected)
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    out.push(pool.splice(bestIdx, 1)[0])
  }
  return out
}

// --- главный вход -----------------------------------------------------------------

export interface EngineInput {
  profile: RecProfile
  candidates: RecCandidate[]
  settings: RecEngineSettings
  /** ID из обратной связи «Не интересно»/«Уже видел» (фильтруются жёстко) */
  feedbackHiddenIds: Set<number>
}

/**
 * Полный конвейер. ДЕТЕРМИНИРОВАН: одинаковый вход → одинаковый выход
 * (сортировки стабильны по animeId при равенстве скорингов).
 */
export function computeRecommendations(input: EngineInput): RecResult {
  const { profile, settings, feedbackHiddenIds } = input
  const summary: RecResult['profileSummary'] = {
    anchors: profile.anchors.length,
    positiveAnchors: profile.anchors.filter((a) => !a.negative && a.strength > 0).length,
    negativeAnchors: profile.anchors.filter((a) => a.negative).length,
    knownTitles: profile.knownIds.size,
    candidates: 0,
    excludedKnown: 0,
    excludedDropped: 0,
    excludedLowRated: 0,
    excludedFeedback: 0,
    duplicatesRemoved: 0,
    topGenres: topGenres(profile, 5),
  }

  // Гость → персонализация невозможна; движок ничего не выдумывает
  if (profile.accountKey === null) {
    return {
      mode: 'logged-out',
      items: [],
      profileSummary: summary,
      message: 'Войдите в аккаунт YummyAnime — персональные рекомендации строятся по вашей библиотеке, оценкам и избранному',
    }
  }

  const positiveAnchors = profile.anchors
    .filter((a) => !a.negative && a.strength > 0)
    .map((a) => ({
      genres: a.genres,
      studios: a.studios,
      title: a.entry.title,
      strength: a.strength,
    }))
    .sort((a, b) => b.strength - a.strength)

  // Холодный старт: честная общая подборка с явной меткой (ТЗ §9)
  const discovery = profile.positiveEvidence < COLD_START_EVIDENCE

  // --- 1. Нормализация и дедупликация ---
  const candidates = new Map<number, RecCandidate>()
  const seenSlugs = new Set<string>()
  let duplicates = 0
  const sortedIn = [...input.candidates].sort((a, b) => a.animeId - b.animeId)
  for (const c of sortedIn) {
    if (c.animeId <= 0 || !c.slug) continue
    if (candidates.has(c.animeId) || seenSlugs.has(c.slug)) {
      // Тот же тайтл пришёл из франшизы и каталога / дубль слага — один кандидат
      duplicates++
      continue
    }
    seenSlugs.add(c.slug)
    candidates.set(c.animeId, c)
  }
  summary.candidates = candidates.size
  summary.duplicatesRemoved = duplicates

  // --- 2. ЖЁСТКИЕ исключения (ДО ранжирования; ТЗ принцип №1) ---
  const excludedDropped: number[] = []
  const excludedLow: number[] = []
  const survivors: RecCandidate[] = []
  for (const c of candidates.values()) {
    // 2а. Брошено / ниже порога — ВЫСШИЙ приоритет, похожесть не спасает.
    //     Действует даже при excludeKnown=false — это не «известность», а вето.
    if (profile.hardExcludedIds.has(c.animeId)) {
      const anchor = profile.anchors.find((a) => a.entry.animeId === c.animeId)
      if (anchor?.negative) {
        if (anchor.entry.status === 'dropped') excludedDropped.push(c.animeId)
        else excludedLow.push(c.animeId)
        continue
      }
    }
    // 2б. Уже известен (любой список/история) — флаг excludeKnown
    if (settings.excludeKnown && (profile.knownIds.has(c.animeId) || profile.knownSlugs.has(c.slug))) {
      summary.excludedKnown++
      continue
    }
    // 2в. Обратная связь («Не интересно»/«Уже видел»)
    if (feedbackHiddenIds.has(c.animeId)) {
      summary.excludedFeedback++
      continue
    }
    survivors.push(c)
  }
  summary.excludedDropped = excludedDropped.length
  summary.excludedLowRated = excludedLow.length

  // --- 3–7. Скоринг ---
  let cards = survivors.map((c) => scoreCandidate(c, profile, positiveAnchors, discovery))

  // Стабильная сортировка: score desc, при равенстве — animeId asc
  cards.sort((a, b) => b.score - a.score || a.card.animeId - b.card.animeId)

  // --- 8. Разнообразие ---
  if (settings.diversity && cards.length > 6) {
    cards = diversify(cards, candidates)
  }

  return {
    mode: discovery ? 'discovery' : 'personalized',
    items: cards,
    profileSummary: summary,
    message: discovery
      ? 'Мало данных для персональных рекомендаций: оцените несколько тайтлов или добавьте их в списки — подборка станет вашей. Ниже — общая популярная подборка (не персональная).'
      : null,
  }
}

// --- хелперы для кандидатов из франшизы (используются сборщиком данных) ----------

/** Карточка франшизы → кандидат (с родителем) */
export function franchiseToCandidate(
  item: {
    animeId: number
    slug: string
    title: string
    poster: string | null
    year: number | null
    type: string | null
    status: string | null
    relation: string | null
  },
  parent: { animeId: number; title: string; strength: number },
): RecCandidate {
  return {
    animeId: item.animeId,
    slug: item.slug,
    title: item.title,
    poster: item.poster,
    year: item.year,
    rating: null,
    status: item.status,
    type: item.type,
    genres: [],
    studios: [],
    origin: 'franchise',
    franchiseParent: {
      animeId: parent.animeId,
      title: parent.title,
      relation: item.relation,
      order: 0,
    },
  }
}

/** AnimeCard каталога → кандидат каталога */
export function cardToCandidate(card: AnimeCard): RecCandidate {
  return { ...card, genres: [], studios: [], origin: 'catalog' }
}
