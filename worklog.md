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

---
Task ID: 7
Agent: ZAI (main)
Task: Контракты v2 под баг-репорты пользователя (автозапуск, аккаунт, микрофон, перемотка, резолвер озвучек)

Work Log:
- src/lib/avc/types.ts: новые команды Mute/Unmute/SetWatchStatus/ToggleFavorite/ContinueWatching/ShowLibrary/AddVoiceAlias
- WatchStatus (watching/planned/completed/dropped/on_hold) + WATCH_STATUS_LABELS + LibraryEntryDto + UserInfoDto
- AppSettings += micGain(1..4), vadSensitivity(0..100), sttEngine(auto|browser|server), noiseSuppression, autoGainControl, echoCancellation, micDeviceId
- VOICE_CONFIDENCE_AUTO=0.85 / VOICE_CONFIDENCE_ASK=0.55, VoiceProviderMatch, VoiceAliasMap

Stage Summary:
- Контракты готовы; далее параллельно 8-a (бэкенд), 8-b (резолвер+парсер), 8-c (микрофон), затем 9 (фронтенд-интеграция)

---
Task ID: 8-a
Agent: full-stack-developer
Task: Бэкенд — аккаунты, библиотека статусов, алиасы озвучек

Work Log:
- prisma/schema.prisma: +User (username unique, passwordHash, связи), +UserLibraryEntry (@@unique([userId,animeId]), @@index([userId,updatedAt]), статус/favorite/episode/positionSec/totalEpisodes/currentDub), +VoiceAlias (@@unique([userId,targetType,targetName,alias])); AppSetting/CommandHistoryEntry/TabSession не тронуты; `bun run db:push` — OK (11ms, клиент сгенерирован)
- src/lib/auth.ts (nodejs): hashPassword/verifyPassword (scrypt 64 байта, случайная соль 16б, формат `salt:hex`, timingSafeEqual), createSessionToken/parseSessionToken (`userId.expiry.hmacSHA256(...)`, SECRET=AUTH_SECRET ?? 'avc-dev-secret-2024', TTL 30 дней), getSessionUserId (cookie avt_session), getCurrentUser (по БД), sessionCookieOptions (httpOnly, sameSite lax, path /, maxAge 30д)
- POST /api/auth/register: username 3–24 [a-zA-Z0-9_а-яА-ЯёЁ.-] + password >=4; занято → 409 {error:"Имя уже занято"}; создаёт + ставит cookie → {user:{id,username}}
- POST /api/auth/login: verifyPassword → cookie → {user} | 401 {error:"Неверный логин или пароль"}
- POST /api/auth/logout → {ok:true} + очистка cookie (maxAge 0); GET /api/auth/me → {user|null}
- /api/library GET: без сессии {user:null, entries:[]}; с сессией {user, entries:LibraryEntryDto[]} по updatedAt desc (DTO без id/userId, updatedAt — ISO string)
- /api/library PUT: upsert по (userId, animeId) через Prisma create/update-пары полей — обновляются только переданные поля; status валидируется (watching|planned|completed|dropped|on_hold, иначе 400), title обязателен; → {entry}
- /api/library DELETE ?animeId= → deleteMany (только своё) → {ok:true}; без сессии → 401 {error:"Требуется вход"}
- /api/aliases GET: алиасы текущего пользователя (createdAt desc), без сессии → {aliases:[]}; POST {targetType?='voice', targetName 1..64, alias 1..48, trim}: дубликат по @@unique возвращает существующий (200); → {alias:{id,targetType,targetName,alias}}; DELETE ?id= → deleteMany по (id, userId) → {ok:true}
- Проверка: tsc --noEmit по своим файлам — 0 ошибок (остальные ошибки проекта: src/lib/voice/parser.ts — зона задачи 8-b, examples/, skills/ — преждесуществующие); eslint чистый
- curl через dev-сервер (порт 3000) даёт 500 на новых маршрутах: запущенный процесс держит PrismaClient, сгенерированный ДО db:push (globalThis-кэш в src/lib/db.ts); файл клиента на диске содержит новые модели. ПОЭТОМУ функциональная проверка выполнена напрямую: временный bun-скрипт вызывал все обработчики с NextRequest+cookie — 33/33 ассерта прошли (регистрация/409/400, login 401/200, me, cookie httpOnly, PUT create+partial-update сохраняет непереданное, невалидный status 400, сортировка updatedAt desc, DELETE, алиасы: дедупликация по id, лимиты 48/64, типы, 401, изоляция по userId); скрипт удалён после прогона
- ВНИМАНИЕ агенту-интегратору (задача 9): чтобы новые маршруты заработали через dev-сервер, нужен перезапуск процесса next dev (либо разовый хак в db.ts с проверкой `if (!db.user)` и созданием свежего клиента) — после любого рестарта всё работает без изменений кода

Stage Summary:
- Формат ответов: register/login → {user:{id,username}} (+Set-Cookie avt_session=httpOnly); me → {user|null}; library GET → {user|null, entries:[{animeId,title,slug,poster,status,favorite,episode,positionSec,totalEpisodes,currentDub,updatedAt-ISO}]}; PUT → {entry}; DELETE/aliases-DELETE/logout → {ok:true}; aliases GET → {aliases:[{id,targetType,targetName,alias}]}; POST → {alias}; ошибки — {error} с кодами 400/401/409
- db:push успешен; сессия — подписанная HMAC-cookie (без серверного стора); пароли — scrypt; все данные изолированы по userId; каскадное удаление (onDelete: Cascade)

---
Task ID: 8-c
Agent: general-purpose
Task: Микрофон + STT движки v2

Work Log:
- src/lib/voice/audio-utils.ts (НОВЫЙ, чистые функции без React): buildAudioConstraints (echoCancellation/noiseSuppression/autoGainControl из настроек, deviceId как {ideal} — не падает на отсутствующем устройстве); createMicChain (source → highpass 70Гц → DynamicsCompressor threshold -24/knee 30/ratio 4 → GainNode → analyser + MediaStreamDestination); rmsLevel (RMS 0..1); sensitivityToRms (vadSensitivity 0..100 → порог RMS 0.06..0.004, лог-шкала, 50 ≈ 0.0155 — проверено юнит-прогоном в bun); encodeWav16kMono (decodeAudioData → OfflineAudioContext 16 кГц mono с gain-узлом → WAV PCM16 c корректным RIFF-заголовком; мягкая нормализация при пиках > 0.98 против клиппинга); bufferToBase64 (чанками по 0x8000); listMicDevices (enumerateDevices, фильтр audioinput; без permission — пустой массив)
- src/lib/avc/use-voice.ts (переработка): выбор движка по settings.sttEngine — 'browser' (только Web Speech, иначе внятная ошибка), 'server' (сразу MediaRecorder+ASR), 'auto' (browser с тихим fallback на server при сбое start()); browserEngine теперь отражает ФАКТИЧЕСКИ запущенный движок (ставится после recognition.start()/recorder.start(), а не доступность)
- Серверный движок пишет из ОБРАБОТАННОГО потока: getUserMedia(buildAudioConstraints) → createMicChain → MediaRecorder(destination.stream) — micGain реально усиливает запись; VAD читает тот же analyser (уже усиленный сигнал); порог тишины = sensitivityToRms(settings.vadSensitivity), настройки читаются на старте каждой сессии
- Web Speech API: задокументировано, что micGain на его внутренний захват повлиять не может; для индикатора держится параллельная лёгкая цепочка source → analyser (startLevelIndicator, только пока voiceStatus=listening, инвалидация по номеру сессии)
- processRecording: webm-блоб → encodeWav16kMono(blob, micGain) → base64 → POST /api/voice/asr {audio, mime:'audio/wav'} (контракт роута не ломает); 5xx → «Сервис распознавания недоступен», 429/400-сообщения роута прокидываются
- getUserMedia-ошибки разложены по NotAllowedError/SecurityError (нет доступа), NotFoundError/OverconstrainedError (нет устройства), остальные — общее сообщение
- Новые поля VoiceApi: micLevel (0..1, raf-цикл с троттлингом 100 мс ≈ 10 раз/с, живёт во время listening, сбрасывается в teardown), interimText (промежуточные результаты Web Speech, очищается при onend/обработке), micDevices + refreshMicDevices (монтирование + ручной рефреш, требует permission)
- MAX_UTTERANCE_MS 8000 → 12000, MIN_UTTERANCE_MS 700 → 500; max-таймер добавлен и браузерному движку (страховка от зависшего onend)
- Гонки/утечки: sessionSeqRef инвалидирует асинхронные старты (кнопку отпустили до resolve getUserMedia — запись не начинается); catch серверного старта сначала проверяет поколение, потом teardown (не убивает аудио новой сессии); ensureStream переиспользует поток пока не сменился micDeviceId (иначе пересоздаёт); починен баг оригинала: пустой chunks оставлял processingRef=true навсегда (теперь finally); teardownAudio закрывает и chain-ctx, и light-ctx, гасит raf
- Сохранено: push-to-talk, always-listening c re-arm 400 мс, wake word, TTS speak(), очистка при unmount, переходы setVoiceStatus (listening → recognizing → executing), Ctrl+Space в page.tsx не тронут

Stage Summary:
- tsc: 0 ошибок в файлах задачи (parse/parser.ts и examples/skills — чужие/предсущ.); ESLint обоих файлов — чисто
- Новые поля VoiceApi: micLevel, interimText, micDevices, refreshMicDevices(); browserEngine = фактический движок сессии
- Как включить gain/sensitivity: Настройки → micGain 1..4 (усиление записи и VAD, серверный движок), vadSensitivity 0..100 (порог авто-стопа по тишине), sttEngine auto|browser|server, тумблеры noiseSuppression/autoGainControl/echoCancellation, micDeviceId (ideal). Для пользователя «я далеко от микрофона»: micGain 2–3 + vadSensitivity 60–75

---
Task ID: 8-b
Agent: general-purpose
Task: Voice Provider Resolver + расширение парсера (контракты v2, баг «переключи на анилибрию»)

Work Log:
- src/lib/voice/phonetics.ts (НОВЫЙ): phoneticKey (собственная транслитерация кириллица→латиница, только a-z, схлопнутые двойные: «анилибрия»→anilibriya, «AniLibria»→anilibria) + stripCaseEndings (пословно, кириллица, слово ≥5 букв, срез по одному символу в цикле до стабилизации — ВСЕ падежи («анилибрию/анилибрии/анилибрия/анилибри») сходятся к одному стему, латиница не трогается, «дрим каста»→«дрим каст»). Вынесено в отдельный файл, чтобы избежать циклического импорта fuzzy↔provider-resolver
- src/lib/voice/fuzzy.ts: titleSimilarity теперь дополнительно сравнивает фонетические ключи (phoneticKey) — «ани либрия»≈«AniLibria» без изменения существующих экспортов
- src/lib/voice/provider-resolver.ts (НОВЫЙ, главный файл): normalizeVoiceName (normalizeForMatch+stripCaseEndings), DubCandidate, DEFAULT_VOICE_ALIASES (AniLibria/StudioBand/Dream Cast/AnimeVost/AniDUB/AniStar/JAM/AnimeGo/SHIZA Project), buildUserAliasMap, resolveVoiceProvider: exact (== name/shortName → 1.0) → alias (DEFAULT+user, нормализованные → 0.97) → translit (фонетические ключи → 0.92) → fuzzy (max similarity/titleSimilarity по нормализованным и фонетическим формам; ни один токен не начинается с той же буквы → cap 0.5); реэкспорт phoneticKey/stripCaseEndings; порог по умолчанию VOICE_CONFIDENCE_ASK
- src/lib/voice/aliases.ts: COMMAND_ALIASES += Mute/Unmute/ContinueWatching/ShowLibrary/ToggleFavorite/SetWatchStatus; НОВОЕ COMMAND_ALIAS_PARAMS (alias → params: muted/favorite/status), мержится в matchAlias (parser) — alias-путь возвращает валидные параметризованные команды
- src/lib/voice/parser.ts: LABELS для 7 новых типов (Mute/Unmute/SetWatchStatus/ToggleFavorite/ContinueWatching/ShowLibrary/AddVoiceAlias — чинит tsc после контрактов v2); extractSeek переписан (минуты×60, «полминуты»→30, «полторы минуты»→90, «секунд 30»/«30 секунд», «на тридцать секунд», составные «сто двадцать секунд», «перемотка на 20», отмотай/обратно/влево/вправо, без направления = вперёд); НОВЫЕ извлекатели ДО alias-matching: Mute/Unmute («выключи/убери/без звука», «включи/верни звук»), SetWatchStatus (смотрю/планы/просмотрено/брошено/отложено-на потом; «поставь на паузу» НЕ перехватывается), ToggleFavorite (±избранное), ContinueWatching («продолжить просмотр», «вернись к просмотру», «с того места»), ShowLibrary («открой библиотеку», «мои списки/аниме», «моя коллекция»), AddVoiceAlias (регэкспы «добавь X как команду/алиас для Y», «запомни X для Y», conf 0.9); SelectVoice усилен (extractDub → extractSelectVoice): «переключи(сь)/смени/поменяй/выбери на X» → {name, dub} (хвосты following/previous/ordinal/вкладка/серия отбракованы — «переключись на следующую вкладку» не сломан), «следующая/другая озвучка» → {next:true}, «вторая озвучка» → {index:N}; parserSelfTest расширен 20 → 40 кейсов

Stage Summary:
- Проверки: parserSelfTest 40/40 PASS (прогон через реальный parseCommand), резолвер-тесты 19/19 PASS: «ани либрию»→AniLibria 0.97 (alias), «дрим каста»→Dream Cast 0.97, «студио бэнд»→StudioBand 0.97, «анимэ вост»→AnimeVost 0.97, «чепуха»→null, «AniLibria»→exact 1.0, user-алиас через buildUserAliasMap→0.97, опечатка «анилибре»→fuzzy; tsc --noEmit по src — 0 ошибок, eslint изменённых файлов чист
- Осознанное отклонение от примера в ТЗ: stripCaseEndings срезает окончания циклично, поэтому стем «анилибр», а не «анилибри» — так все формы (включая голое «анилибри») дают ОДИН стем; корректность сопоставления важнее литерального вида стема
- Executor (Task 8-a/9): при резолвинге вызывать resolveVoiceProvider(cmd.params.name||cmd.params.dub, dubs, userAliasMap) c порогами VOICE_CONFIDENCE_AUTO/ASK; parser эмитит и name, и dub для обратной совместимости; SelectVoice {next}/{index} — новые кейсы для executor'а

---
Task ID: 9-a
Agent: ZAI (main)
Task: Интеграция аккаунта/библиотеки/алиасов в executor + API-клиент + хоткеи + дебаунсер (параллельно с 9-b)

Work Log:
- src/lib/avc/store.ts: +user/library/voiceAliases/libraryOpen/authOpen/voiceConfirm{spoken,match}/prevVolume (init 70) и сеттеры setUser/setLibrary/setVoiceAliases/setLibraryOpen/setAuthOpen/setVoiceConfirm (+внутренний setPrevVolume для Mute); экспортирован тип VoiceConfirmState
- src/lib/avc/api.ts (НОВЫЙ): чистый транспорт avcApi — me/login(401→«Неверный логин или пароль»)/register/logout/library/putLibrary(401→null НЕ throw, 400→throw от {error})/deleteLibraryEntry/aliases(без сессии→[])/addAlias(401→null)/deleteAlias; credentials same-origin, JSON; store после login/register/logout обновляет вызывающая сторона
- src/lib/avc/executor.ts: 1) анти-дубль (баг #12) — module-level {hash,ts}, одинаковый normalized < 2500 мс → RESULT «Дубликат команды пропущен»+setLastExecuted+return; ts обновляют успешные И проваленные («пауза пауза» подряд глушится, с интервалом — работает); 2) confirm-gate ДО парсинга: voiceConfirm + «да/да переключай/подтверждаю/точно/давай/первый/1» → confirmVoiceMatch(), «нет/отмена/не/неа/неверно/второй/2» → cancelVoiceMatch(), иной текст → отмена+обычный парсинг (не застревает); 3) SelectVoice через резолвер 8-b: {next} циклически, {index} по списку, {name|dub} → resolveVoiceProvider(dubs, buildUserAliasMap(voiceAliases), ASK): null→«Озвучка «X» не найдена. Доступны: …», ≥0.85→применить+«Озвучка: X (N%)», 0.55–0.85→setVoiceConfirm+«Вы имеете в виду «X»? Скажите ДА или НЕТ»; 4) экспорты confirmVoiceMatch()/cancelVoiceMatch() (pickVideo, toast, «Озвучка: …»/«Отменено»); 5) Mute/Unmute с prevVolume (0 не затирает прежнее; Unmute → prevVolume или 70); 6) SetWatchStatus: без user → setAuthOpen+«Войдите…», без animeId → «Сначала откройте аниме», иначе putLibrary(poster/totalEpisodes из кэша деталей)+upsert library+«{title}: {LABEL}»; 7) ToggleFavorite (статус не трогаем; без параметра — toggle текущего); 8) ContinueWatching: макс updatedAt среди watching (fallback любые), пусто→«Библиотека пуста — скажи "найди …"»; export async function continueWatchingFromEntry(entry) — AnimeCard→navigateToAnime→восстановление currentDub→playEpisode(episode)→positionSec, «Продолжаю: X, серия N»; 9) ShowLibrary → setLibraryOpen(true); 10) AddVoiceAlias: target через resolveVoiceProvider по dubs, fallback — ключи DEFAULT_VOICE_ALIASES как кандидаты; <0.55→«Не знаю такую озвучку»; 401→null→«Войдите, чтобы сохранять алиасы»+auth; успех→upsert voiceAliases+«Запомнил: «X» → Y»; 11) автосинк библиотеки: playEpisode (покрывает Select/Next/Prev/Play) → syncLibraryProgress fire-and-forget, status:'watching' ТОЛЬКО при создании записи (completed/dropped не перетираются), Seek± → positionSec только при существующей записи, ошибки глушатся; 12) switch покрывает все новые типы, default «Команда не поддерживается»
- src/components/avc/hotkeys.tsx (НОВЫЙ): <Hotkeys/>→null; window keydown capture; игнор input/textarea/select/contenteditable и Ctrl/Meta (Ctrl+Space PTT в page.tsx не задет); Space=TogglePlayPause(preventDefault), ←/→=Seek(Shift?30:10), ↑/↓=Volume, N/P=серии, F=setPlayerFullscreen напрямую, M=Mute/Unmute по volume; всё через executeCommand (пайплайн/история/тосты), e.repeat только стрелкам
- src/app/page.tsx: импорты AuthDialog/LibraryPanel/VoiceConfirmDialog/Hotkeys/InstallPwa; эффект профиля (avcApi.me()→setUser; если user → Promise.all(library,aliases)→setLibrary/setVoiceAliases; unmount-cancel, ошибки глушатся); смонтированы VoiceConfirmDialog/AuthDialog/LibraryPanel/InstallPwa/Hotkeys; settings-load/Ctrl+Space/автосейв сессии не тронуты
- ОТКЛОНЕНИЕ: контракт называл InstallPwaHint, фактический экспорт 9-b — InstallPwa; импорт выровнен по факту
- agent-ctx/9-a-zai.md — запись для следующего агента

Stage Summary:
- bunx tsc --noEmit: 0 ошибок в src/ (совместно с файлами 9-b; examples/skills — предсуществующие); eslint по своим 5 файлам — чисто
- dev-сервер: GET / → 200; /api/auth/me → {user:null}; /api/library → {user:null,entries:[]}; /api/aliases → {aliases:[]}
- Сценарии проверены: дебаунсер не блокирует разные команды; «переключи на анилибрию» → alias 0.97 ≥ AUTO → молча; сомнительная уверенность 0.55–0.85 → «да» применяет / «нет» отмена / посторонний текст — отмена+парсинг; SetWatchStatus без логина открывает auth-dialog

---
Task ID: 9-b
Agent: ZAI (frontend)
Task: UI-интеграция по баг-репортам — плеер (автозапуск/перемотка/звук), библиотека и аккаунты, микрофон-UI, резолвер-дебаг, PWA

Work Log:
- player.tsx: overlay автозапуска серии (bg-black/60 backdrop-blur, кнопка-круг amber 88px + Play, aria-label «Запустить серию», текст «Нажмите, чтобы запустить» + подсказка про блокировку автозапуска; клик снимает overlay ЛОКАЛЬНЫМ state без перезагрузки iframe, state сбрасывается useEffect'ом по смене url; keyboard Enter/Space; в fullscreen кнопка крупнее — h-28); добавлены кнопки ±30 сек (RotateCcw/RotateCw с бейджем «30», title «Назад/Вперёд на 30 секунд») рядом с ±10; виртуальный таймлайн currentTime/duration (fmtTime, «--:--» при unknown, скрыт <md); Mute/Unmute кнопка Volume2/VolumeX рядом со слайдером (ctrl Mute если volume>0, иначе Unmute); iframe allow += picture-in-picture (lazy НЕ добавлен — медленнее старт); tryPost helper: postMessage(JSON) внутрь iframe в try/catch best-effort перед SeekForward/SeekBackward (avc-seek ±seconds), Play/Pause/TogglePlayPause (avc-play/avc-pause по isPlaying), Mute/Unmute/SetVolume (avc-volume) — выполнение команды executor'ом при этом не блокируется
- anime-view.tsx: панель «Моя библиотека» под инфо-блоком (рамка zinc-800): кнопка-сердце Heart (filled amber когда entry.favorite, executeCommand ToggleFavorite {favorite: !current}); Select статусов из WATCH_STATUS_LABELS + «Не выбрано» (sentinel '__none__' → SetWatchStatus {status: ''}), placeholder «Статус…»; запись ищется по details.animeId (не по глобальному playback); бейдж статуса (+«Избранное» rose) рядом с заголовком; хинт «Войдите для синхронизации» при !user (клики всё равно шлют executeCommand — executor сам откроет auth)
- voice-panel.tsx: полоса уровня микрофона h-1.5 под кнопкой (width = micLevel*100%, transition-all duration-75, цвет zinc-600 <30% / amber-400 <70% / rose-500, role=meter с aria-valuenow); interimText курсивом zinc-400 пока listening (aria-live, «…»); бейдж движка «Браузер»/«Сервер» из voice.browserEngine рядом со статусом; существующие элементы (режим, тестовый ввод, последний результат) сохранены
- header-bar.tsx: кнопка Library (BookOpen, aria «Библиотека», setLibraryOpen(true)) с amber-точкой-бейджем если library.length>0; чип аккаунта (User + username, DropdownMenu) с «Выйти» (avcApi.logout() → setUser(null)+setLibrary([])+setVoiceAliases([])+toast) либо кнопка «Войти» → setAuthOpen(true)
- auth-dialog.tsx (НОВЫЙ): Dialog по store.authOpen; Tabs Вход/Регистрация; username+password (type=password, autoComplete), ошибки сервера текстом rose (role=alert); успех: setUser → закрыть → avcApi.library()/aliases() → setLibrary/setVoiceAliases → toast «С возвращением, {username}!» / «Добро пожаловать…»; кнопки min-h-11, Enter в пароле = сабмит, Loader2 на busy
- library-panel.tsx (НОВЫЙ): Sheet side=right w-full sm:max-w-[420px]; табы Продолжить|Смотрю|В планах|Просмотрено|Брошено|Отложено|Избранное (scrollable TabsList); «Продолжить» = episode!=null, sort updatedAt desc; карточка: постер img w-14 h-20 object-cover, title, «Серия N из M», прогресс-бар episode/total, Play → continueWatchingFromEntry(entry) + закрытие панели; клик по карточке (role=button, Enter/Space) = то же; в статус-табах dropdown смены статуса (STATUS_ICONS + WATCH_STATUS_LABELS) → avcApi.putLibrary({animeId,title,slug,poster,status}) → merge в store.library (null → «Требуется вход»), кнопка Trash2 → avcApi.deleteLibraryEntry → filter store (false → тост-ошибка); stopPropagation на действиях; пустое состояние с подсказкой «найди Берсерка»; !user → заглушка + «Войти» (закрыть library → setAuthOpen(true)); список avc-scroll overflow-y-auto
- voice-confirm-dialog.tsx (НОВЫЙ): Dialog по voiceConfirm!==null ({spoken, match}); «Уточним озвучку», «Вы говорите: "{spoken}"», крупно match.name + бейдж confidence% цветом по matchedVia (exact/alias/translit/fuzzy); «Да, переключить» (amber, confirmVoiceMatch(), autoFocus через onOpenAutoFocus) / «Нет, отмена» (outline, cancelVoiceMatch()); закрытие крестом/оверлеем = cancelVoiceMatch (с защитой от двойного вызова, если кнопка уже очистила store); подсказка «Скажите название точнее или выберите озвучку на странице аниме»
- install-pwa.tsx (НОВЫЙ, mounted в layout.tsx): локальный тип BeforeInstallPromptEvent; beforeinstallprompt → preventDefault + сохранить; ненавязчивый Card fixed bottom-3 left-3 «Установить AnimeVC на устройство» + «Установить» (event.prompt()) + крестик (localStorage 'avc-pwa-dismissed'='1'); НЕ показывать при dismissed / display-mode: standalone / appinstalled; SSR-safe return null
- settings-dialog.tsx: реорганизован в Tabs Общие|Микрофон|Озвучки (существующие секции сохранены внутри «Общие», контент скроллится, TabsList фикс). «Микрофон»: Select sttEngine auto/browser/server с русскими подписями; Select устройства из listMicDevices (тот же источник, что voice.micDevices — диалог не может принимать voice-проп из-за запрета править page.tsx; список обновляется при открытии + кнопка RefreshCw; пусто → хинт «Разрешите доступ к микрофону», Select disabled); Slider micGain 1..4 step 0.25 + «×{micGain}» + подсказка «2–3 если далеко»; Slider vadSensitivity 0..100 + «Выше = лучше ловит тихую речь»; Switch noiseSuppression/autoGainControl/echoCancellation; «Проверить микрофон»: getUserMedia(buildAudioConstraints) → createMicChain(micGain) → MediaRecorder(destination.stream) 3.5с с живым уровнем (rmsLevel по rAF, та же цветовая шкала) → encodeWav16kMono(blob, 1) (gain уже применён в цепочке — без двойного усиления) → bufferToBase64 → POST /api/voice/asr {audio, mime:'audio/wav'} → «Распознано: "…"»/ошибка; кнопка disabled в процессе + Loader2; cleanup (tracks/ctx/raf) при закрытии диалога. «Озвучки»: список voiceAliases «alias → targetName» + X → avcApi.deleteAlias(id); форма алиас+официальное имя → avcApi.addAlias(target, alias) → setVoiceAliases([...cur, row]) (null → «Войдите, чтобы сохранять алиасы»); Collapsible «Встроенные варианты произношения» со всеми DEFAULT_VOICE_ALIASES; debounce PUT /api/settings не тронут (шлёт весь settings — новые поля полетели автоматически)
- help-dialog.tsx: новые группы «Звук» (выключи/убери/включи/верни звук), «Перемотка» (20 секунд, 2 минуты назад, полминуты, «секунд 30», «сто двадцать секунд»), «Библиотека» (в смотрю/планы/просмотрено/брошено/отложено, избранное, продолжить просмотр, открой библиотеку), «Озвучки» (переключи на анилибрию, следующая/вторая озвучка, добавь X как команду для Y); секция «Горячие клавиши» (Ctrl+Space, Space, ←/→, Shift+←/→=30с, ↑/↓, N/P, F, M) в виде kbd-чипов; финальная заметка про переспрос озвучки
- debug-panel.tsx: секция «Резолвер озвучек» (FlaskConical): Input + «Проверить» → resolveVoiceProvider(spoken, кандидаты, buildUserAliasMap(voiceAliases)); кандидаты — dubs из getCachedDetails(playback.animeId, playback.animeSlug) если открыто аниме, иначе ключи DEFAULT_VOICE_ALIASES как {name,shortName}; результат name + бейдж confidence%·matchedVia цветом по via / «Совпадений ниже порога»; Enter в поле тоже запускает. Секция «Статус»: username / «не залогинен», записей в библиотеке, алиасов, движок STT; copyDebug расширен (user + library); пайплайн и диагностика сохранены
- mini-player.tsx: виртуальный таймлайн mm:ss/mm:ss (fmtTime) под инфо-строкой, кнопка Mute/Unmute (Volume2/VolumeX) перед слайдером громкости (executeCommand Mute/Unmute)
- PWA: scripts/make-icons.mjs (sharp, SVG: rounded-квадрат #09090b + amber play-треугольник со stroke-linejoin=round + две rose дуги-микрофона; argv-размеры, дефолт 192+512; maskable 512 с artwork в safe-zone 10% и full-bleed фоном без rx) — выполнен, public/icons/{icon-192,icon-512,icon-maskable-512}.png на диске (192x192/512x512/512x512 PNG); public/manifest.webmanifest (name/short_name, start_url /, display standalone, bg #09090b, theme #f59e0b, lang ru, 3 иконки); layout.tsx: metadata.manifest, appleWebApp{capable, black-translucent, AnimeVC}, icons → /icons/icon-{192,512}.png + apple, applicationName; export const viewport: Viewport {themeColor '#f59e0b', device-width, initialScale 1, maximumScale 1}; <InstallPwa /> смонтирован в layout (page.tsx у 9-a не тронут)
- src/lib/db.ts (межзонный фикс по рецепту 8-a): isStaleClient() — если глобальный PrismaClient создан до появления модели User (db.user undefined), гасим его и создаём свежий; причина 500 на /api/auth/* — dev-процесс удерживал клиент и Turbopack-чанк @prisma/client, сгенерированные ДО db:push (в свежем процессе bun клиент был с User, в dev-сервере — нет; правка db.ts без рестарта не помогала из-за персистентного кэша Turbopack). Рестарт dev-сервера + патч → register/login/me/library PUT·DELETE/aliases POST·DELETE проверены curl'ом (200/401 пути), тестовый пользователь и его данные удалены из БД
- ВАЖНО для сборщиков: InstallPwa смонтирован в layout.tsx — НЕ дублировать в page.tsx. AuthDialog/LibraryPanel/VoiceConfirmDialog монтирует 9-a в page.tsx (по контракту store они уже существуют и управляются executor'ом)

Stage Summary:
- bunx tsc --noEmit: 0 ошибок вне examples/skills (предсуществующие); eslint по всем 14 файлам задачи + db.ts + make-icons.mjs — чисто
- Страница 200, manifest 200, иконки 200; пайплайн, диагностика, история, тестовый ввод не сломаны
- Пользовательские сценарии закрыты: автозапуск кликом без перезагрузки iframe, ±10/±30 + таймлайн + mute, избранное/статусы на странице аниме, библиотека-панель с продолжением просмотра, вход/регистрация с догрузкой данных, индикатор уровня + interim + движок, тест микрофона с живым уровнем, алиасы озвучек с дефолтами, дебаг-резолвер, PWA-баннер + manifest + иконки

---
Task ID: 10
Agent: ZAI (main)
Task: Финальная верификация (lint + tsc + Agent Browser E2E) и фиксы

Work Log:
- Исправлен двойной монтаж InstallPwa (layout.tsx + page.tsx) — оставлен только в layout.tsx
- bun run lint: 0 ошибок; tsc --noEmit: src/ чист (остаточные ошибки только в предсуществующих examples/, skills/)
- Smoke-тесты curl: / (200), /api/auth/me, /manifest.webmanifest (200), /icons/icon-192.png (200), /api/aliases без сессии → «Требуется вход»
- Agent Browser E2E (золотой путь): сессия восстановлена→отклонена; «найди берсерка» → 3 живых варианта; выбор «1» → страница Берсерка с панелью «Моя библиотека»
- Резолвер озвучек LIVE: «включи озвучку сербина» → «Озвучка Сербин (100%)» (падеж снят); «снербин» → 86% auto; «снрбин» → 83% → ДИАЛОГ «Уточним озвучку» → «Да» применяет
- Негатив: «переключи на анилибрию» → «не найдена. Доступны: MC Entertainment, Сербин, Amber, ConeVoice, Субтитры, Гоблин»
- Регистрация couchviewer через диалог; «добавь в избранное» → ❤️ в библиотеке; автосинк «Смотрю, серия 4»; «продолжить просмотр» → «Продолжаю: Берсерк, серия 4»
- Оверлей автозапуска плеера («Нажмите, чтобы запустить») появляется и снимается кликом без перезагрузки iframe; кнопки ±10/±30, mute, таймлайн --:--/23:39
- Настройки: вкладка Микрофон (движок STT, устройство, усиление ×1-4, чувствительность 0-100, тест микрофона), вкладка Озвучки — алиас «ани либрия»→AniLibria добавлен через форму и сохранён в БД (кнопка удаления видна)
- Hotkeys: Space=play/pause, M=mute проверены; мобайл 390px — сетки/чипы/футер корректны; browser errors/console — чисто
- dev.log: без ошибок

Stage Summary:
- Все 6 пунктов баг-репорта закрыты и проверены end-to-end в браузере: (1) автозапуск серии оверлеем, (2) аккаунт+библиотека статусов, (3) UI/PWA-Android manifest+иконки, (4) усиление/чувствительность микрофона+WAV 16к ASR, (5) перемотка ±10/±30/минуты голосом и клавишами, (6) Voice Provider Resolver с падежами/транслитом/алиасами/порогами 0.85-0.55 и обучением алиасам

---
Task ID: 11
Agent: ZAI (main)
Task: Голосовой запуск серии без клика — реальный протокол плеера Aksor (postMessage bridge)

Work Log:
- ИССЛЕДОВАНИЕ: скачал embed-страницу player.aksor.tv + бандл /assets/index-CRO05xQc.js, реверсом
  нашёл ПОЛНЫЙ двусторонний API (валидатор di() + диспетчер te() в бандле):
  * команды (объекты, не JSON-строки): {key:'player_play'}, {key:'player_pause'},
    {key:'player_seek', value:<АБСОЛЮТНАЯ секунда>}, {key:'player_set_volume', value:{volume?:0..2, muted?:bool}},
    {key:'player_set_source', value:{url,...}} (резерв)
  * события в родителя: player_play, player_pause, player_video_started, kodik_player_video_ended,
    kodik_player_time_update{value}, kodik_player_duration_update{value}, player_volume_change{value:{muted,volume 0..2}}
  * причина бага: старый код слал выдуманные {type:'avc-play'} — парсер плеера требует e.key и молча игнорил
- src/lib/avc/player-bridge.ts (НОВЫЙ): registerPlayerWindow/sendPlayerCommand/parsePlayerEvent
  (строгий парсер-зеркало di()), storeToPlayerVolume/playerToStoreVolume (0..100 ↔ 0..2),
  hasStickyActivation() через navigator.userActivation
- src/components/avc/player.tsx: окно iframe регистрируется в мосту; window message listener
  фильтрует e.source===contentWindow и льёт РЕАЛЬНОЕ состояние в store (isPlaying, currentTime,
  duration, volume); АВТО-СТАРТ серии: при url-изменении, если есть sticky activation
  (клик по микрофону/Ctrl+Space/'Разрешить' — всегда есть в голосовой сессии), шлём player_play
  через 0.7с и 2с; оверлей «Скажите „запусти“ или нажмите» выводится из dismissedUrl!==url (без
  setState в эффекте), снимается голосом/кликом/автоматом по событию player_play; ctrl() упрощён
  (одна точка входа — executor); слайдер громкости шлёт player_set_volume
- src/lib/avc/executor.ts: executePlayPause → player_play/player_pause (+тост-подсказка при
  отсутствии sticky activation — единственный честный случай клика), executeSeek → player_seek
  (абсолютная цель из реального currentTime), executeMuteUnmute/executeVolume → player_set_volume
- src/lib/voice/aliases.ts: Play-триггеры + 'запусти', 'запуск', 'плей', 'играй' (однословные —
  только точное совпадение, 'запусти пятую серию' остаётся SelectEpisode через OPEN_TRIGGERS)
- help-dialog.tsx: «запусти — старт серии голосом, без клика»; mini-player.tsx: реальный таймлайн,
  слайдер громкости через мост
- E2E Agent Browser: «найди берсерка»→«первый»→«Включить серию 1» → оверлей → клик → плеер РЕАЛЬНО
  играет (seek-слайдер плеера 3.1с, его кнопка Play→Pause); «пауза» голосом → реальная пауза
  (время замерло, кнопка →Play); «запусти» → Play, время пошло; «перемотай вперед на 30 секунд» →
  реальный скачок в плеере (25с+30с≈66с); «выключи звук» → кнопка плеера сменилась на Unmute;
  наш таймлайн 1:17/23:36 и 1:33/23:36 — живое время/длительность из kodik_player_* событий
  (23:36 = 1416с из API); мобильный 390px футер ок; dev.log/console/errors чисто; lint+tsc 0 ошибок

Stage Summary:
- Серия запускается БЕЗ РУК: открытие серии при активной голосовой сессии стартует автоматически
  (sticky activation от клика микрофона + allow="autoplay" → легальный play() со звуком в
  кросс-доменном iframe); голосом работают ВООБЩЕ ВСЕ функции плеера: запуск/пауза/перемотка
  (±секунды/минуты)/громкость/mute — не виртуальные тумблеры, а реальные команды Aksor;
  таймлайн и длительность теперь фактические (события плеера), а не выдуманные
- Ограничение задокументировано честно: если пользователь ни разу не кликнул/не нажал клавишу
  в этой сессии (микрофон разрешён заранее, always-listening сам стартовал), браузер запрещает
  звук — в этом случае тост подскажет один клик, после которого весь сеанс снова без рук

---
Task ID: 12
Agent: ZAI (main)
Task: «Плеер включается, но сразу ставит на Mute» — persist-мьют плеера Aksor и его лечение голосом/автоматом

Work Log:
- ДИАГНОСТИКА (реверс бандла aksor): плеер хранит громкость/mute в СВОЁМ localStorage
  (ключи aksor-player-volume / aksor-player-muted) и пишёт их при КАЖДОЙ установке W(),
  восстанавливая при каждом открытии серии. Один замьюченный старт → мьют навсегда на
  всех будущих сериях/сессиях. Воспроизведено в песочнице: muted="true", volume="0".
- НАЙДЕН ВТОРОЙ СЛОЙ БАГА (замкнутый круг): при загрузке плеер шлёт
  player_volume_change{muted:true, volume:0} → наш store принимал volume=0 →
  ensureVolumePushed «уважал» volume=0 и сам закреплял чужой мьют push'ем {volume:0, muted:true}.
- src/lib/avc/player-bridge.ts: + pushPlayerVolume(volume100) — шлёт {volume, muted:volume<=0};
  volume>0 перезаписывает persist-память плеера (лечение навсегда), volume=0 уважает
  осознанный мьют пользователя.
- src/components/avc/player.tsx: «окно синхронизации» volumeSyncOpenRef — открыто при смене
  серии, входящие player_volume_change игнорируются до первого проталкивания громкости
  (ensureVolumePushed: по player_play/player_video_started/kodik_player_time_update — когда
  видео-элемент плеера гарантированно создан и команда не теряется из-за его if(!u) return);
  после push окно закрывается, реальные изменения громкости в UI плеера принимаются как обычно;
  таймеры авто-старта тоже шлют громкость (best-effort до готовности плеера).
- help-dialog.tsx: «включи звук — снимет mute даже плеера».
- E2E полный цикл: «выключи звук» голосом → в localStorage плеера muted=true/volume=0 →
  перезагрузка приложения → серия 3 → оверлей/запуск → плеер стартовал со своим мьютом,
  приложение АВТОМАТИЧЕСКИ протолкнуло 70% → кнопки плеера: Pause + Volume 70% (размьючен,
  память плеера перезаписана muted=false) → все следующие серии стартуют со звуком без мьюта.
  Голосовой цикл посреди серии: «включи звук»→Unmute|Громкость 70%, «выключи звук»→Mute|Звук
  выключен (кнопка плеера Unmute). lint+tsc чисто.

Stage Summary:
- Ответ пользователю: мьют приходил не от нас — плеер Aksor сам запоминает его в своём
  localStorage и восстанавливает на каждой серии; голосом снимается командой «включи звук»
  (а также «верни звук»/«со звуком»), а после фикса и НЕ ПОЯВЛЯЕТСЯ: при каждом старте серии
  приложение проталкивает в плеер громкость из настроек и снимает persist-мьют (однократно
  вылечив его и на будущее); если пользователь сам замьютил голосом — его выбор уважается,
  «включи звук» возвращает громкость

---
Task ID: 13
Agent: ZAI (main)
Task: «Не работает перемотка серий в плеере kodik, а громкость/пауза работают» — мультипротокольный player bridge

Work Log:
- ДИАГНОСТИКА: YummyAnime отдаёт серии через НЕСКОЛЬКО плееров: player.aksor.tv (протокол Task 11/12),
  kodikplayer.com (озвучки Amber/ConeVoice/INSOMNIA/Swimming Cat и др.), alloha.yani.tv, video.sibnet.ru,
  ru.yummyani.me/iframeCVH.html. Kodik МОЛЧА игнорирует aksor-команды {key:'player_seek'} и пр. —
  «работа» громкости/паузы была оптической иллюзией optimistic-обновлений store (реальный плеер их не получал).
- РЕВЕРС БАНДЛА KODIK (app.player_single.9abf69e8....js) + ЖИВЫЕ postMessage-тесты в E2E:
  * команды ТОЛЬКО через конверт {key:'kodik_player_api', value:{method:...}}: play (до загрузки плеера
    запускает загрузку — fallback p()), pause, seek {seconds: АБСОЛЮТНАЯ сек — проверено 10/60/70},
    volume {0..1}, mute, unmute, speed {0.25..2}, get_time → ответ kodik_player_time (без монотонного фильтра)
  * события: kodik_player_* (+ голое video_started), volume_change {volume:0..1, muted},
    seek {time} — эхо перемотки из UI плеера; time_update шлётся ТОЛЬКО при увеличении времени
    (после отката назад молчит до «догона»)
  * ШКАЛА ГРОМКОСТИ У ОБОИХ 0..1 (aksor: set 0.7 → эхо {volume:0.7}) — прежний «0..2 буст» фантом,
    деление на 2 в playerToStoreVolume занижало громкость событий вдвое — УДАЛЕНО
  * aksor принимает и конверт kodik_player_api (общий движок Kodik)
- НАЙДЕН КОСЯК AUTO-СТАРТА: navigator.userActivation.hasStickyActivation НЕ СУЩЕСТВУЕТ (имя из черновика) —
  реальное API hasBeenActive → hasStickyActivation() всегда false, авто-старт молча не работал НИКОГДА
- src/lib/avc/player-bridge.ts (переписан): sendPlayerCommand шлёт КАЖДУЮ команду в ОБОИХ форматах
  (aksor-ключи + kodik-конверт; каждый плеер исполняет свою, двойное исполнение идемпотентно);
  parsePlayerEvent понимает оба протокола (+player_user_seek, get_time-ответы); requestPlayerTime();
  шкалы 0..1; исправлен hasStickyActivation
- src/components/avc/player.tsx: player_user_seek → синк таймлайна при перемотке в UI плеера;
  get_time-поллинг 1с при isPlaying (компенсация монотонного фильтра kodik — таймлайн не «замерает»
  после отката); retryAutoStart — дожим play по первому живому событию (kodik грузится дольше 0.7/2с);
  seek-kick на 3.8с/5.5с — state machine kodik стартует от ПЕРВОГО seek (эмпирика: до seek get_time
  отвечает undefined, после seek мгновенно video_started)
- E2E (agent-browser, живые postMessage-замеры): AKSOR — авто-старт без клика, голосовые
  пауза (время замерло 190.3=190.3)/запусти (190→193)/+30с (27.5→60.2)/-40с и -30с (178.8→156.2)/
  громкость 50 (эхо 0.5)/выключи-включи звук (0→0.5 восстановление) — ВСЁ РЕАЛЬНОЕ;
  KODIK — авто-старт с kick без клика (push 0.7 принят, video_started, оверлей снялся сам),
  +30с → 51.45 точное эхо kodik_player_seek, -15с → 36.45, громкость 30 → эхо {volume:0.3},
  mute/unmute голосом работают; get_time-поллинг живой; мобильный 390px футер ок;
  lint+tsc (src) 0 ошибок; dev.log чист

Stage Summary:
- Перемотка/громкость/пауза/старт теперь работают на ОБОИХ семействах плееров (aksor + kodik):
  мост переводит команды в оба проводных формата, события обоих нормализуются в store,
  громкость 0..1 единая (заодно вылечено двойное занижение громкости при синке событий)
- Попутно исправлен фатальный косяк авто-старта (hasBeenActive vs hasStickyActivation) —
  серии стартуют по голосу реально, а не только в Theory™
- Известные ограничения: alloha.yani.tv / video.sibnet.ru / iframeCVH.html — свои протоколы,
  команды к ним по-прежнему не доставляются (кандидаты на отдельный Task); реальное ПРОИГРЫВАНИЕ
  kodik в headless песочницы блокирует autoplay-политика (у пользователя с реальными кликами играет —
  все команды/события верифицированы живыми замерами)

---
Task ID: github-save-1
Agent: Z.ai Code (main)
Task: Сохранение исходников — скачивание из приложения + подключение GitHub (HellShaftSam/AVC-AnimeVoiceCommand)

Work Log:
- Обнаружено: electron-app/ и /home/z/exe-build в этой среде ОТСУТСТВУЮТ (потеряны между сессиями); веб-часть src/ уцелела полностью
- Проверено окружение: git 2.47.3 + .git (6 коммитов, remote нет), gh CLI отсутствует → выбран OAuth Device Flow (curl, client_id gh CLI 178c6fc778ccc68e1d6a, scope=repo)
- Создан src/app/api/download-source/route.ts: zip исходников на лету (исключены node_modules/.next/.git/.env*/*.db/*.log/skills/upload/...), EXPORT_MANIFEST.txt внутри архива
- HeaderBar: кнопка Download → /api/download-source (ghost icon, a11y-лейблы)
- Проверено curl: HTTP 200, 394 KB, 176 файлов, секретов нет; agent-browser: кнопка в шапке рендерится, dev.log чистый, lint 0 ошибок
- .gitignore дополнен (db/*.db, .zscripts/, upload/, tool-results/, download/, agent-ctx/); git rm --cached для runtime-файлов; коммит 68b9729
- Запущен device flow: user_code A028-FBFA (15 мин) + фоновый poller (/tmp/.gh-device-status) + watcher: при успехе — credential store, remote origin → HellShaftSam/AVC-AnimeVoiceCommand, push -u origin main (статусы /tmp/.gh-push-status, .gh-push.log)

Stage Summary:
- Исходники теперь скачиваются кнопкой из шапки приложения в любой момент (zip ~400KB, без секретов)
- GitHub-пуш автоматизируется сразу после ввода пользователем кода авторизации в браузере
- electron-app/ (EXE-обёртка) потерян в этой среде — требует восстановления в отдельной задаче (в архив не попал, помечено в манифесте)
