/**
 * Тесты движка рекомендаций — детерминированные синтетические фикстуры
 * (ТЗ §13, сценарии A–J). НИЧЕГО из этого не показывается пользователю:
 * это тестовые данные для проверки алгоритма, явно помечены как тест.
 *
 * Запуск: bun test tests/recommendations.test.ts
 */
import { describe, expect, test } from 'bun:test'
import {
  affinityOf,
  computeRecommendations,
  franchiseKind,
  qualityOf,
  weightedTitleSimilarity,
} from '../src/lib/recs/engine'
import { applyAnchorMetadata, buildProfile, entryFromLibraryItem } from '../src/lib/recs/profile'
import { DEFAULT_REC_SETTINGS, type RecCandidate, type RecProfileEntry } from '../src/lib/recs/types'
import type { YummyLibraryItem, YummyLibraryList } from '../src/lib/avc/types'

// --- синтетические фикстуры (ТЕСТОВЫЕ данные, не реальные) -------------------------

let idSeq = 1000
const nextId = () => ++idSeq

function libItem(partial: Partial<YummyLibraryItem> & { title: string; slug?: string }): YummyLibraryItem {
  const id = partial.animeId ?? nextId()
  return {
    animeId: id,
    slug: partial.slug ?? `test-${id}`,
    title: partial.title,
    poster: null,
    year: 2020,
    siteRating: partial.siteRating ?? 7.0,
    ownRating: partial.ownRating ?? null,
    isFavorite: partial.isFavorite ?? false,
    listId: partial.listId ?? 0,
    listTitle: null,
    animeStatus: null,
    animeStatusAlias: null,
    type: 'TV',
    nextEpisodeAt: null,
    addedAt: null,
  }
}

function listsOf(...items: YummyLibraryItem[]): YummyLibraryList[] {
  return [{ listId: 0, name: 'тест', count: items.length, items }]
}

function candidate(
  partial: Partial<RecCandidate> & { title: string },
): RecCandidate {
  const id = partial.animeId ?? nextId()
  return {
    animeId: id,
    slug: partial.slug ?? `cand-${id}`,
    title: partial.title,
    poster: null,
    year: 2021,
    rating: partial.rating ?? 7.5,
    status: null,
    type: 'TV',
    genres: partial.genres ?? [],
    studios: partial.studios ?? [],
    origin: partial.origin ?? 'catalog',
    franchiseParent: partial.franchiseParent,
  }
}

function buildEngineProfile(
  items: YummyLibraryItem[],
  progress: Array<{ animeId: number; slug: string; title: string; poster: string | null; episode: number | null }> = [],
) {
  const profile = buildProfile('777', listsOf(...items), progress, DEFAULT_REC_SETTINGS)
  const meta = new Map<number, { genres: string[]; studios: string[] }>()
  for (const it of items) {
    if (it.animeId === null) continue
    meta.set(it.animeId, {
      genres: (it as unknown as { genres?: string[] }).genres ?? [],
      studios: (it as unknown as { studios?: string[] }).studios ?? [],
    })
  }
  applyAnchorMetadata(profile, meta)
  return profile
}

const ACTION_GENRES = ['экшен', 'фэнтези', 'приключения']
const ROMANCE_GENRES = ['романтика', 'драма', 'школа']

// --- базовые единицы ---------------------------------------------------------------

describe('Базовые единицы (ТЗ §5.1)', () => {
  test('взвешенная похожесть: идентичные жанры → 1.0, разные → 0', () => {
    const a = { genres: ACTION_GENRES, studios: ['StudioX'] }
    const b = { genres: [...ACTION_GENRES], studios: ['StudioX'] }
    const c = { genres: ROMANCE_GENRES, studios: ['StudioY'] }
    expect(weightedTitleSimilarity(a, b)).toBe(1)
    expect(weightedTitleSimilarity(a, c)).toBe(0)
  })

  test('жанры без студий не обнуляют похожесть', () => {
    const a = { genres: ACTION_GENRES, studios: [] }
    const b = { genres: ACTION_GENRES, studios: ['Другая'] }
    expect(weightedTitleSimilarity(a, b)).toBeGreaterThan(0.9)
  })

  test('связь франшизы: сиквел > фильм > адаптация (по ТЗ §5.2)', () => {
    expect(franchiseKind('2 сезон')).toBe(1.0)
    expect(franchiseKind('продолжение истории')).toBe(1.0)
    expect(franchiseKind('фильм')).toBe(0.7)
    expect(franchiseKind('OVA')).toBe(0.5)
    expect(franchiseKind('адаптация манги')).toBe(0.3)
  })

  test('качество: рейтинг сайта 8.9 высоко, нет данных → нейтраль 0.5 (не негатив)', () => {
    expect(qualityOf(8.9)).toBeGreaterThan(0.9)
    expect(qualityOf(null)).toBe(0.5)
    expect(qualityOf(0)).toBe(0.5)
  })

  test('аффинитет: позитивный вектор даёт вклад, негативный штрафует слабо', () => {
    const pos = new Map([['экшен', 2], ['фэнтези', 1]])
    const neg = new Map([['романтика', 1]])
    expect(affinityOf(['экшен'], pos, neg)).toBeGreaterThan(0)
    // тайтл только с негативным жанром → 0 (жанр не отвергается целиком)
    expect(affinityOf(['романтика'], pos, neg)).toBe(0)
  })
})

// --- сценарии A–J -------------------------------------------------------------------

describe('Сценарий A — высоко оценённое избранное', () => {
  const fav = libItem({ title: 'ТЕСТ Клинок', listId: 2, ownRating: 9, isFavorite: true })
  fav.listId = 4
  const profile = buildEngineProfile([fav])
  const meta = new Map([[fav.animeId!, { genres: ACTION_GENRES, studios: ['StudioX'] }]])
  applyAnchorMetadata(profile, meta)

  const similar = candidate({ title: 'ТЕСТ Похожий клинок', genres: ACTION_GENRES, studios: ['StudioX'] })
  const unlike = candidate({ title: 'ТЕСТ Школьная романтика', genres: ROMANCE_GENRES, studios: ['StudioY'] })

  const result = computeRecommendations({
    profile,
    candidates: [
      similar,
      unlike,
      candidate({ title: 'ТЕСТ Клинок (дубль)', animeId: fav.animeId!, slug: fav.slug! }),
    ],
    settings: DEFAULT_REC_SETTINGS,
    feedbackHiddenIds: new Set(),
  })

  test('похожий кандидат получает позитивный сигнал и ранжируется выше', () => {
    const s = result.items.find((i) => i.card.title === 'ТЕСТ Похожий клинок')
    const u = result.items.find((i) => i.card.title === 'ТЕСТ Школьная романтика')
    expect(s).toBeDefined()
    expect(u).toBeDefined()
    expect(s!.components.similarity).toBeGreaterThan(0.5)
    expect(s!.score).toBeGreaterThan(u!.score)
    expect(s!.reasons.some((r) => r.includes('ТЕСТ Клинок'))).toBe(true)
  })

  test('сам тайтл A не рекомендуется (уже известен)', () => {
    expect(result.items.some((i) => i.card.animeId === fav.animeId)).toBe(false)
  })

  test('персональный режим (не холодный старт)', () => {
    expect(result.mode).toBe('personalized')
  })
})

describe('Сценарий B — Смотрю', () => {
  const watching = libItem({ title: 'ТЕСТ Смотрю сейчас', listId: 0 })
  const profile = buildEngineProfile([watching])
  applyAnchorMetadata(profile, new Map([[watching.animeId!, { genres: ACTION_GENRES, studios: [] }]]))

  test('умеренный позитив (не гарантированный фаворит)', () => {
    const anchor = profile.anchors[0]
    expect(anchor.negative).toBe(false)
    expect(anchor.strength).toBeGreaterThan(0.3)
    expect(anchor.strength).toBeLessThan(0.9)
  })

  test('сам тайтл исключён, похожие проходят', () => {
    const result = computeRecommendations({
      profile,
      candidates: [
        candidate({ title: 'ТЕСТ Похожий экшен', genres: ACTION_GENRES }),
        candidate({ title: 'ТЕСТ Смотрю сейчас (сам)', animeId: watching.animeId!, slug: watching.slug! }),
      ],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items.some((i) => i.card.animeId === watching.animeId)).toBe(false)
    expect(result.items.some((i) => i.card.title === 'ТЕСТ Похожий экшен')).toBe(true)
  })
})

describe('Сценарий C — В Планах', () => {
  const planned = libItem({ title: 'ТЕСТ В планах', listId: 1 })
  const profile = buildEngineProfile([planned])

  test('интерес-сигнал слабее, чем у смотрю', () => {
    const anchor = profile.anchors[0]
    expect(anchor.strength).toBeGreaterThan(0)
    expect(anchor.strength).toBeLessThan(0.5)
  })

  test('тайтл исключён из кандидатов', () => {
    const result = computeRecommendations({
      profile,
      candidates: [candidate({ title: 'ТЕСТ В планах (сам)', animeId: planned.animeId!, slug: planned.slug! })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items).toHaveLength(0)
  })
})

describe('Сценарий D — Брошено', () => {
  const fav = libItem({ title: 'ТЕСТ Любимый экшен', listId: 4, ownRating: 9 })
  const dropped = libItem({ title: 'ТЕСТ Брошенный экшен', listId: 3 })
  const profile = buildEngineProfile([fav, dropped])
  applyAnchorMetadata(
    profile,
    new Map([
      [fav.animeId!, { genres: ACTION_GENRES, studios: ['StudioX'] }],
      [dropped.animeId!, { genres: ACTION_GENRES, studios: ['StudioX'] }],
    ]),
  )

  const result = computeRecommendations({
    profile,
    candidates: [
      candidate({ title: 'ТЕСТ Похож на брошенный', genres: ACTION_GENRES, studios: ['StudioX'] }),
      candidate({ title: 'ТЕСТ Брошенный (сам)', animeId: dropped.animeId!, slug: dropped.slug! }),
    ],
    settings: DEFAULT_REC_SETTINGS,
    feedbackHiddenIds: new Set(),
  })

  test('брошенный исключён независимо от похожести', () => {
    expect(result.items.some((i) => i.card.animeId === dropped.animeId)).toBe(false)
    expect(result.profileSummary.excludedDropped).toBe(1)
  })

  test('жанр брошенного НЕ отвергается целиком: похожий тайтл остаётся в выдаче', () => {
    const similar = result.items.find((i) => i.card.title === 'ТЕСТ Похож на брошенный')
    expect(similar).toBeDefined()
  })

  test('франшиза брошенного не рекламируется (негативный родитель даёт 0)', () => {
    const sequelOfDropped = candidate({
      title: 'ТЕСТ Сиквел брошенного',
      genres: ACTION_GENRES,
      origin: 'franchise',
      franchiseParent: { animeId: dropped.animeId!, title: 'ТЕСТ Брошенный экшен', relation: '2 сезон', order: 2 },
    })
    const r = computeRecommendations({
      profile,
      candidates: [sequelOfDropped],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    const item = r.items[0]
    expect(item).toBeDefined()
    expect(item!.components.franchise).toBe(0)
  })
})

describe('Сценарий E — оценка ниже порога', () => {
  const fav = libItem({ title: 'ТЕСТ Фаворит', listId: 4, ownRating: 9 })
  const low = libItem({ title: 'ТЕСТ Плохой экшен', listId: 2, ownRating: 3 })
  const profile = buildEngineProfile([fav, low])

  test('ниже порога → жёсткое исключение', () => {
    const result = computeRecommendations({
      profile,
      candidates: [candidate({ title: 'ТЕСТ Плохой экшен (сам)', animeId: low.animeId!, slug: low.slug! })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items).toHaveLength(0)
    expect(result.profileSummary.excludedLowRated).toBe(1)
  })

  test('порог 4 из 10: оценка 4 проходит (настраиваемо, ТЗ §6.2)', () => {
    const rated4 = libItem({ title: 'ТЕСТ На четвёрку', listId: 2, ownRating: 4 })
    const p4 = buildProfile('777', listsOf(rated4), [], { ...DEFAULT_REC_SETTINGS, ratingThreshold: 4 })
    expect(p4.hardExcludedIds.has(rated4.animeId!)).toBe(false)
    const p5 = buildProfile('777', listsOf(rated4), [], { ...DEFAULT_REC_SETTINGS, ratingThreshold: 5 })
    expect(p5.hardExcludedIds.has(rated4.animeId!)).toBe(true)
  })

  test('жанры низкооценённого не отвергаются целиком', () => {
    applyAnchorMetadata(
      profile,
      new Map([
        [fav.animeId!, { genres: ROMANCE_GENRES, studios: [] }],
        [low.animeId!, { genres: ACTION_GENRES, studios: [] }],
      ]),
    )
    const r = computeRecommendations({
      profile,
      candidates: [candidate({ title: 'ТЕСТ Экшен-кандидат', genres: ACTION_GENRES })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(r.items).toHaveLength(1)
  })
})

describe('Сценарий F — завершено без оценки', () => {
  const completed = libItem({ title: 'ТЕСТ Завершён без оценки', listId: 2, ownRating: null })
  const profile = buildEngineProfile([completed])

  test('отсутствие оценки НЕ трактуется как 0 (не жёсткое исключение из негатива)', () => {
    expect(profile.hardExcludedIds.has(completed.animeId!)).toBe(false)
    const anchor = profile.anchors[0]
    expect(anchor.negative).toBe(false)
    expect(anchor.strength).toBeGreaterThan(0)
    expect(anchor.strength).toBeLessThan(0.5) // слабый сигнал
  })

  test('тайтл исключён как известный; завершение — слабый позитив для похожих', () => {
    const result = computeRecommendations({
      profile,
      candidates: [candidate({ title: 'ТЕСТ Завершён (сам)', animeId: completed.animeId!, slug: completed.slug! })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items).toHaveLength(0)
  })
})

describe('Сценарий G — смена оценки с высокой на низкую', () => {
  const item = libItem({ title: 'ТЕСТ Переоценённый', listId: 2, ownRating: 9 })

  test('было: позитивный якорь, в сиквелах участвует', () => {
    const before = buildProfile('777', listsOf(item), [], DEFAULT_REC_SETTINGS)
    expect(before.hardExcludedIds.has(item.animeId!)).toBe(false)
    expect(before.franchiseParents.has(item.animeId!)).toBe(true)
  })

  test('стало (3/10): негативный якорь, позитивное влияние убрано', () => {
    const rated3 = { ...item, ownRating: 3 }
    const after = buildProfile('777', listsOf(rated3), [], DEFAULT_REC_SETTINGS)
    expect(after.hardExcludedIds.has(item.animeId!)).toBe(true)
    expect(after.franchiseParents.has(item.animeId!)).toBe(false)
    expect(after.anchors[0].negative).toBe(true)
  })

  test('пересчёт по данным после подтверждённого изменения (детерминирован)', () => {
    const rated3 = { ...item, ownRating: 3 }
    const after = buildProfile('777', listsOf(rated3), [], DEFAULT_REC_SETTINGS)
    const result = computeRecommendations({
      profile: after,
      candidates: [candidate({ title: 'ТЕСТ Переоценённый (сам)', animeId: item.animeId!, slug: item.slug! })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items).toHaveLength(0)
  })
})

describe('Сценарий H — дубликаты и альтернативные записи', () => {
  const fav = libItem({ title: 'ТЕСТ Фаворит', listId: 4, ownRating: 9 })
  const profile = buildEngineProfile([fav])

  test('дубль слага удаляется, счётчик растёт; разные сезоны НЕ сливаются', () => {
    const result = computeRecommendations({
      profile,
      candidates: [
        candidate({ title: 'ТЕСТ Кандидат', slug: 'same-slug', animeId: 501 }),
        candidate({ title: 'ТЕСТ Кандидат (другой id, тот же слаг)', slug: 'same-slug', animeId: 502 }),
        candidate({ title: 'ТЕСТ 1 сезон', slug: 'season-1', animeId: 503 }),
        candidate({ title: 'ТЕСТ 2 сезон', slug: 'season-2', animeId: 504 }),
      ],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.profileSummary.duplicatesRemoved).toBe(1)
    const titles = result.items.map((i) => i.card.title)
    expect(titles).toContain('ТЕСТ 1 сезон')
    expect(titles).toContain('ТЕСТ 2 сезон') // разные работы не сливаются
  })
})

describe('Сценарий I — холодный старт', () => {
  const result = computeRecommendations({
    profile: buildProfile('777', listsOf(), [], DEFAULT_REC_SETTINGS),
    candidates: [candidate({ title: 'ТЕСТ Популярный', rating: 8.4 })],
    settings: DEFAULT_REC_SETTINGS,
    feedbackHiddenIds: new Set(),
  })

  test('режим discovery, явная метка, предпочтения не выдумываются', () => {
    expect(result.mode).toBe('discovery')
    expect(result.message).toBeTruthy()
    expect(result.message).toContain('Мало данных')
    const item = result.items[0]
    expect(item!.discovery).toBe(true)
    expect(item!.components.similarity).toBe(0)
    expect(item!.components.affinity).toBe(0)
  })
})

describe('Сценарий J — гость/выход из аккаунта', () => {
  const result = computeRecommendations({
    profile: buildProfile(null, listsOf(libItem({ title: 'ТЕСТ Чужой тайтл', listId: 4, ownRating: 9 })), [], DEFAULT_REC_SETTINGS),
    candidates: [candidate({ title: 'ТЕСТ Что-то' })],
    settings: DEFAULT_REC_SETTINGS,
    feedbackHiddenIds: new Set(),
  })

  test('нет аккаунта → никаких «персональных» данных, честное сообщение', () => {
    expect(result.mode).toBe('logged-out')
    expect(result.items).toHaveLength(0)
    expect(result.message).toContain('Войдите')
  })

  test('нормализация: своя оценка 0 с сайта = «нет оценки» (не ноль)', () => {
    const e = entryFromLibraryItem(libItem({ title: 'X', ownRating: 0, listId: 2 }))
    expect(e!.ownRating).toBeNull()
    const e2 = entryFromLibraryItem(libItem({ title: 'X', ownRating: 7, listId: 2 }))
    expect(e2!.ownRating).toBe(7)
  })
})

describe('Фильтрация ДО ранжирования и обратная связь (ТЗ принципы)', () => {
  const fav = libItem({ title: 'ТЕСТ Фаворит', listId: 4, ownRating: 10 })
  const profile = buildEngineProfile([fav])

  test('«Не интересно» скрывает тайтл, даже если он самый похожий', () => {
    const perfect = candidate({ title: 'ТЕСТ Идеальное совпадение', genres: ACTION_GENRES, rating: 9.5 })
    const result = computeRecommendations({
      profile,
      candidates: [perfect],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set([perfect.animeId]),
    })
    expect(result.items).toHaveLength(0)
    expect(result.profileSummary.excludedFeedback).toBe(1)
  })

  test('excludeKnown=false НЕ спасает брошенное (вето сильнее настройки)', () => {
    const dropped = libItem({ title: 'ТЕСТ Брошено', listId: 3 })
    const p = buildEngineProfile([fav, dropped])
    const result = computeRecommendations({
      profile: p,
      candidates: [
        candidate({ title: 'ТЕСТ Брошено (сам)', animeId: dropped.animeId!, slug: dropped.slug! }),
        candidate({ title: 'ТЕСТ Фаворит (сам)', animeId: fav.animeId!, slug: fav.slug! }),
      ],
      settings: { ...DEFAULT_REC_SETTINGS, excludeKnown: false },
      feedbackHiddenIds: new Set(),
    })
    expect(result.items.some((i) => i.card.animeId === dropped.animeId)).toBe(false)
    expect(result.items.some((i) => i.card.animeId === fav.animeId)).toBe(true)
  })

  test('детерминизм: одинаковый вход → одинаковый выход', () => {
    const cands = [
      candidate({ title: 'ТЕСТ A', genres: ACTION_GENRES, rating: 8.0 }),
      candidate({ title: 'ТЕСТ B', genres: ACTION_GENRES, rating: 7.0 }),
      candidate({ title: 'ТЕСТ C', genres: ROMANCE_GENRES, rating: 9.0 }),
    ]
    const run = () =>
      computeRecommendations({ profile, candidates: cands, settings: DEFAULT_REC_SETTINGS, feedbackHiddenIds: new Set() })
      .items.map((i) => `${i.card.animeId}:${i.score}`)
    expect(run()).toEqual(run())
  })

  test('локальный прогресс без записи на сайте — известный тайтл', () => {
    const p = buildProfile('777', listsOf(), [{ animeId: 900, slug: 'watched-locally', title: 'ТЕСТ Локальный', poster: null, episode: 5 }], DEFAULT_REC_SETTINGS)
    expect(p.knownIds.has(900)).toBe(true)
    const result = computeRecommendations({
      profile: p,
      candidates: [candidate({ title: 'ТЕСТ Локальный (сам)', animeId: 900, slug: 'watched-locally' })],
      settings: DEFAULT_REC_SETTINGS,
      feedbackHiddenIds: new Set(),
    })
    expect(result.items).toHaveLength(0)
  })
})
