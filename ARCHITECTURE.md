# ARCHITECTURE — AVC-Anime

## Уровни

```
Голос (ASR: офлайн sherpa-onnx/T-One в Electron main ИЛИ браузерный WebSpeech)
   ↓ final transcript
Voice Parser (src/lib/voice/parser.ts) — русские команды → VoiceCommand[]
   ↓
Command Executor (src/lib/avc/executor.ts) — исполняет над store + REST API
   ├── Browser layer (вкладки/секции/поиск — store.ts)
   ├── Player Control (player-bridge.ts → postMessage в iframe kodik/alloha)
   └── Site Adapter (src/lib/sites/yummy/adapter.ts) — ЕДИНСТВЕННАЯ точка доступа к сайту
         ↓
API-маршруты Next.js (src/app/api/**) — тонкая обёртка адаптера + БД
   ↓
Prisma/SQLite (db/custom.db) — настройки, сессия Yummy, алиасы, история
```

## Парсер серий (Task 23) — пайплайн

```
Raw Page / API (old.yummyani.me)
   ↓  /api/anime/{id}            → детали + episodes{count,aired} + viewing_order
   ↓  /api/anime/{id}/videos     → матрица серий×озвучек×плееров (ОДИН JSON, без пагинации)
Source Extraction (adapter.fetchVideoRecords — метки КАК ЕСТЬ, без parseInt)
   ↓
parseEpisodeLabel ("1" | "1168.5" | "119+120" → primary/kind/sortKey)   [episodes.ts]
   ↓
buildEpisodeIndex → CanonicalEpisode[] (дедуп по videoId; группа по МЕТКЕ)
                   + DubCoverage[] (как чипы сайта «(N эп.)»)
                   + EpisodeStatistics (declared/released/available/latest)
   ↓
validateEpisodeData → ValidationIssue[] (SUSPICIOUS_AIRED_BELOW_MAX, MISMATCH, …)
   ↓
parseWatchOrder (viewing_order → WatchOrderEntry + placement из текста «после N серии»)
   ↓
AnimeDetails (JSON через /api/site/anime/{id|slug}) + parserVersion + fetchedAt
   ↓
Клиент: executor.episodeGrid(details, dub) → сетка ВЫБРАННОЙ озвучки (§ сайт)
   pickEpisodeVariant (normal > range > special; предпочтение озвучки)
   ↓
UI: anime-view.tsx (сетка, счётчик «Вышло X из Y», предупреждения, Порядок просмотра)
```

### Инварианты
1. **Метка (label) — идентичность серии** внутри одного тайтла. parseInt запрещён
   (1168.5→1168, «119+120»→119 — коллизии давали фантомные серии).
2. **Озвучка/плеер — варианты серии**, а не серии (220 серий × 5 озвучек = 220).
3. **`episodes.aired` сайта НЕ счётчик** (грязные данные: Шиппуден 58 при 500).
   Счётчик = `latestEpisodeNumber` из видео-матрицы; aired показывается как справка.
4. **Сетка серий = выбранная озвучка** (семантика плеера сайта); без выбора — все серии.
5. Кэш (адаптер 5 мин; клиент 5 мин) с `EPISODE_PARSER_VERSION` в ключе/записи.
6. Никаких специальных случаев под конкретные тайтлы (§34) — только общие правила.

## Voice command pipeline

```
audio → [Electron main: mic-service (capture-окно, AudioWorklet PCM16k)
         → streaming.cjs: Silero VAD → T-One CTC стриминг → partial/final]
      → preload bridge window.avcStt → use-voice.ts → handleRecognizedText
      → parser.parseCommand ( wake word / confidence / LLM-фолбэк )
      → executor.executeCommand (анти-дубль 2.5с, подтверждение озвучек)
      → history/store/pipeline-debug
```

## Electron (EXE)

- `main.cjs`: standalone Next-сервер (dist/server) на свободном порту, окно,
  splash, ретраи навигации, watchdog, adblock (webRequest) с пробой-гейтом,
  STT-сервис + mic capture-окно (localhost-страница = secure context),
  maintenance-вызов, журнал `userData/avc-main.log`.
- `speech/model-manager.cjs`: SHA-256 модели, atomic install, resume, проверка
  манифеста `speech/model-manifest.json` (T-One ~138МБ + silero_vad 643КБ).
- Сборка: `next build` (standalone) → `dist/server` → `electron-builder --win
  portable` → `public/releases/AVC-Anime-X.Y.Z-portable.exe`.
- Натив sherpa-onnx — только main-процесс, asarUnpack, НЕ входит в Next-бандл.

## Данные

- `db/custom.db` — в git НЕ хранится (сессионные cookie сайта). Восстановление:
  любая пустая SQLite создаётся `bun run db:push`.
- Модели STT — в git НЕ хранятся; URL и SHA-256 в
  `electron-app/speech/model-manifest.json`; скачиваются model-manager'ом.
