# ANIME COMPANION — Аудит и архитектура (ТЗ §2, Этап 1)

Дата: 2026-10-14 · Версия базы: v1.0.32 (origin/main 1bdfac6) · Среда: Linux-песочница, Next.js dev + agent-browser (Windows EXE проверяет владелец)

## 1. Фактическая архитектура

- **Next.js 16 App Router + React 19 + TS5 + Tailwind 4 + shadcn/ui (New York)**; состояние — Zustand (`src/lib/avc/store.ts`), серверные данные — через API-роуты.
- **Electron (portable EXE)**: `electron-app/main.cjs` владеет постоянной сессией сайта; renderer работает через безопасный preload-bridge (`src/lib/avc/api.ts` — `getElectronBridge()`); AI-воркер (STT Whisper/silero VAD) — `electron-app/ai/*`, LLM/TTS удалены из релиза по решению владельца. Веб-режим — те же API-роуты без Electron-bridge.
- **Голосовой пайплайн**: ASR (`use-voice.ts` → `/api/voice/*`) → детерминированный парсер `src/lib/voice/parser.ts` (нормализация → ~25 extract-правил) → исполнитель `src/lib/avc/executor.ts` (навигация вкладок/плеера + действия аккаунта). LLM-fallback отсутствует (удалён) — только локальный парсер.
- **Сайт**: `IAnimeSiteAdapter` (`src/lib/sites/yummy/adapter.ts`) — search/anime/videos/schedule/sections/random/random-by-genre; TTL-кэши внутри адаптера. Действия аккаунта — реальные PUT/DELETE через сессию сайта (`runAccountAction`), списки библиотеки — `GET /api/users/{id}/lists/{listId}`.
- **БД**: SQLite + Prisma; миграции у пользователей — `bun run db:push` (additive-only, схемы только добавляются; подтверждено релизами v1.0.30–32 без потерь).

## 2. Переиспользуемое (уже работает)

| Существующее | Где | Использование в Companion |
|---|---|---|
| Рекомендации (объяснимый гибрид, фидбек) | `src/lib/recs/*`, `/api/recs`, вкладка `recommendations` | подраздел «Рекомендации» = ссылка на существующую вкладку |
| Порядок просмотра франшизы | `AnimeDetails.viewingOrder`, таймлайн в `anime-view.tsx` (v1.0.32) | подраздел-инструкция + голос «покажи порядок просмотра» (скролл к блоку) |
| Локальный трекинг просмотра | `WatchProgressEntry`, `watch-history.ts`, «что я смотрю» | «Моя история»: продолжить/незаконченные/остаток серий |
| Библиотека сайта (6 списков, оценки, избранное) | `yummy-store.ts`, `/api/yummy/library` (TTL 2 мин) | сигналы карты вкусов и квестов (без дублирования данных) |
| Расписание по дням | `schedule-view.tsx`, `/api/site/section/schedule` | подраздел «Календарь» = ссылка на вкладку расписания |
| Жанры каталога сайта | `/catalog/category/{slug}`, `genre-aliases.ts` (104 слага) | Компас: настроение → категория каталога |
| AniList-клиент (опц., MAL-ID матчинг) | `src/lib/recs/anilist.ts` | база для «Персонажи» (GraphQL, кэш 6 ч) |
| SkipMark/RecFeedback — образцы accountKey-моделей | `prisma/schema.prisma` | паттерн для новых таблиц |

## 3. Источники данных — проверенные факты

- **YummyAnime**: НЕ отдаёт наружу прогресс серий, персонажей, спойлер-границы, даты будущих сезонов (кроме `nextEpisodeAt` в расписании/списках). Просмотр-порядок (`viewing_order`) и расписание — есть. Жанр — только через `/catalog/category/{slug}` (по одному), в карточках жанров нет.
- **AniList GraphQL**: персонажи (`Media(idMal) → characters`), нет данных о первом появлении по эпизодам → спойлер-правило: только имена/роль/постер, описания — по явному клику с предупреждением.
- **Честный статус «нет данных»** обязателен там, где источника нет (резюме серий из проверенного контента — источника НЕТ; резюме строится ТОЛЬКО из собственных заметок пользователя).

## 4–5. Модель истории и БД

История просмотра = локальный `WatchProgressEntry` (accountKey = userId сайта или 'anon') + серверные списки (сайт = истина). Дублирования нет. **Новые таблицы (additive, безопасные дефолты):**

- `ViewerNote` — Хроники: kind `note|quote|moment|impression`, animeId/slug/title/poster/episode, text, tags (CSV), positionSec/durationSec (kind='moment' = закладка момента). Индексы `[accountKey, animeId]`, `[accountKey, kind]`. **Одна таблица на заметки+цитаты+моменты (ТЗ §19: не таблица на каждую кнопку).**
- `UserQuest` — пользовательские цели: title, metric `episodes|titles|notes|ratings|favorites`, target, archived. Статические достижения — БЕЗ таблицы (детерминированный расчёт из реальных событий при запросе).

## 6. Electron/веб-режимы

Новые функции — чистый HTTP API + UI: работают в обоих режимах без нового IPC. Голос — через существующий пайплайн. Закладка момента берёт позицию из `playback`-контекста (`store.playback`), который уже наполняется в обоих режимах (player.tsx).

## 7. Аккаунт YummyAnime

Сессия сайта (EXE — постоянная, веб — cookie-адаптер). Для Companion нужен только `accountKey` (изоляция данных) + библиотека (уже синхронизируется, TTL 2 мин). Авторизация не меняется.

## 8. Ограничения

Кросс-доменный iframe плеера — позицию внутри видео даёт только собственный `<video>`-слой приложения (player.tsx уже репортит currentTime/duration в store) — этого достаточно для закладок момента. Скриншоты кадров — НЕ реализуемо честно (CORS iframe) → закладка без скриншота.

## 9. Известные ошибки/риски

- Turbopack-кэш может выдать битую сборку после смены CSS-токенов → `rm -rf .next` при странностях (урок v1.0.32).
- Платформенные авто-коммиты могут втащить мусор — `public/releases/` в .gitignore (урок v1.0.31).
- Prisma «Engine is not yet connected» после db:push на живом dev-сервере → рестарт dev.
- tsc база: предсуществующие ошибки демо-фоллбэков адаптера — считаем дельту, не абсолют.

## 10. Архитектура новых функций

```
src/lib/companion/
  data.ts        — accountKey из сессии, нормализация NoteDto, валидация входа
  overview.ts    — агрегат для хаба (1 батч-запрос, без N+1)
  quests.ts      — детерминированные достижения из реальных событий + custom-прогресс
  taste.ts       — карта вкусов из профиля рекомендаций (реальные действия)
src/app/api/companion/
  overview/route.ts          GET
  notes/route.ts             GET (q/kind/animeId/limit/offset) POST
  notes/[id]/route.ts        PATCH DELETE
  quests/route.ts            GET POST
  quests/[id]/route.ts       DELETE (архив)
  taste/route.ts             GET
src/app/api/site/category/route.ts  GET ?genre=slug&page=N (адаптер getCategoryPage)
src/components/avc/companion-view.tsx  — вкладка kind='companion', поднавигация:
  Обзор | Компас | Хроники | Вкусы | Квесты | Персонажи (+ссылки: Рекомендации/Календарь)
```

**Контракты API (фиксируются этим документом):**

- `GET /api/companion/overview` → `{ accountKey, counts:{notes,moments,watching,unfinished,favorites,completed}, continueItem: WatchProgressItem|null, recentNotes: NoteDto[≤5] }`
- `GET /api/companion/notes?q&animeId&kind&limit&offset` → `{ items: NoteDto[], total }`; NoteDto `{ id, kind, animeId, slug, title, poster, episode, text, positionSec, durationSec, tags:string[], createdAt, updatedAt }`
- `POST /api/companion/notes` `{kind, animeId, slug, title, poster?, episode?, text(1..4000), positionSec?, durationSec?, tags?}` → `{item}` · `PATCH /[id]` `{text?, tags?, episode?, kind?}` · `DELETE /[id]` → `{ok}`
- `GET /api/companion/quests` → `{ achievements:[{id,title,description,progress,target,done}], custom:[{id,title,metric,target,progress,done}], available:boolean, reason:string|null }` (library недоступна → прогресс только по локальным данным, honest reason)
- `POST /api/companion/quests` `{title, metric, target(1..10000)}` → `{item}` · `DELETE /api/companion/quests/[id]` → `{ok}`
- `GET /api/companion/taste` → `{ available, reason, genres:[{name,count,weight,evidence[]}], studios:[{name,count,titles[]}], topRated:[{title,rating}], signalCounts:{rated,favorites,watching,completed,dropped} }` — ТОЛЬКО реальные сигналы; нет данных → пустые массивы, не выдумки
- `GET /api/site/category?genre&page` → `{ genre, title, page, totalPages, items: AnimeCard[], source }` · 404 при пустой категории
- TabKind `+ 'companion'`, payload `{ sub?: 'overview'|'compass'|'chronicles'|'taste'|'quests'|'characters', q? }`

**Новые голосовые команды (через существующий parser/executor, ТЗ §3.2):**

| Команда | Тип | Действие |
|---|---|---|
| «сохрани этот момент», «запомни этот момент» | SaveMoment | закладка позиции воспроизведения (нет playback → честный отказ) |
| «напомни, что происходило» | RecapRequest | честное резюме: последняя серия + СВОИ заметки тайтла; без выдуманных событий |
| «покажи незаконченные аниме» | ShowUnfinished | ответ списком + вкладка Companion/Обзор |
| «что выходит на этой неделе/сегодня» | (сущ. OpenSchedule + триггеры) | вкладка расписания |
| «покажи порядок просмотра» | ShowWatchOrder | скролл к таймлайну франшизы открытого аниме |
| «сколько серий осталось» | HowManyEpisodesLeft | арифметика по трекингу/total |
| «открой хроники/заметки» | OpenCompanion(sub) | вкладка Companion |
| «найди что-нибудь мрачное с сильным героем» | MoodSearch{q} | лексикон настроений → жанр-категория + компас с фильтрами |

## 11. Файлы к изменению/созданию

Создать: `src/lib/companion/{data,overview,quests,taste}.ts`, `src/app/api/companion/**` (6 роутов), `src/app/api/site/category/route.ts`, `src/components/avc/companion-view.tsx`, `tests/companion.test.ts`.
Изменить: `prisma/schema.prisma` (+2 additive), `src/lib/sites/yummy/adapter.ts` (+getCategoryPage), `src/lib/avc/types.ts` (TabKind, VoiceCommandType), `src/lib/avc/store.ts` (openCompanionTab), `src/components/avc/{tab-content,quick-sections,help-dialog}.tsx`, `src/lib/voice/parser.ts` (+правила/LABELS), `src/lib/avc/executor.ts` (+executors), `README.md`.

## 12. План тестирования и производительность

- **Baseline (зафиксирован)**: dev-сервер `/` TTFB ~0.3–0.6 c локально; главная — 2 запроса (settings+account); тесты: bun 31/31 recs, parser selftest 47/47; lint 0; tsc 0 новых. EXE-метрики (холодный старт/RAM) измеряются только на Windows — честно отмечено.
- **Правила**: новые разделы грузятся только при открытии вкладки `companion` (клиентские fetch по факту, динамических импортов сверх code-split по вкладкам не требуется — вкладка уже отдельный компонент); никаких фоновых таймеров/поллингов; кэши — только существующие (адаптер/anilist); Prisma — переиспользуемый `db`, батч-агрегаты.
- **Цели**: ответ локальных API ≤100 мс (SQLite, индексы); компас — переиспользует кэш адаптера; пересчёт квестов — только при открытии.
- **Тесты**: unit — notes CRUD-нормализация, квесты-арифметика, taste-вывод, category-парсер (мок HTML); regression — recs 31/31, parser selftest + новые пары, lint, tsc-дельта, agent-browser desktop+mobile (голос-текст обоих путей, вкладки/плеер/расписание/рекомендации не сломаны).

## Ограничения волны 1 (честно)

1. Резюме «что происходило» — только из собственных заметок + позиция просмотра (проверенного контента серий нет) — помечено в UI.
2. Персонажи — AniList MAIN-only, без описаний по умолчанию (спойлер-гвардия), требует включённого AniList и MAL-ID у тайтла; иначе «нет данных».
3. Компас — один жанр-категория за запрос (ограничение сайта), клиентские фильтры type/year/rating по текущей странице; «без жанра X» не проверяемо по данным каталога → честная пометка.
4. Кастомные квесты v1: метрики из фиксированного набора (эпизоды/тайтлы/заметки/оценки/любимые).
