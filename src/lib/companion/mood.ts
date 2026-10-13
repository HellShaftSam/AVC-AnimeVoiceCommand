/**
 * Anime Companion — лексикон настроений («Компас», ТЗ §8).
 *
 * ЧИСТЫЙ модуль без зависимостей: импортируется и голосовым парсером
 * (task 17-c), и UI компаса (task 17-b) — менять аккуратно, контракт:
 *   resolveMoodQuery(q) → { axis: MoodAxis | null, matchedAliases: string[] }
 *
 * Каждый axis ведёт в жанр-категорию каталога сайта (/catalog/category/{slug},
 * слаги сняты с сайта) + подсказку для честного сообщения в UI/голосе.
 * Настроение ОДНО за запрос (ограничение сайта: один жанр-категория за раз).
 */

export interface MoodAxis {
  id: string
  /** Русская подпись для UI компаса */
  label: string
  /** Slug жанр-категории каталога YummyAnime */
  genre: string
  /** Смежные слаги (клиентские фильтры компаса) */
  related: string[]
  /** Честная подсказка: что именно ищет эта ось */
  hint: string
  /** Ключевые слова (3–6, нижний регистр, ё→е): подстрока/слово во фразе */
  aliases: string[]
}

export const MOOD_AXES: MoodAxis[] = [
  {
    id: 'dark',
    label: 'Мрачность',
    genre: 'temnoe-fentezi',
    related: ['ugasy', 'mistika'],
    hint: 'Тёмное фэнтези и мрачные миры',
    aliases: ['мрачное', 'мрачный', 'мрачн', 'темное', 'мрак', 'темное фэнтези'],
  },
  {
    id: 'tense',
    label: 'Напряжение',
    genre: 'triller',
    related: ['detektiv', 'psihologiya'],
    hint: 'Триллеры и детективы, держащие в напряжении',
    aliases: ['напряженное', 'напряжение', 'тревожное', 'нервное', 'саспенс', 'триллер'],
  },
  {
    id: 'adventure',
    label: 'Приключения',
    genre: 'priklyucheniya',
    related: ['fantastika'],
    hint: 'Дороги, поиски и путешествия',
    aliases: ['приключения', 'приключенческое', 'путешествия', 'авантюрное'],
  },
  {
    id: 'cozy',
    label: 'Уютная атмосфера',
    genre: 'povsednevnost',
    related: ['muzyka', 'komediya'],
    hint: 'Спокойный slice-of-life без стресса',
    aliases: ['уютное', 'уютная', 'уют', 'спокойное', 'неспешное уютное'],
  },
  {
    id: 'tragic',
    label: 'Трагичность',
    genre: 'drama',
    related: [],
    hint: 'Драмы с сильными эмоциями',
    aliases: ['трагичное', 'трагедия', 'трагическое', 'грустное', 'душераздирающее'],
  },
  {
    id: 'politics',
    label: 'Политические интриги',
    genre: 'istoricheskij',
    related: ['psihologiya'],
    hint: 'Интриги, дворы и борьба за власть',
    aliases: ['политика', 'политические', 'политические интриги', 'интриги', 'придворное'],
  },
  {
    id: 'humor',
    label: 'Юмор',
    genre: 'komediya',
    related: ['parodiya'],
    hint: 'Комедии и пародии, чтобы посмеяться',
    aliases: ['юмор', 'юморное', 'смешное', 'комедия', 'комедийное', 'веселое'],
  },
  {
    id: 'complex',
    label: 'Сложный сюжет',
    genre: 'psihologiya',
    related: ['detektiv', 'triller'],
    hint: 'Психологические головоломки и нелинейность',
    aliases: ['сложный сюжет', 'сложное', 'запутанное', 'умное', 'нелинейное'],
  },
  {
    id: 'slowburn',
    label: 'Методичный темп',
    genre: 'psihologiya',
    related: ['drama'],
    hint: 'Неспешное повествование с погружением',
    aliases: ['методичный', 'методичный темп', 'медленное', 'неспешное', 'размеренное'],
  },
  {
    id: 'growth',
    label: 'Сила героя',
    genre: 'ekshen',
    related: ['senen', 'boevye-iskusstva'],
    hint: 'Экшен про становление и прокачку героя',
    aliases: ['сильный герой', 'сильным героем', 'прокачка', 'становление', 'сила героя'],
  },
  {
    id: 'romance',
    label: 'Романтика',
    genre: 'romantika',
    related: [],
    hint: 'Чувства и отношения',
    aliases: ['романтика', 'романтическое', 'романтичный', 'любовное', 'любовь'],
  },
  {
    id: 'scale',
    label: 'Масштаб мира',
    genre: 'fantastika',
    related: ['kosmicheskie-priklyucheniya', 'isekai'],
    hint: 'Большие миры и эпичные полотна',
    aliases: ['масштаб мира', 'масштабное', 'эпическое', 'грандиозное', 'большой мир'],
  },
  {
    id: 'supernatural',
    label: 'Магия',
    genre: 'magiya',
    related: ['sverh-estestvennoe', 'demony'],
    hint: 'Магия, духи и сверхъестественное',
    aliases: ['маг', 'магическое', 'волшебное', 'сверхъестественное', 'сверхестественное', 'духи'],
  },
]

/** Нормализация слова/фразы: нижний регистр, ё→е (как в genre-aliases) */
export function normalizeMoodText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е')
}

interface NormalizedAxis {
  axis: MoodAxis
  /** Однословные алиасы — матчатся по словам запроса */
  words: string[]
  /** Многословные алиасы — матчатся подстрокой во всей фразе */
  phrases: string[]
}

const NORMALIZED_AXES: NormalizedAxis[] = MOOD_AXES.map((axis) => {
  const words: string[] = []
  const phrases: string[] = []
  for (const raw of axis.aliases) {
    const a = normalizeMoodText(raw)
    if (a === '') continue
    if (a.includes(' ')) phrases.push(a)
    else words.push(a)
  }
  return { axis, words, phrases }
})

export interface MoodQueryResult {
  /** Найденная ось (лучшая по числу совпавших алиасов, при равенстве — порядок MOOD_AXES) */
  axis: MoodAxis | null
  /** Совпавшие алиасы (нормализованные) — для честного ответа «понял настроение X по словам Y» */
  matchedAliases: string[]
}

/**
 * Разобрать фразу настроения. Матчинг — подстрока (многословные алиасы)
 * или по словам (однословные: слово начинается с алиаса либо алиас со слова,
 * для слов от 4 букв — ловит «мрачного/мрачная» через «мрачн»).
 * Ничего не нашли → axis: null (голос/UI честно попросят уточнить).
 */
export function resolveMoodQuery(q: string): MoodQueryResult {
  const norm = normalizeMoodText(String(q ?? '').trim())
  if (norm === '') return { axis: null, matchedAliases: [] }
  const words = norm.split(/[^a-zа-я0-9-]+/i).filter((w) => w.length > 0)

  let best: NormalizedAxis | null = null
  let bestAliases: string[] = []

  for (const entry of NORMALIZED_AXES) {
    const matched: string[] = []
    for (const phrase of entry.phrases) {
      if (norm.includes(phrase)) matched.push(phrase)
    }
    for (const alias of entry.words) {
      const hit = words.some(
        (w) => w.startsWith(alias) || (w.length >= 4 && alias.startsWith(w)),
      )
      if (hit) matched.push(alias)
    }
    if (matched.length === 0) continue
    // Больше совпадений = увереннее; при равенстве побеждает более ранняя ось (детерминизм)
    if (!best || matched.length > bestAliases.length) {
      best = entry
      bestAliases = matched
    }
  }

  return { axis: best ? best.axis : null, matchedAliases: bestAliases }
}
