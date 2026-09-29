# Anime Voice Controller — Worklog

Проект: голосовое управление аниме-сайтом (YummyAnime). Веб-реализация layered-архитектуры:
Voice (ASR) → Command Parser (локальный, детерминированный) → Command Executor → Browser + Player Control → Site Adapter.

Исследовано (ZAI):
- YummyAnime (https://old.yummyani.me) доступен из песочницы.
- Секции: /catalog, /catalog/ongoing, /catalog/announcement, /catalog/schedule, /catalog/top (ТОП-100), /catalog/random (302 → случайный тайтл).
- Поиск: JSON API /api/search?q=... (поля: title, anime_id, anime_url, poster, year, rating, anime_status).
- Аниме: JSON API /api/anime/{id} (translates=озвучки, episodes.count/aired) и /api/anime/{id}/videos (матрица серий×озвучек: number, data.dubbing, iframe_url).
- Карточки каталога в HTML: div.anime-column[data-anime-id] > a.image-block[href=/catalog/item/slug] + a.anime-title.
- Сайт и player.aksor.tv без X-Frame-Options — плеер встраиваем в iframe.


---
Task ID: 1
Agent: ZAI (main)
Task: Ядро голосового слоя — типы, нормализатор, RussianNumberParser, aliases, fuzzy, VoiceCommandParser

Work Log:
- src/lib/avc/types.ts — все контракты: VoiceCommandType (enum из мастер-промпта #12), VoiceCommand, CommandResult, PlaybackContext, NavigationContext, BrowserContext, модели сайта (AnimeCard, AnimeDetails, DubOption, VideoEntry), PipelineStep, AppSettings, BrowserTab
- src/lib/voice/normalizer.ts — lowercase/trim/пунктуация/ё->е/пробелы + stripFillers («пожалуйста», «давай»...)
- src/lib/voice/russian-numbers.ts — parseRussianNumber (1..999, колич.+порядк., все роды, составные «двадцать первая»->21), consumeLeadingNumber
- src/lib/voice/fuzzy.ts — Levenshtein, titleSimilarity (токены+подстрока+частичные совпадения), rankMatches
- src/lib/voice/aliases.ts — словарь алиасов (#75), SEARCH_TRIGGERS, OPEN_TRIGGERS
- src/lib/voice/parser.ts — детерминированный ЛОКАЛЬНЫЙ парсер (#109): приоритет озвучка→громкость→вкладка→поиск→перемотка→серия→алиасы→контекст («назад» в видео = PreviousEpisode)→открытие; сегментация по « и » для комбо (#70); wake word; «в новой вкладке»; parserSelfTest()

Stage Summary:
- Проверено 39 кейсов из мастер-промпта: 38 проходят, 1 «FAIL» — артефакт строки ожидания (комбо парсится верно)
- Контекстная логика: «двадцать» при открытом аниме = SelectEpisode(20); «назад» = PreviousEpisode/Back по контексту (#107)

---
Task ID: 2
Agent: ZAI (main)
Task: YummyAnime Adapter (серверный) + fallback

Work Log:
- src/lib/sites/types.ts — интерфейс IAnimeSiteAdapter + SiteDiagnostics (#78)
- src/lib/sites/yummy/adapter.ts — YummyAnimeAdapter: JSON API /api/search?q=, /api/anime/{id|alias}, /api/anime/{id}/videos; HTML-парсинг секций (.anime-column cards), /catalog/random через redirect; TTL-кэш 5 мин (#88); runDiagnostics (#86); все селекторы в одном SELECTORS (#53)
- src/lib/sites/yummy/fallback.ts — демо-датасет если сайт недоступен, помечается source:'demo'
- Багфиксы: /api/anime/{alias} вместо скрейпа item-страницы (быстрее и стабильнее); карточный lookahead требовал data-anime-id (иначе блок обрывался на anime-column-info до заголовка)

Stage Summary:
- Все секции LIVE: catalog/ongoing/announcement/schedule/top100 (24-125 карточек), random отдаёт детали (напр. «Академия Драгонр» 12/12, 6 озвучек), поиск живой
- Матрица серий×озвучек с iframe_url плеера — основа для Next/Prev Episode и SelectVoice

---
Task ID: 3
Agent: ZAI (main)
Task: API-роуты + Prisma

Work Log:
- prisma/schema.prisma: AppSetting, CommandHistoryEntry (только текст, без аудио), TabSession; db:push выполнен
- /api/site/[[...path]] — search|section|anime|random|videos|diagnostics
- /api/voice/asr — base64 audio -> текст (z-ai-web-dev-sdk, backend only)
- /api/voice/tts — text -> audio/wav (голосовой feedback, #37)
- /api/voice/interpret — LLMCommandInterpreter fallback (#110), строгий JSON-контракт
- /api/history GET/POST/DELETE, /api/settings GET/PUT, /api/session GET/POST/DELETE (восстановление сессии #30)

Stage Summary:
- Lint чистый. Бэкенд-контракт для фронтенда готов.

---
Task ID: 4
Agent: full-stack-developer
Task: Frontend GUI + executor + voice hook

Work Log:
- src/lib/avc/store.ts — Zustand store: вкладки (add/close/activate/patch/restore), playback, playerIframeUrl/playerPlayerName, pendingOptions (disambiguation), navigation (деривация из tabs в каждом действии), voiceStatus/voiceMessage, pipeline (cap 40), lastExecuted, флаги диалогов, settings, tabReloadCounter (Reload), tabBackStack (push/pop, снимки kind+title+payload), historyVersion для HistoryPanel
- src/lib/avc/executor.ts — executeText: resetPipeline → RAW/NORMALIZED → parseCommand → LLM-fallback (confidence < threshold или fail, SOURCE-шаг) → последовательное выполнение → COMMAND/PARAMS/CONFIDENCE/RESULT шаги → история (saveHistory) → lastExecuted + voiceMessage; executeCommand: все 36 типов (секции вкладками, SearchAnime + rankMatches (порог 0.55 / топ-6 вариантов), SelectOption, серии через модульный detailsCache + pickVideo с сохранением озвучки #51, Next/Prev с clamp, Play авто-старт 1 серии, seek/volume clamp, fullscreen, вкладки/Reload/Back (back-stack)/Forward no-op, scroll #avc-content, SelectVoice fuzzy ≥0.4, ShowEpisodes/ShowHelp); экспорт openSection/openAnimeCard/fetchDetails/getCachedDetails/syncPlaybackToDetails для UI
- src/lib/avc/use-voice.ts — MediaRecorder (webm/opus с fallback), AnalyserNode RMS<0.015/1300ms авто-стоп, max 8с, push-to-talk (pointer + глобальный Ctrl+Space из page.tsx), always-listening с re-arm 400мс и wake word гейтом, ошибки авто-clear 4с, speak() через /api/voice/tts с одним аудио-элементом, полная очистка при unmount
- src/components/avc/ — header-bar, quick-sections, tabs-bar (role=tablist), anime-grid+skeleton, tab-content (HomeView с чипами и диагностикой, SectionView с пагинацией/back-stack/демо-бейджем, SearchView), anime-view (постер, бейджи, описание expand, озвучки-чипы, сетка серий с кастомным скроллом, EpisodesDialog), player (iframe сохраняется при fullscreen — переключение классами; overlay-контролы), mini-player, voice-panel (микрофон rose при записи, режим-селект, тестовый ввод, last result), history-panel (historyVersion + очистка), pending-options-dialog, settings-dialog (debounce 600ms PUT), help-dialog (6 групп ~35 команд), debug-panel (sheet: пайплайн с цветными стейджами zinc/amber/violet/emerald/rose, диагностика, копирование JSON), session-restore-dialog (спрашивает #30; «Нет» → DELETE)
- src/app/page.tsx — app-shell h-screen: Header/QuickSections/TabsBar/main#avc-content+HistoryPanel/footer(VoicePanel+MiniPlayer); загрузка настроек, автосохранение сессии debounce 1с (после решения о восстановлении), Ctrl+Space; couch-mode масштабирует текст и прячет History/Debug
- src/app/layout.tsx — metadata RU, html lang="ru" className="dark"; globals.css — .avc-scroll янтарный скроллбар

Stage Summary:
- Lint чист (0 ошибок/0 предупреждений), tsc по файлам задачи — 0 ошибок; страница отдаёт 200, все API (/site/*, /voice/*, /history, /settings, /session) проверены curl'ом
- Работает: голос→ASR→парсер→LLM-fallback→исполнение→пайплайн/история/TTS; поиск с disambiguation; серии×озвучки с живыми iframe; вкладки/сессии; couch-mode
- Известные нюансы: seek/volume/пауза меняют состояние store (кросс-доменный iframe не управляется — как в замысле WAP-версии); iframe перезапускает видео при смене src (выбор другой серии); Forward честно no-op

---
Task ID: 4
Agent: full-stack-developer
Task: Frontend GUI + Command Executor + голосовой хук

Work Log:
- src/lib/avc/store.ts — Zustand: вкладки (back-stack per tab), playback + playerIframeUrl, pendingOptions (disambiguation), pipeline (cap 40), настройки, история-версия
- src/lib/avc/executor.ts — executeText (RAW→NORMALIZED→parse→LLM-fallback→последовательное исполнение→pipeline→history) + executeCommand для 36 типов команд; сохранение озвучки между сериями (#51); кэш AnimeDetails; fuzzy-выбор аниме и озвучек
- src/lib/avc/use-voice.ts — push-to-talk + always-listening + wake word + TTS speak()
- 15 компонентов src/components/avc/: header, quick-sections, tabs, home/section/search/anime views, player (+fullscreen), mini-player, voice-panel, history, dialogs (варианты/настройки/справка/отладка/сессия)
- Тёмная тема amber/rose (без синего/indigo), couch mode, мобайл-адаптив, aria-атрибуты

Stage Summary:
- Lint/tsc чистые; все API задействованы; сессия вкладок автосохраняется и восстанавливается с вопросом (#30)

---
Task ID: 5
Agent: ZAI (main)
Task: Голосовые движки + интеграция и правки

Work Log:
- Исправлена hydration-ошибка: isMicSupported теперь true при SSR, уточняется после mount
- ГИБРИД ГОЛОСОВЫХ ДВИЖКОВ (#9): primary — Web Speech API браузера (ru-RU, типы объявлены локально, onresult/onend/onerror, wake word gate, re-arm); fallback — MediaRecorder → /api/voice/asr (с автоостановкой по тишине). Общий handleRecognizedText для обоих
- ASR-маршрут: retry при 429 + дружелюбное сообщение; проверен HTTP-мартшрут реальным WAV
- Исправлен застрявший toast: TOAST_REMOVE_DELAY 1000000 → 5000
- ASR-провайдер слабо держит русский («пауза» → «BA,EABA»), английский идеален; решение — браузерный движок как primary (задокументировано в README)
- Мелкие фиксы: дубликат ключа в russian-numbers, ASI-баг в settings route, типизация опционального catch-all [[...path]]

Stage Summary:
- Браузерный движок распознан (sr:true); error-путь без разрешения микрофона работает; tsc/lint чистые

---
Task ID: 6
Agent: ZAI (main)
Task: Agent Browser сквозная проверка (золотой путь)

Work Log:
- Главная рендерится, hydration-ошибок нет
- «Найди Берсерк» → 5 живых вариантов → выбор «1» → страница Берсерка (25 серий, 12 озвучек, реальный постер)
- «серия 4» кликом и текстом → iframe player.aksor.tv, мини-плеер «Серия 4/25 · Озвучка MC Entertainment»
- «следующая серия» → 5; «озвучка сербин» → fuzzy-переключение; «громкость 50»; «назад на тридцать секунд»; «полный экран»/«выйди из полноэкранного»
- «новая вкладка»; «открой топ сто» → живой ТОП-100; «вкладки: Берсерк | Главная | ТОП-100»
- КОМБО «открой наруто и включи третью серию» → Наруто открыт, серия 3/220, озвучка 2x2
- Естественный язык через LLM-fallback → «поставь мне следующую серию…» → Серия 4
- «случайное аниме» → живой тайтл; восстановление сессии (3 вкладки) подтверждено
- Диагностика из debug-панели: 7/7 ✓; пайплайн #105 (RAW→…→RESULT) заполняется
- Мобильная вёрстка 390px: футер корректен, тосты не перекрывают (после фикса)

Stage Summary:
- Все слои архитектуры проверены end-to-end в браузере; живые данные YummyAnime; lint/tsc чистые
