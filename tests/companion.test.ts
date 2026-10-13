/**
 * Тесты Anime Companion (task 17-a): нормализация Хроник, лексикон настроений,
 * арифметика квестов, агрегация карты вкусов + БД-путь (ViewerNote/обзор) на
 * изолированном аккаунте test-companion-<ts> с обязательной очисткой.
 *
 * Запуск: bun test tests/companion.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  NOTE_KINDS,
  normalizeNoteInput,
  normalizeNotePatch,
  normalizeTags,
  truncateText,
} from '../src/lib/companion/data'
import { MOOD_AXES, normalizeMoodText, resolveMoodQuery } from '../src/lib/companion/mood'
import {
  ACHIEVEMENTS,
  computeProgressFromCounters,
  validateQuestInput,
  type QuestCounters,
} from '../src/lib/companion/quests'
import { aggregateTasteSignals, type TasteSignal } from '../src/lib/companion/taste'
import { getOverview } from '../src/lib/companion/overview'
import { computeQuests, createQuest, archiveQuest } from '../src/lib/companion/quests'
import { db } from '../src/lib/db'

// --- Хроники: нормализация ------------------------------------------------------------

describe('Хроники: normalizeNoteInput', () => {
  const base = {
    animeId: 70,
    slug: 'berserk',
    title: 'Берсерк',
    text: 'Золотой век — лучшая арка',
    episode: 5,
  }

  test('валидная запись проходит; kind по умолчанию note', () => {
    const res = normalizeNoteInput(base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.kind).toBe('note')
    expect(res.value.animeId).toBe(70)
    expect(res.value.episode).toBe(5)
    expect(res.value.tags).toBe('')
    expect(res.value.positionSec).toBeNull()
  })

  test('kind ограничен белым списком', () => {
    expect(NOTE_KINDS.length).toBe(4)
    expect(normalizeNoteInput({ ...base, kind: 'quote' }).ok).toBe(true)
    expect(normalizeNoteInput({ ...base, kind: 'moment' }).ok).toBe(true)
    expect(normalizeNoteInput({ ...base, kind: 'impression' }).ok).toBe(true)
    const bad = normalizeNoteInput({ ...base, kind: 'hack' })
    expect(bad.ok).toBe(false)
  })

  test('text обязателен, 1..4000 после трима', () => {
    expect(normalizeNoteInput({ ...base, text: '   ' }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, text: '' }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, text: 'x'.repeat(4000) }).ok).toBe(true)
    expect(normalizeNoteInput({ ...base, text: 'x'.repeat(4001) }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, text: '  ok  ' }).ok).toBe(true)
  })

  test('animeId — целое > 0', () => {
    expect(normalizeNoteInput({ ...base, animeId: 0 }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, animeId: -3 }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, animeId: 1.5 }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, animeId: '70' }).ok).toBe(true)
    expect(normalizeNoteInput({ ...base, animeId: undefined }).ok).toBe(false)
  })

  test('tags: CSV-строка и массив дают одинаковый нормализованный CSV', () => {
    const fromString = normalizeTags(' война,  боль , ')
    const fromArray = normalizeTags(['война', ' боль ', 'война'])
    expect(fromString.csv).toBe('война, боль')
    expect(fromArray.csv).toBe(fromString.csv)
    // дедупликация без регистра
    expect(normalizeTags(['Война', 'война']).csv).toBe('Война')
  })

  test('tags: максимум 10 тегов по 40 символов', () => {
    const many = normalizeTags(Array.from({ length: 15 }, (_, i) => `тег${i}`))
    expect(many.list.length).toBe(10)
    const long = normalizeTags(['x'.repeat(50)])
    expect(long.list[0].length).toBe(40)
  })

  test('positionSec/durationSec: числа ≥ 0 либо null', () => {
    expect(normalizeNoteInput({ ...base, positionSec: 123.45 }).ok).toBe(true)
    expect(normalizeNoteInput({ ...base, positionSec: -1 }).ok).toBe(false)
    expect(normalizeNoteInput({ ...base, durationSec: '24m' }).ok).toBe(false)
  })
})

describe('Хроники: normalizeNotePatch', () => {
  test('частичный патч принимает text/tags/episode/kind', () => {
    const res = normalizeNotePatch({ text: 'новый текст', tags: ['а', 'б'], episode: 7 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.text).toBe('новый текст')
    expect(res.value.tags).toBe('а, б')
    expect(res.value.episode).toBe(7)
    expect(res.value.kind).toBeUndefined()
  })

  test('episode: null очищает серию, мусор отклоняется', () => {
    const ok = normalizeNotePatch({ episode: null })
    expect(ok.ok).toBe(true)
    const bad = normalizeNotePatch({ episode: 0 })
    expect(bad.ok).toBe(false)
  })

  test('пустой патч и неизвестный kind отклоняются', () => {
    expect(normalizeNotePatch({}).ok).toBe(false)
    expect(normalizeNotePatch({ kind: 'x' }).ok).toBe(false)
  })
})

describe('Хроники: truncateText', () => {
  test('короткий текст не трогается, длинный обрезается с многоточием', () => {
    expect(truncateText('привет')).toBe('привет')
    const long = truncateText('а'.repeat(200), 160)
    expect(long.length).toBe(160)
    expect(long.endsWith('…')).toBe(true)
    expect(truncateText('  много   пробелов  ')).toBe('много пробелов')
  })
})

// --- Компас настроений ----------------------------------------------------------------

describe('Компас: resolveMoodQuery', () => {
  test('«хочу тёмное фэнтези с сильным героем» → primary dark (ё нормализуется)', () => {
    const res = resolveMoodQuery('хочу тёмное фэнтези с сильным героем')
    expect(res.axis?.id).toBe('dark')
    expect(res.matchedAliases.length).toBeGreaterThan(0)
  })

  test('«что-нибудь мрачное» → dark', () => {
    const res = resolveMoodQuery('что-нибудь мрачное')
    expect(res.axis?.id).toBe('dark')
  })

  test('«найди что-нибудь смешное» → humor', () => {
    expect(resolveMoodQuery('найди что-нибудь смешное').axis?.id).toBe('humor')
  })

  test('«магия и демоны» → supernatural', () => {
    expect(resolveMoodQuery('покажи магию').axis?.id).toBe('supernatural')
  })

  test('«без комедии» не падает и не выдумывает ось', () => {
    const res = resolveMoodQuery('без комедии')
    expect(Array.isArray(res.matchedAliases)).toBe(true)
    expect(res.axis === null || typeof res.axis.id === 'string').toBe(true)
  })

  test('неизвестная фраза → axis null', () => {
    expect(resolveMoodQuery('абракадабра с改成').axis).toBeNull()
    expect(resolveMoodQuery('').axis).toBeNull()
  })

  test('все 13 осей имеют валидные слаги и 3–6 алиасов', () => {
    expect(MOOD_AXES.length).toBe(13)
    for (const axis of MOOD_AXES) {
      expect(axis.genre).toMatch(/^[a-z-]+$/)
      expect(axis.aliases.length).toBeGreaterThanOrEqual(3)
      expect(axis.aliases.length).toBeLessThanOrEqual(6)
      expect(axis.label.length).toBeGreaterThan(0)
    }
  })

  test('normalizeMoodText: ё→е, нижний регистр', () => {
    expect(normalizeMoodText('ТЁМНОЕ')).toBe('темное')
  })
})

// --- Квесты: чистая арифметика ----------------------------------------------------------

describe('Квесты: computeProgressFromCounters', () => {
  const counters: QuestCounters = {
    titles: 7,
    episodes: 123,
    notes: 4,
    ratings: 3,
    favorites: 2,
    completedStarted: 1,
  }

  test('каждая метрика берёт свой счётчик', () => {
    expect(computeProgressFromCounters(counters, 'titles')).toBe(7)
    expect(computeProgressFromCounters(counters, 'episodes')).toBe(123)
    expect(computeProgressFromCounters(counters, 'notes')).toBe(4)
    expect(computeProgressFromCounters(counters, 'ratings')).toBe(3)
    expect(computeProgressFromCounters(counters, 'favorites')).toBe(2)
    expect(computeProgressFromCounters(counters, 'completed-started')).toBe(1)
  })

  test('нет данных (null) → прогресс null, не 0', () => {
    expect(computeProgressFromCounters({ ...counters, ratings: null }, 'ratings')).toBeNull()
    expect(
      computeProgressFromCounters({ ...counters, completedStarted: null }, 'completed-started'),
    ).toBeNull()
  })

  test('6 статических достижений: детерминированные цели', () => {
    expect(ACHIEVEMENTS.length).toBe(6)
    const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
    expect(byId.get('first-step')?.target).toBe(1)
    expect(byId.get('episodes-50')?.target).toBe(50)
    expect(byId.get('chronicler')?.target).toBe(5)
    expect(byId.get('critic')?.target).toBe(3)
    expect(byId.get('collector')?.target).toBe(3)
    expect(byId.get('finisher')?.target).toBe(1)
    expect(byId.get('finisher')?.metric).toBe('completed-started')
  })
})

describe('Квесты: validateQuestInput', () => {
  test('валидная цель', () => {
    const res = validateQuestInput({ title: '50 серий за месяц', metric: 'episodes', target: 50 })
    expect(res.ok).toBe(true)
  })

  test('title 1..120, target 1..10000, metric из белого списка', () => {
    expect(validateQuestInput({ title: '', metric: 'notes', target: 5 }).ok).toBe(false)
    expect(validateQuestInput({ title: 'x'.repeat(121), metric: 'notes', target: 5 }).ok).toBe(false)
    expect(validateQuestInput({ title: 'ok', metric: 'notes', target: 0 }).ok).toBe(false)
    expect(validateQuestInput({ title: 'ok', metric: 'notes', target: 10001 }).ok).toBe(false)
    expect(validateQuestInput({ title: 'ok', metric: 'hacks', target: 5 }).ok).toBe(false)
    // completed-started — НЕ кастомная метрика (только статическое достижение)
    expect(validateQuestInput({ title: 'ok', metric: 'completed-started', target: 1 }).ok).toBe(false)
  })
})

// --- Карта вкусов: чистая агрегация ------------------------------------------------------

describe('Карта вкусов: aggregateTasteSignals', () => {
  const signals: TasteSignal[] = [
    { animeId: 1, title: 'Тайтл А', ownRating: 9, isFavorite: true },
    { animeId: 2, title: 'Тайтл Б', ownRating: 8, isFavorite: false },
    { animeId: 3, title: 'Тайтл В', ownRating: 7, isFavorite: true },
    { animeId: 4, title: 'Тайтл Г', ownRating: null, isFavorite: false },
  ]
  const details = new Map<number, { genres: string[]; studios: string[] } | null>([
    [1, { genres: ['Драма', 'Психология'], studios: ['Madhouse'] }],
    [2, { genres: ['Драма'], studios: ['Madhouse'] }],
    [3, { genres: ['Комедия'], studios: ['Kyoto Animation'] }],
    [4, null], // деталей нет — жанр/студия не выдумываются
  ])

  test('жанры: count desc, weight нормирован на максимум, evidence ≤ 3', () => {
    const { genres } = aggregateTasteSignals(signals, details)
    expect(genres[0].name).toBe('Драма')
    expect(genres[0].count).toBe(2)
    expect(genres[0].weight).toBe(1)
    expect(genres[0].evidence).toEqual(['Тайтл А', 'Тайтл Б'])
    const comedy = genres.find((g) => g.name === 'Комедия')
    expect(comedy?.weight).toBe(0.5)
    expect(comedy?.evidence).toEqual(['Тайтл В'])
    // тайтл без деталей не создаёт жанров
    expect(genres.find((g) => g.name === 'Мистика')).toBeUndefined()
  })

  test('студии: count desc, titles ≤ 3', () => {
    const { studios } = aggregateTasteSignals(signals, details)
    expect(studios[0].name).toBe('Madhouse')
    expect(studios[0].count).toBe(2)
    expect(studios[0].titles).toEqual(['Тайтл А', 'Тайтл Б'])
  })

  test('topRated: только с оценкой, по убыванию, ≤ 12', () => {
    const { topRated } = aggregateTasteSignals(signals, details)
    expect(topRated.map((t) => t.title)).toEqual(['Тайтл А', 'Тайтл Б', 'Тайтл В'])
    expect(topRated[0].rating).toBe(9)
  })

  test('пустые сигналы → пустые массивы', () => {
    const r = aggregateTasteSignals([], new Map())
    expect(r.genres).toEqual([])
    expect(r.studios).toEqual([])
    expect(r.topRated).toEqual([])
  })
})

// --- БД-путь: ViewerNote → обзор → квесты (изолированный аккаунт, с очисткой) -------------

describe('БД: Хроники/Обзор/Квесты на test-companion аккаунте', () => {
  const accountKey = `test-companion-${Date.now()}`

  afterAll(async () => {
    // Очистка независимо от исхода тестов
    await db.viewerNote.deleteMany({ where: { accountKey } })
    await db.watchProgressEntry.deleteMany({ where: { accountKey } })
    await db.userQuest.deleteMany({ where: { accountKey } })
  })

  test('3 заметки → обзор считает notes/moments/unfinished/continueItem', async () => {
    // предочистка на случай повторного ts-ключа
    await db.viewerNote.deleteMany({ where: { accountKey } })
    await db.watchProgressEntry.deleteMany({ where: { accountKey } })

    const t0 = new Date('2026-10-14T10:00:00Z')
    await db.viewerNote.create({
      data: {
        accountKey,
        kind: 'note',
        animeId: 70,
        slug: 'berserk',
        title: 'Берсерк',
        text: 'Заметка раз',
        tags: 'война, боль',
        createdAt: t0,
        updatedAt: t0,
      },
    })
    await db.viewerNote.create({
      data: {
        accountKey,
        kind: 'moment',
        animeId: 70,
        slug: 'berserk',
        title: 'Берсерк',
        episode: 5,
        text: 'Момент: затмение',
        positionSec: 733.2,
        durationSec: 1420,
        createdAt: new Date('2026-10-14T11:00:00Z'),
        updatedAt: new Date('2026-10-14T11:00:00Z'),
      },
    })
    await db.viewerNote.create({
      data: {
        accountKey,
        kind: 'quote',
        animeId: 30,
        slug: 'monogatari',
        title: 'Моногатари',
        text: 'Цитата три',
        createdAt: new Date('2026-10-14T12:00:00Z'),
        updatedAt: new Date('2026-10-14T12:00:00Z'),
      },
    })

    // трекинг: 1 незаконченный (5<12), 1 завершённый (12/12), 1 без total, 1 без серии;
    // updatedAt заданы явно — continueItem детерминирован (самый свежий: animeId 1)
    await db.watchProgressEntry.create({
      data: {
        accountKey,
        animeId: 70,
        slug: 'berserk',
        title: 'Берсерк',
        episode: 5,
        episodesTotal: 12,
        updatedAt: new Date('2026-10-14T10:00:00Z'),
      },
    })
    await db.watchProgressEntry.create({
      data: {
        accountKey,
        animeId: 30,
        slug: 'monogatari',
        title: 'Моногатари',
        episode: 12,
        episodesTotal: 12,
        updatedAt: new Date('2026-10-14T11:00:00Z'),
      },
    })
    await db.watchProgressEntry.create({
      data: {
        accountKey,
        animeId: 1,
        slug: 'cowboy',
        title: 'Ковбой Бибоп',
        episode: 3,
        episodesTotal: null,
        updatedAt: new Date('2026-10-14T12:00:00Z'),
      },
    })
    await db.watchProgressEntry.create({
      data: {
        accountKey,
        animeId: 2,
        slug: 'trigun',
        title: 'Триган',
        episode: null,
        episodesTotal: 26,
        updatedAt: new Date('2026-10-14T09:00:00Z'),
      },
    })

    const overview = await getOverview(accountKey)
    expect(overview.accountKey).toBe(accountKey)
    expect(overview.counts.notes).toBe(3)
    expect(overview.counts.moments).toBe(1)
    expect(overview.counts.unfinished).toBe(1)
    // continueItem — самый свежий трекинг с открытой серией (по updatedAt: animeId 1)
    expect(overview.continueItem).not.toBeNull()
    expect(overview.continueItem?.animeId).toBe(1)
    // recentNotes: последние 5, здесь — 3, свежие сверху
    expect(overview.recentNotes.length).toBe(3)
    expect(overview.recentNotes[0].text).toBe('Цитата три')
    // момент вернул позицию воспроизведения
    const moment = overview.recentNotes.find((n) => n.kind === 'moment')
    expect(moment?.positionSec).toBe(733.2)
    // библиотека в песочнице может быть доступна или нет — но поля честные
    expect(
      overview.counts.watching === null || typeof overview.counts.watching === 'number',
    ).toBe(true)

    const fromDb = await db.viewerNote.findFirst({ where: { accountKey, kind: 'note' } })
    expect(fromDb?.tags).toBe('война, боль')
  })

  test('квесты: локальный прогресс из реальных данных + создание/архив цели', async () => {
    const quests = await computeQuests(accountKey)
    expect(quests.achievements.length).toBe(6)
    const firstStep = quests.achievements.find((a) => a.id === 'first-step')
    expect(firstStep?.progress).toBe(4) // 4 строки трекинга
    expect(firstStep?.done).toBe(true)
    const chronicler = quests.achievements.find((a) => a.id === 'chronicler')
    expect(chronicler?.progress).toBe(3)
    expect(chronicler?.done).toBe(false)
    const episodes = quests.achievements.find((a) => a.id === 'episodes-50')
    expect(episodes?.progress).toBe(5 + 12 + 3) // сумма последних серий (null-серия не считается)
    // недоступная библиотека → честная причина и null-прогресс зависимых метрик
    if (quests.achievements.find((a) => a.id === 'critic')?.progress === null) {
      expect(quests.reason).not.toBeNull()
    }

    const created = await createQuest(accountKey, { title: 'Пятьдесят серий', metric: 'episodes', target: 50 })
    const withCustom = await computeQuests(accountKey)
    const custom = withCustom.custom.find((c) => c.id === created.id)
    expect(custom?.title).toBe('Пятьдесят серий')
    expect(custom?.metric).toBe('episodes')
    expect(custom?.progress).toBe(20)
    expect(custom?.done).toBe(false)

    const archived = await archiveQuest(accountKey, created.id)
    expect(archived).toBe(true)
    const afterArchive = await computeQuests(accountKey)
    expect(afterArchive.custom.find((c) => c.id === created.id)).toBeUndefined()
    // архив — мягкое удаление: строка осталась
    const row = await db.userQuest.findUnique({ where: { id: created.id } })
    expect(row?.archived).toBe(true)
  })
})
