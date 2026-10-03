/**
 * AVC-Anime preload — безопасный мост между Next.js UI и главным процессом.
 *
 * ПРИНЦИПЫ (спецификация, секция 15):
 *   - наружу выставлены ТОЛЬКО методы высокого уровня, возвращающие
 *     НЕ-секретные данные (снимки аккаунта, избранное, отчёты диагностики);
 *   - никаких ipcRenderer, webContents, cookies наружу;
 *   - cookie/пароли/токены через мост не проходят никогда.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('avcElectron', {
  platform: 'electron',

  /** Состояние аккаунта (не-секретный снимок) */
  getAccountState: (refresh) => ipcRenderer.invoke('avc:auth:getState', { refresh: !!refresh }),

  /** Открыть окно входа на реальный сайт; резолв после закрытия окна */
  openLoginWindow: () => ipcRenderer.invoke('avc:auth:open-login'),

  /** Принудительная проверка аутентификации через сайт */
  verifyAuthentication: () => ipcRenderer.invoke('avc:auth:verify'),

  /** Выход ЧЕРЕЗ САЙТ + подтверждение состояния */
  logout: () => ipcRenderer.invoke('avc:auth:logout'),

  /** Избранное с сайта (данные сессии main-процесса, без секретов) */
  getFavorites: (refresh) => ipcRenderer.invoke('avc:auth:favorites', { refresh: !!refresh }),

  /** Сброс постоянной сессии (backup + подтверждение в main) */
  resetYummySession: () => ipcRenderer.invoke('avc:auth:reset-session', { confirmed: true }),

  /** Диагностический selftest (безопасный отчёт) */
  runAuthSelfTest: () => ipcRenderer.invoke('avc:auth:selftest'),

  /**
   * РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное).
   * Выполняется same-origin в main-процессе; наружу — только не-секретный
   * результат { ok, httpStatus, verification, state, message }.
   */
  animeAction: (req) => ipcRenderer.invoke('avc:anime:action', req),

  /** Подписка на изменения состояния аккаунта (вход/выход/истечение) */
  onAccountChanged: (cb) => {
    const handler = (_event, snap) => cb(snap)
    ipcRenderer.on('avc:account-changed', handler)
    return () => ipcRenderer.removeListener('avc:account-changed', handler)
  },

  /** Подписка на статусы входа (капча/ошибка/успех) для toast-сообщений */
  onAuthStatus: (cb) => {
    const handler = (_event, msg) => cb(msg)
    ipcRenderer.on('avc:auth-status', handler)
    return () => ipcRenderer.removeListener('avc:auth-status', handler)
  },

  // ---------------------------------------------------------------------------
  // ЛОКАЛЬНЫЙ AI-СЛОЙ (спецификация §4–§134). Наружу — только не-секретные данные:
  // статусы моделей, прогресс загрузок, события STT, WAV-пути TTS, JSON команд LLM.
  // ---------------------------------------------------------------------------
  ai: {
    /** Доступен ли AI-слой в этом EXE (пакеты/нативные рантаймы установлены) */
    available: true,

    /** Общий статус: модели, сервисы (ready), метрики, голоса */
    getStatus: () => ipcRenderer.invoke('avc:ai:status'),

    /** Аппаратная информация для AI Setup (§50): CPU/RAM/диск/GPU */
    getHardware: () => ipcRenderer.invoke('avc:ai:hardware'),

    /** Установка компонентов (§52): keys ⊂ ['stt','vad','tts','llm'] */
    install: (keys, voiceId) => ipcRenderer.invoke('avc:ai:install', { keys, voiceId }),

    /** Отмена текущей загрузки (§57) */
    cancelInstall: (key) => ipcRenderer.invoke('avc:ai:cancel-install', { key }),

    /** Незавершённые загрузки после перезапуска (§128) */
    recover: () => ipcRenderer.invoke('avc:ai:recover'),

    /** Включение/выключение AI-слоя целиком */
    setEnabled: (enabled) => ipcRenderer.invoke('avc:ai:set-enabled', { enabled }),

    /** Профиль производительности (§19): max_responsiveness | balanced | quality */
    setProfile: (profile) => ipcRenderer.invoke('avc:ai:set-profile', { profile }),

    /**
     * Локальный LLM-роутер (§28–§47): вызывается ТОЛЬКО когда детерминированный
     * парсер не распознал фразу. Контракт тот же, что у /api/voice/interpret:
     * { commands: [{type, params, confidence}], needsClarification, clarifyQuestion } | null
     */
    llmRoute: (text, context, timeoutMs) => ipcRenderer.invoke('avc:ai:llm-route', { text, context, timeoutMs }),

    /** Локальный TTS (§22–§29): { file, cached, ms, durationMs } | null */
    ttsSpeak: (text) => ipcRenderer.invoke('avc:ai:tts-speak', { text }),

    /** Немедленная отмена текущей речи (§26) */
    ttsCancel: () => ipcRenderer.invoke('avc:ai:tts-cancel'),

    /** Выбор голоса локального TTS (id из манифеста) */
    setVoice: (voice) => ipcRenderer.invoke('avc:ai:set-voice', { voice }),

    /** Повторная инициализация сервисов после установки моделей */
    initialize: () => ipcRenderer.invoke('avc:ai:initialize'),

    /**
     * Подача аудио в локальный STT (§6, §8): Int16Array, 16 кГц mono.
     * События распознавания приходят через onSttPartial/onSttFinal.
     */
    feedAudio: (int16Samples) => ipcRenderer.invoke('avc:ai:stt-feed', { samples: int16Samples }),

    /** Принудительное завершение текущей фразы (push-to-talk отпустили) */
    flushStt: () => ipcRenderer.invoke('avc:ai:stt-flush'),

    /** Частичная транскрипция { utteranceId, text, ms, earlyCommand? } (§11–§12) */
    onSttPartial: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:stt-partial', handler)
      return () => ipcRenderer.removeListener('avc:ai:stt-partial', handler)
    },

    /** Финальная транскрипция { utteranceId, text, ms, earlyCommandType? } (§14 — дедупликация) */
    onSttFinal: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:stt-final', handler)
      return () => ipcRenderer.removeListener('avc:ai:stt-final', handler)
    },

    /** Прогресс загрузки моделей (§56) */
    onModelProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:model-progress', handler)
      return () => ipcRenderer.removeListener('avc:ai:model-progress', handler)
    },

    /** Статусы инициализации сервисов после старта */
    onServicesStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:services-status', handler)
      return () => ipcRenderer.removeListener('avc:ai:services-status', handler)
    },

    // --- Каталог AI-моделей (фаза 5 аудита): выбор/миграция/открытие ---

    /** Текущий каталог моделей + конфиг (не-секретные пути) */
    getModelsDirConfig: () => ipcRenderer.invoke('avc:ai:models:get-config'),

    /** Системный диалог выбора папки (возвращает абсолютный путь или null) */
    pickModelsDir: () => ipcRenderer.invoke('avc:ai:models:pick-dir'),

    /**
     * Безопасная смена каталога: валидация → место → копирование → сверка →
     * конфиг → рестарт AI-воркера. Старый каталог не удаляется.
     */
    setModelsDir: (dir) => ipcRenderer.invoke('avc:ai:models:set-dir', { dir }),

    /** Открыть каталог моделей в системном проводнике */
    openModelsDir: () => ipcRenderer.invoke('avc:ai:models:open-dir'),
  },
})
