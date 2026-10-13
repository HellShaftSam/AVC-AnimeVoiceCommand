/**
 * Регрессионный самотест парсера серий (Task 23, спека §25–§27).
 * Запуск: bun run scripts/episode-parser-selftest.ts
 *
 * Фикстуры повторяют РЕАЛЬНЫЕ ответы old.yummyani.me (сняты при расследовании):
 *  - Naruto TV (id 111):    count=220, aired=220, метки 1..220, озвучки 2x2/Субтитры/AniDUB по 220
 *  - Shippuden (id 119):    count=500, aired=58 (ГРЯЗНОЕ поле сайта!), матрица 1..500 + «119-120», «170+171»
 *  - Ван-Пис (id 1512):     count=0 (онгоинг), aired=1180, Субтитры 1..1157, AnimeVost до 1180, спешл «1168.5»
 *
 * ВАЖНО (спека §34): в парсере НЕТ специальных случаев под тайтлы —
 * здесь проверяется, что общие правила дают правильные результаты.
 */
import {
  buildEpisodeIndex,
  episodeLabelsForDub,
  neighborEpisode,
  parseEpisodeLabel,
  parsePlacement,
  parseWatchOrder,
  pickEpisodeVariant,
  RawVideoRecord,
  RawViewingOrderEntry,
} from '../src/lib/sites/yummy/episodes'

let pass = 0
let failCount = 0
const failures: string[] = []

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failCount++
    failures.push(name)
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '')
  }
}

// --- генераторы фикстур -------------------------------------------------------

/** Глобальный счётчик videoId: как на сайте, video_id уникален для записи матрицы */
let VID = 1

function seq(from: number, to: number, dub: string, player = 'Плеер Kodik'): RawVideoRecord[] {
  const out: RawVideoRecord[] = []
  for (let n = from; n <= to; n++) {
    out.push({
      videoId: VID++,
      rawNumber: String(n),
      dubName: dub,
      playerName: player,
      iframeUrl: `//player.example/${VID}`,
      duration: 1400,
    })
  }
  return out
}

// --- 1. parseEpisodeLabel (метки сайта, §5/§9) ---------------------------------

console.log('\n[1] parseEpisodeLabel — метки без parseInt-порчи')
{
  const p1 = parseEpisodeLabel('1')
  check('plain "1" → normal 1', p1.primary === 1 && p1.kind === 'normal')
  const pr = parseEpisodeLabel('119+120')
  check('range "119+120" → primary 119, kind range', pr.primary === 119 && pr.kind === 'range')
  const pr2 = parseEpisodeLabel('119-120')
  check('range "119-120" → primary 119, kind range', pr2.primary === 119 && pr2.kind === 'range')
  const ps = parseEpisodeLabel('1168.5')
  check('special "1168.5" → primary 1168, kind special', ps.primary === 1168 && ps.kind === 'special')
  const px = parseEpisodeLabel('1 OVA')
  check('junk "1 OVA" → other (не молча normal)', px.kind === 'other')
  const pw = parseEpisodeLabel('abc')
  check('unparseable "abc" → primary null', pw.primary === null)
  const order = [parseEpisodeLabel('1168').sortKey, parseEpisodeLabel('1168.5').sortKey, parseEpisodeLabel('1169').sortKey]
  check('порядок 1168 < 1168.5 < 1169', order[0] < order[1] && order[1] < order[2], order)
}

// --- 2. Naruto TV (§26): 220 серий, озвучки не считаются сериями ----------------

console.log('\n[2] Наруто TV — 220 канонических серий, озвучки × плееры не удваивают')
{
  const records = [
    ...seq(1, 220, 'Озвучка 2x2', 'Плеер Alloha'),
    ...seq(1, 220, 'Озвучка 2x2', 'Плеер Kodik'), // 2-й плеер той же озвучки
    ...seq(1, 220, 'Субтитры'),
    ...seq(1, 220, 'Озвучка AniDUB'),
    ...seq(1, 135, 'Озвучка AniRise'),
  ]
  const idx = buildEpisodeIndex(111, records, { declaredCount: 220, releasedCount: 220 })
  check('availableCount = 220 (не 1015 записей)', idx.stats.availableCount === 220, idx.stats.availableCount)
  check('normalCount = 220', idx.stats.normalCount === 220)
  check('latestEpisodeNumber = 220', idx.stats.latestEpisodeNumber === 220)
  check('нет SUSPICIOUS_AIRED_BELOW_MAX', !idx.warnings.some((w) => w.code === 'SUSPICIOUS_AIRED_BELOW_MAX'))
  check('озвучка 2x2: 220 меток (2 плеера не удваивают)', idx.dubs.find((d) => d.name === 'Озвучка 2x2')?.labelCount === 220)
  check('озвучка AniRise: 135 меток', idx.dubs.find((d) => d.name === 'Озвучка AniRise')?.labelCount === 135)
  check('сетка озвучки 2x2 = 220 кнопок', episodeLabelsForDub(idx.episodes, 'Озвучка 2x2').length === 220)
  const pick = pickEpisodeVariant(idx, 202, null)
  check('выбор серии 202 даёт normal-вариант', pick?.episode.kind === 'normal' && pick.episode.primary === 202)
}

// --- 3. Shippuden (§26): грязное aired=58 при матрице 1..500 ---------------------

console.log('\n[3] Шиппуден — aired=58 грязный, матрица до 500 (главный баг «57–58 серий»)')
{
  const records = [
    ...seq(1, 500, 'Озвучка 2x2 New'),
    ...seq(1, 500, 'Озвучка SHIZA Project'),
    ...seq(1, 493, 'Субтитры'),
    // двухсерийники той же озвучки 2x2 New (реальная метка сайта)
    {
      videoId: 900001,
      rawNumber: '119-120',
      dubName: 'Озвучка 2x2 New',
      playerName: 'Плеер Kodik',
      iframeUrl: '//player.example/r1',
      duration: 1400,
    },
    {
      videoId: 900002,
      rawNumber: '170+171',
      dubName: 'Озвучка 2x2 New',
      playerName: 'Плеер Kodik',
      iframeUrl: '//player.example/r2',
      duration: 1400,
    },
  ]
  const idx = buildEpisodeIndex(119, records, { declaredCount: 500, releasedCount: 58 })
  check('availableCount = 502 (500 + 2 диапазона)', idx.stats.availableCount === 502, idx.stats.availableCount)
  check('latestEpisodeNumber = 500 (НЕ 58 из aired)', idx.stats.latestEpisodeNumber === 500)
  check('SUSPICIOUS_AIRED_BELOW_MAX поднят', idx.warnings.some((w) => w.code === 'SUSPICIOUS_AIRED_BELOW_MAX'))
  check('озвучка 2x2 New: 502 метки (как чип сайта «(501–502 эп.)»)', idx.dubs.find((d) => d.name === 'Озвучка 2x2 New')?.labelCount === 502)
  const pick119 = pickEpisodeVariant(idx, 119, 'Озвучка 2x2 New')
  check('голос «серия 119» → normal «119» (не диапазон)', pick119?.episode.label === '119', pick119?.episode.label)
  const next120 = neighborEpisode(idx.episodes, 119, 1, 'Озвучка 2x2 New')
  check('после 119 идёт диапазон «119-120» (порядок сайта)', next120?.label === '119-120', next120?.label)
  const next121 = neighborEpisode(idx.episodes, 120, 1, 'Озвучка 2x2 New')
  check('после 120 идёт 121', next121?.label === '121', next121?.label)
}

// --- 4. Ван-Пис (§27): онгоинг, count=0, aired=1180, Субтитры 1157, «1168.5» ----

console.log('\n[4] Ван-Пис — сетка выбранной озвучки = её покрытие (загадка «1180 vs 1157»)')
{
  const records: RawVideoRecord[] = [
    ...seq(1, 1157, 'Субтитры'), // дефолтная озвучка сайта
    ...seq(1, 1121, 'Озвучка Persona99'),
    ...seq(1, 1180, 'Озвучка AnimeVost'),
  ]
  records.push({
    videoId: 1309942,
    rawNumber: '1168.5',
    dubName: 'Озвучка AniStar',
    playerName: 'Плеер CVH',
    iframeUrl: '//player.example/sp',
    duration: 1440,
  })
  const idx = buildEpisodeIndex(1512, records, { declaredCount: null, releasedCount: 1180 })
  check('declaredCount = null (count=0 у онгоинга)', idx.stats.declaredCount === null)
  check('availableCount = 1181 (1180 + спешл 1168.5)', idx.stats.availableCount === 1181, idx.stats.availableCount)
  check('спешл не смешан с normal (specialCount=1, normalCount=1180)', idx.stats.specialCount === 1 && idx.stats.normalCount === 1180)
  check('DECLARED_COUNT_MISSING info поднят', idx.warnings.some((w) => w.code === 'DECLARED_COUNT_MISSING'))
  check('DUB_COVERAGE_GAP info поднят', idx.warnings.some((w) => w.code === 'DUB_COVERAGE_GAP'))
  const subs = episodeLabelsForDub(idx.episodes, 'Субтитры')
  check('сетка Субтитров = 1157 серий (как плеер сайта)', subs.length === 1157, subs.length)
  const animevost = episodeLabelsForDub(idx.episodes, 'Озвучка AnimeVost')
  check('сетка AnimeVost = 1180 серий (спешл 1168.5 принадлежит AniStar)', animevost.length === 1180)
  check('глобальная сетка без озвучки = 1181 меток', idx.episodes.length === 1181)
  const pickSp = pickEpisodeVariant(idx, 1168, 'Субтитры')
  check('серия 1168 в Субтитрах — normal «1168» (не «1168.5»)', pickSp?.episode.label === '1168' && pickSp.episode.kind === 'normal')
  const pickSpOnly = pickEpisodeVariant(idx, 11685 / 10, null)
  check('дробный запрос 1168.5 не находит normal (детерминизм)', pickSpOnly === null || pickSpOnly.episode.primary === 1168)
  // §29: будущая серия 1181 не в матрице — не считается доступной
  check('будущая серия 1181 отсутствует в индексе', !idx.episodes.some((e) => e.primary === 1181))
  check('select 1180 → доступен (вышел)', pickEpisodeVariant(idx, 1180, null)?.episode.label === '1180')
}

// --- 5. Дедупликация (§9) -------------------------------------------------------

console.log('\n[5] Дедупликация — identity = метка (+videoId для вариантов)')
{
  const records: RawVideoRecord[] = [
    { videoId: 1, rawNumber: '5', dubName: 'A', playerName: 'P', iframeUrl: '//x/1', duration: 1 },
    { videoId: 1, rawNumber: '5', dubName: 'A', playerName: 'P', iframeUrl: '//x/1', duration: 1 }, // дубль записи
    { videoId: 2, rawNumber: '5', dubName: 'B', playerName: 'P', iframeUrl: '//x/2', duration: 1 },
    { videoId: 3, rawNumber: '5.0', dubName: 'B', playerName: 'P', iframeUrl: '//x/3', duration: 1 }, // другая метка
  ]
  const idx = buildEpisodeIndex(1, records)
  check('две канонические серии: «5» и «5.0»', idx.episodes.length === 2, idx.episodes.map((e) => e.label))
  const ep5 = idx.episodes.find((e) => e.label === '5')
  check('у «5» ровно 2 варианта (videoId-дубль убран)', ep5?.variants.length === 2, ep5?.variants.length)
  check('availableCount = 2 (не 4 записи)', idx.stats.availableCount === 2)
}

// --- 6. Сезоны (§10/§11): записи сайта — отдельные тайтлы, не сливаются ----------

console.log('\n[6] Сезоны — Наруто и Шиппуден остаются раздельными индексами')
{
  const naruto = buildEpisodeIndex(111, seq(1, 220, 'Субтитры'), { declaredCount: 220, releasedCount: 220 })
  const shippuden = buildEpisodeIndex(119, seq(1, 500, 'Субтитры'), { declaredCount: 500, releasedCount: 58 })
  check('Naruto: 220; Shippuden: 500 — БЕЗ склейки', naruto.stats.availableCount === 220 && shippuden.stats.availableCount === 500)
  check('у индекса нет абсолютной нумерации через тайтлы (Shippuden начинается с 1)', shippuden.episodes[0].label === '1')
}

// --- 7. Нулевая/неполная доступность -------------------------------------------

console.log('\n[7] Ноль доступных серий и неполные озвучки')
{
  const empty = buildEpisodeIndex(9, [], { declaredCount: 12, releasedCount: 0 })
  check('пустая матрица → NO_VIDEOS', empty.warnings.some((w) => w.code === 'NO_VIDEOS'))
  check('availableCount = 0', empty.stats.availableCount === 0)
  const missing = buildEpisodeIndex(9, [...seq(1, 10, 'A'), { videoId: 99, rawNumber: '12', dubName: 'A', playerName: 'P', iframeUrl: '', duration: 1 }])
  check('запись без iframe не считается доступной', missing.stats.availableCount === 10, missing.stats.availableCount)
}

// --- 8. Порядок просмотра (§12/§13) ---------------------------------------------

console.log('\n[8] Порядок просмотра — отношения сайта без выдуманных номеров серий')
{
  const raw: RawViewingOrderEntry[] = [
    { anime_id: 111, anime_url: 'naruto-tv-1', title: 'Наруто', type: { shortname: 'ТВ' }, year: 2002, data: { text: 'адаптация манги', index: 0 } },
    { anime_id: 112, anime_url: 'naruto-special-1', title: 'Наруто: Спешл', type: { shortname: 'спешл' }, year: 2003, data: { text: 'дополнение', index: 1 } },
    { anime_id: 114, anime_url: 'naruto-film-pervyj', title: 'Наруто: Фильм 1', type: { shortname: 'п/ф' }, year: 2004, data: { text: 'после 101 серии', index: 2 } },
    { anime_id: 119, anime_url: 'naruto-uragannye-hroniki', title: 'Наруто: Ураганные хроники', type: { shortname: 'ТВ' }, year: 2007, data: { text: '', index: 3 } },
    { anime_id: 999, anime_url: 'sequel', title: 'Сиквел', data: { text: 'после 2 сезона', index: 4 } },
  ]
  const order = parseWatchOrder(111, raw)
  check('5 записей', order.length === 5)
  check('позиции из data.index отсортированы', order.map((o) => o.position).join(',') === '0,1,2,3,4')
  check('«после 101 серии» → afterEpisode 101', order[2].placement.mode === 'afterEpisode' && order[2].placement.episodeNumber === 101)
  check('сырой текст сохранён как есть (§14)', order[2].relationText === 'после 101 серии')
  check('«дополнение» → optional', order[1].placement.mode === 'optional')
  check('«адаптация манги» → optional', order[0].placement.mode === 'optional')
  check('пустой текст → unknown (не выдумываем)', order[3].placement.mode === 'unknown')
  check('«после 2 сезона» → afterSeason 2', order[4].placement.mode === 'afterSeason' && order[4].placement.seasonNumber === 2)
  check('тип/год проброшены для UI', order[2].type === 'п/ф' && order[2].year === 2004)
}

// --- итог -----------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`)
console.log(`ИТОГО: ${pass} PASS, ${failCount} FAIL`)
if (failCount > 0) {
  console.error('Провалены:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('SELFTEST OK')
