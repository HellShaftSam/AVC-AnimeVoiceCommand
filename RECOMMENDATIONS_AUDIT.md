# RECOMMENDATIONS_AUDIT — аудит репозитория перед внедрением рекомендаций

Дата: октябрь 2026. Версия-база: v1.0.30 (коммит `06da2df`).

## 1. Подтверждённые факты (проверено по коду)

| Область | Факт | Файл |
|---|---|---|
| Архитектура | Next.js 16 App Router + Electron portable EXE + Prisma/SQLite; UI рендерится вкладками (`BrowserTab.kind`) | `src/app/page.tsx`, `src/lib/avc/store.ts` |
| Метаданные аниме | `/api/anime/{id}`: title, description, year, rating.average, genres[], studios[], episodes, type, remote_ids (MAL ID), **viewing_order** (франшиза) | `src/lib/sites/yummy/adapter.ts` |
| Поиск | `/api/search?q=` — без жанров; карточки секций (`parseCards`) — без жанров | там же |
| Секции | `/catalog`, `/catalog/ongoing`, `/catalog/announcement`, `/catalog/top`, `/catalog/schedule` (+пагинация `?page=N`, до 435 страниц) | там же |
| Аккаунт: чтение | `GET /api/users/{numericId}/lists/0..5` — списки сайта + `user.rating` (своя оценка 1..10, 0 = нет) + `user.list.is_fav` | `web-auth.ts`, `account.ts` |
| Аккаунт: действия | `PUT/DELETE /anime/{id}/list`, `/list/fav`, `/rate` — реверс бандла сайта, с reload-верификацией | `executor.ts`, `web-auth.ts` |
| Сессия | cookie сайта в БД (`yummySession`/`db/yummy-session.json`), пароли не хранятся | `session.ts`, `web-session.ts` |
| Локальный трекинг | `WatchProgressEntry` (accountKey = userId сайта или `anon`): animeId/slug/title/episode | `prisma/schema.prisma` |
| Вкладки | `kind: home \| section \| search \| anime \| help` — рекомендации не существуют | `types.ts` |
| Голос | детерминированный парсер (`src/lib/voice/parser.ts`) + `executeCommand` | — |
| Кэш адаптера | TTL 5 мин, LRU 120 записей, версия парсера в ключе | `adapter.ts` |
| Устаревший слой | `/api/library` (локальный аккаунт) — мёртвый код после перехода на thin-client; НЕ используется рекомендациями | — |

## 2. Подозрения/риски, снятые проверкой

1. **«Своя оценка = 0» с сайта** — сайт отдаёт `user.rating: 0` при отсутствии оценки. Нормализация `entryFromLibraryItem` трактует 0/вне 1..10 как `null` (никогда не «нулевая оценка»).
2. **Избранное лежит поверх списка** — `listId` и `is_fav` независимы: статус берётся из `listId`, фав даёт бонус силы (не подменяет статус).
3. **`viewing_order`** — формат проверен живым API (Наруто → 30 записей с `data.text/index`); парсер защитный.
4. **demo-fallback адаптера** — при сетевой ошибке адаптер отдаёт демо-данные (`source: 'demo'`); слой рекомендаций их отфильтровывает (`getLiveDetails` → только `live`), чтобы не выдумывать вкусы.

## 3. Недоступные данные (честно)

- **Прогресс серий с сайта** — сайт наружу не отдаёт (пишет внутри своей сессии). Используется локальный трекинг приложения как слабый сигнал.
- **Теги/темы** (AniList-style) — сайт не отдаёт; используются жанры + студии.
- **Жанры в карточках каталога** — только в деталях; кандидаты обогащаются батчами (ограниченная конкурентность + кэш 1 ч).
- **Публичного API рекомендаций у YummyAnime нет** — не предполагалось и не использовалось.

## 4. Переиспользованные сервисы

- `web-auth.fetchProfile/fetchUserList/parseLibraryItems` — чтение библиотеки.
- `YummyAnimeAdapter` (с его кэшем) — детали/секции/франшизы.
- `loadWebSession` — сессия сайта.
- `AppSetting` (key-value) — снапшот результата с фингерпринтом.
- `openAnimeCard` — открытие тайтла из рекомендаций штатной навигацией.
- `toast/sonner` + shadcn/ui — feedback UI.

## 5. План внедрения (выполнен)

1. `src/lib/recs/` — чистый движок (без DB/сети): normalize → profile → engine.
2. `/api/recs` — сбор данных (сайт + локальная БД) → кандидаты (франшизы + каталог + опц. AniList) → движок → снапшот.
3. Вкладка `recommendations` + кнопка + голосовая команда.
4. Триггеры: `bumpRecsVersion()` после подтверждённых действий аккаунта.
5. `RecFeedback` (Prisma) — «Не интересно»/«Уже видел» с отзывом.
6. bun-тесты сценариев A–J; документация; регресс UI.
