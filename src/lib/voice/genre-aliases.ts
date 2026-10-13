/**
 * Словарь алиасов жанров (мастер-промпт №7): русские произношения → slug
 * каталога YummyAnime (/catalog/category/{slug}).
 * Слаги сняты с сайта (исследование Task 14-a-2, всего 104 — здесь ключевые).
 * Ключи — нормализованные (ё=е, lowercase, без пунктуации).
 */
export const GENRE_ALIASES: Record<string, string> = {
  // фэнтези
  'фэнтези': 'fentezi',
  'фентези': 'fentezi',
  'темное фэнтези': 'temnoe-fentezi',
  // экшен
  'экшен': 'ekshen',
  'экшн': 'ekshen',
  'акшен': 'ekshen',
  'боевик': 'ekshen',
  'боевые сцены': 'ekshen',
  'action': 'ekshen',
  // комедия
  'комедия': 'komediya',
  'комедийное': 'komediya',
  'комедийный': 'komediya',
  'комедии': 'komediya',
  // романтика
  'романтика': 'romantika',
  'романтическое': 'romantika',
  'романтичный': 'romantika',
  'romance': 'romantika',
  // драма
  'драма': 'drama',
  'драматическое': 'drama',
  'драматичный': 'drama',
  // ужасы
  'ужасы': 'ugasy',
  'хоррор': 'ugasy',
  'horror': 'ugasy',
  // приключения
  'приключения': 'priklyucheniya',
  'приключенческое': 'priklyucheniya',
  'adventure': 'priklyucheniya',
  // фантастика
  'фантастика': 'fantastika',
  'sci-fi': 'fantastika',
  'сайфай': 'fantastika',
  // триллер / мистика / детектив / психология
  'триллер': 'triller',
  'мистика': 'mistika',
  'мистическое': 'mistika',
  'детектив': 'detektiv',
  'психология': 'psihologiya',
  'психологическое': 'psihologiya',
  // сверхъестественное / магия
  'сверхъестественное': 'sverh-estestvennoe',
  'сверхестественное': 'sverh-estestvennoe',
  'магия': 'magiya',
  'магическое': 'magiya',
  // боевые искусства / школа / спорт / меха
  'боевые искусства': 'boevye-iskusstva',
  'школа': 'shkola',
  'школьный': 'shkola',
  'спорт': 'sport',
  'спортивный': 'sport',
  'меха': 'meha',
  // исекай / гарем
  'исекай': 'isekai',
  'исэкай': 'isekai',
  'isekai': 'isekai',
  'попаданцы': 'isekai',
  'гарем': 'garem',
  // демографические
  'сёнэн': 'senen',
  'сенен': 'senen',
  'shonen': 'senen',
  'сэйнэн': 'sejnen',
  'сейнен': 'sejnen',
  'seinen': 'sejnen',
  'сёдзё': 'sedze',
  'седзе': 'sedze',
  'сёдзе': 'sedze',
  'дзёсэй': 'dzesej',
  'джосей': 'dzesej',
  // повседневность / вампиры / демоны / драконы
  'повседневность': 'povsednevnost',
  'вампиры': 'vampiry',
  'демоны': 'demony',
  'драконы': 'drakony',
  // киберпанк / постапокалиптика / история / война
  'киберпанк': 'kiberpank',
  'постапокалиптика': 'postapokaliptika',
  'апокалипсис': 'postapokaliptika',
  'история': 'istoricheskij',
  'историческое': 'istoricheskij',
  'война': 'vojna',
  // музыка / игры / этти / космос / самураи / ниндзя / пародия
  'музыка': 'muzyka',
  'музыкальное': 'muzyka',
  'игры': 'igry',
  'этти': 'etti',
  'эччи': 'etti',
  'космос': 'kosmicheskie-priklyucheniya',
  'космическое': 'kosmicheskie-priklyucheniya',
  'самураи': 'samurai',
  'самурайское': 'samurai',
  'ниндзя': 'nindzya',
  'пародия': 'parodiya',
}

/** Русская подпись жанра для сообщений (первый алиас slug'а) */
export function genreLabel(slug: string): string {
  for (const [alias, s] of Object.entries(GENRE_ALIASES)) {
    if (s === slug) return alias
  }
  return slug
}

/** Найти жанр по произнесённому слову/фразе (точное совпадение нормализованных алиасов) */
export function resolveGenreAlias(spoken: string): string | null {
  const key = spoken.trim().toLowerCase()
  if (!key) return null
  return GENRE_ALIASES[key] ?? null
}
