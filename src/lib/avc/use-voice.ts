'use client'
/**
 * useVoice — клиентский голосовой слой (движки распознавания + TTS + пуш-ту-ток).
 *
 * ДВИЖКИ (выбор по settings.sttEngine, настройки читаются на старте каждой сессии):
 *   'browser' — только Web Speech API (ru-RU); нет поддержки → понятная ошибка;
 *   'server'  — сразу MediaRecorder → WAV 16 кГц mono → /api/voice/asr;
 *   'auto'    — Web Speech API, при отсутствии/сбое — серверный ASR.
 *   VoiceApi.browserEngine после старта отражает ФАКТИЧЕСКИ используемый движок.
 *
 * ЗАХВАТ МИКРОФОНА (проблема «я далеко от микрофона и мне нужно кричать»):
 *   - Серверный движок: getUserMedia(buildAudioConstraints(settings)) → WebAudio-цепочка
 *     createMicChain (highpass 70 Гц → мягкий компрессор → GainNode(micGain)) →
 *     MediaRecorder пишет destination.stream, т.е. micGain реально усиливает запись.
 *     VAD (порог = sensitivityToRms(settings.vadSensitivity)) читает тот же analyser,
 *     т.е. уже усиленный сигнал — тихая речь тоже достигает авто-стопа по тишине.
 *   - Web Speech API использует СВОЙ внутренний захват микрофона: micGain/цепочка
 *     на него повлиять не могут (ограничение платформы). Для живого индикатора
 *     уровня держим параллельно лёгкую цепочку source → analyser (только индикация).
 *
 * Push-to-talk: удержание кнопки или Ctrl+Space (глобальный хендлер в page.tsx).
 * Always-listening: после каждой обработки микрофон перезахватывается через 400 мс;
 * wake word (если включён) отфильтровывает фразы не для приложения.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildAudioConstraints,
  bufferToBase64,
  createMicChain,
  encodeWav16kMono,
  listMicDevices,
  rmsLevel,
  sensitivityToRms,
  type MicChain,
} from '../voice/audio-utils'
import { executeText } from './executor'
import { useAvcStore, VoiceStatus } from './store'

const SILENCE_MS = 1300
const MIN_UTTERANCE_MS = 500
/** Кап длительности фразы по умолчанию (переопределяется settings.maxUtteranceMs — жалоба «обрезает на 15 с», аудит §3 п.6) */
const DEFAULT_MAX_UTTERANCE_MS = 12000
const REARM_DELAY_MS = 400
const ERROR_CLEAR_MS = 4000
/** Троттлинг обновления micLevel (~10 раз/с) */
const MIC_LEVEL_INTERVAL_MS = 100

// --- Web Speech API (минимальные типы) ---------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
  length: number
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function pickRecorderOptions(): MediaRecorderOptions {
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      return { mimeType: 'audio/webm;codecs=opus' }
    }
    if (MediaRecorder.isTypeSupported('audio/webm')) return { mimeType: 'audio/webm' }
  }
  return {}
}

/** Понятное сообщение об ошибке getUserMedia */
function micErrorMessage(e: unknown): string {
  const name =
    e instanceof DOMException
      ? e.name
      : e instanceof Error
        ? ((e as { name?: string }).name ?? '')
        : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'Нет доступа к микрофону. Разрешите доступ к микрофону для сайта (иконка в адресной строке) и попробуйте снова.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'Микрофон не найден. Подключите микрофон или выберите другое устройство в настройках.'
  }
  return 'Не удалось получить доступ к микрофону. Проверьте разрешения и подключение.'
}

export interface VoiceApi {
  voiceStatus: VoiceStatus
  voiceMessage: string
  isMicSupported: boolean
  /** Фактический движок текущей/последней сессии: true = Web Speech API, false = серверный ASR */
  browserEngine: boolean
  alwaysListening: boolean
  startPushToTalk: () => Promise<void>
  stopPushToTalkAndProcess: () => void
  toggleAlwaysListening: () => void
  setAlwaysListening: (v: boolean) => void
  speak: (text: string) => Promise<void>
  /** Живой уровень микрофона 0..1 (обновляется ~10 раз/с, пока идёт listening) */
  micLevel: number
  /** Промежуточный (не финальный) текст Web Speech API, очищается при обработке */
  interimText: string
  /** Список микрофонов (нужен permission; без него — пустой массив) */
  micDevices: MediaDeviceInfo[]
  refreshMicDevices: () => Promise<void>
}

export function useVoice(): VoiceApi {
  const voiceStatus = useAvcStore((s) => s.voiceStatus)
  const voiceMessage = useAvcStore((s) => s.voiceMessage)

  // При SSR считаем микрофон поддержанным (true), чтобы hydration совпадал;
  // фактическую поддержку уточняем после монтирования.
  const [isMicSupported, setIsMicSupported] = useState<boolean>(true)
  const [browserEngine, setBrowserEngine] = useState<boolean>(false)
  const [micLevel, setMicLevel] = useState<number>(0)
  const [interimText, setInterimText] = useState<string>('')
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [alwaysListening, setAlwaysListeningState] = useState(false)

  useEffect(() => {
    setIsMicSupported(
      typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    )
  }, [])

  const refreshMicDevices = useCallback(async () => {
    setMicDevices(await listMicDevices())
  }, [])

  useEffect(() => {
    void refreshMicDevices()
  }, [refreshMicDevices])

  const streamRef = useRef<MediaStream | null>(null)
  /** micDeviceId, под который открыт streamRef (пересоздаём при смене устройства) */
  const streamDeviceRef = useRef<string | null>(null)
  /** Полная WebAudio-цепочка серверного движка (запись из destination.stream) */
  const chainRef = useRef<MicChain | null>(null)
  /** Лёгкая цепочка индикатора для Web Speech (source → analyser) */
  const lightChainRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  /** Порог тишины текущей сессии (из sensitivityToRms(settings.vadSensitivity)) */
  const vadRmsRef = useRef(0.015)
  const silenceStartRef = useRef<number | null>(null)
  const lastLevelTsRef = useRef(0)
  const startedAtRef = useRef(0)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processingRef = useRef(false)
  /** Поколение сессии: инвалидация асинхронных стартов после стопа */
  const sessionSeqRef = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderMimeRef = useRef('audio/webm')
  const chunksRef = useRef<Blob[]>([])
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const alwaysRef = useRef(false)
  const startRef = useRef<(() => Promise<void>) | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  // Web Speech API
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const finalTranscriptRef = useRef('')
  const recognitionActiveRef = useRef(false)

  const scheduleErrorClear = useCallback(() => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => {
      const st = useAvcStore.getState()
      if (st.voiceStatus === 'error') st.setVoiceStatus('idle')
    }, ERROR_CLEAR_MS)
  }, [])

  /** Остановить raf-цикл и закрыть всю WebAudio (цепочку записи и/или индикатор) */
  const teardownAudio = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    if (chainRef.current) {
      void chainRef.current.ctx.close().catch(() => undefined)
      chainRef.current = null
    }
    if (lightChainRef.current) {
      void lightChainRef.current.ctx.close().catch(() => undefined)
      lightChainRef.current = null
    }
    setMicLevel(0)
  }, [])

  /**
   * raf-цикл: читает RMS с активного analyser.
   * micLevel обновляется с троттлингом ~10 раз/с;
   * withVad — авто-стоп по тишине (порог vadRmsRef, только серверный движок).
   */
  const startRafLoop = useCallback((withVad: boolean) => {
    silenceStartRef.current = null
    lastLevelTsRef.current = 0
    const tick = () => {
      if (!mountedRef.current) return
      const analyser = analyserRef.current
      if (!analyser) return
      const now = performance.now()
      const rms = rmsLevel(analyser)
      if (now - lastLevelTsRef.current >= MIC_LEVEL_INTERVAL_MS) {
        lastLevelTsRef.current = now
        setMicLevel(rms)
      }
      if (withVad) {
        if (rms < vadRmsRef.current) {
          if (silenceStartRef.current === null) {
            silenceStartRef.current = now
          } else if (
            now - silenceStartRef.current >= SILENCE_MS &&
            now - startedAtRef.current > MIN_UTTERANCE_MS
          ) {
            stopRef.current?.()
            return
          }
        } else {
          silenceStartRef.current = null
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return
    try {
      if (audioElRef.current) {
        audioElRef.current.pause()
        audioElRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const el = new Audio(url)
      audioElRef.current = el
      void el.play().catch(() => undefined)
    } catch {
      // TTS не критичен — молча игнорируем
    }
  }, [])

  const rearmIfNeeded = useCallback(() => {
    if (!alwaysRef.current || !mountedRef.current) return
    if (rearmTimerRef.current) clearTimeout(rearmTimerRef.current)
    rearmTimerRef.current = setTimeout(() => {
      if (alwaysRef.current && mountedRef.current && !processingRef.current) {
        void startRef.current?.()
      }
    }, REARM_DELAY_MS)
  }, [])

  /** Общий обработчик распознанного текста (оба движка) */
  const handleRecognizedText = useCallback(
    async (rawText: string) => {
      const setVoiceStatus = useAvcStore.getState().setVoiceStatus
      try {
        setInterimText('')
        const text = rawText.trim()
        if (!text) {
          setVoiceStatus('idle', 'Речь не распознана')
          return
        }

        const settings = useAvcStore.getState().settings
        let commandText = text
        if (alwaysRef.current && settings.wakeWordEnabled) {
          const wake = settings.wakeWord.trim().toLowerCase()
          const lower = text.toLowerCase()
          if (!wake || !lower.startsWith(wake)) {
            // фраза не для приложения — игнорируем молча
            setVoiceStatus('idle', '')
            return
          }
          commandText = text
            .slice(wake.length)
            .replace(/^[\s,.!?]+/, '')
            .trim()
          if (!commandText) {
            setVoiceStatus('idle', '')
            return
          }
        }

        setVoiceStatus('executing', commandText)
        const result = await executeText(commandText, 'voice')
        const finalMsg = result.results[result.results.length - 1]?.message ?? ''
        setVoiceStatus('idle', finalMsg)
        if (useAvcStore.getState().settings.ttsEnabled && finalMsg) {
          void speak(finalMsg)
        }
      } catch {
        setVoiceStatus('error', 'Ошибка распознавания. Попробуйте ещё раз.')
        scheduleErrorClear()
      } finally {
        processingRef.current = false
        rearmIfNeeded()
      }
    },
    [scheduleErrorClear, speak, rearmIfNeeded],
  )

  /** Серверный движок: webm → WAV 16 кГц mono (с micGain) → base64 → /api/voice/asr */
  const processRecording = useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    const setVoiceStatus = useAvcStore.getState().setVoiceStatus
    try {
      const chunks = chunksRef.current
      chunksRef.current = []
      if (chunks.length === 0) {
        setVoiceStatus('idle')
        return
      }
      const blob = new Blob(chunks, { type: recorderMimeRef.current })
      setVoiceStatus('recognizing', 'Распознаю...')

      const settings = useAvcStore.getState().settings
      const wav = await encodeWav16kMono(blob, settings.micGain)
      const base64 = bufferToBase64(await wav.arrayBuffer())
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64, mime: 'audio/wav' }),
      })
      if (!res.ok) {
        if (res.status >= 500) {
          throw new Error('Сервис распознавания недоступен. Попробуйте позже.')
        }
        const errData = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(errData?.error ?? `ASR HTTP ${res.status}`)
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text ?? '').trim()
      if (!text) {
        setVoiceStatus('idle', 'Речь не распознана')
        return
      }
      await handleRecognizedText(text)
    } catch (e) {
      setVoiceStatus(
        'error',
        e instanceof Error && e.message ? e.message : 'Ошибка распознавания. Попробуйте ещё раз.',
      )
      scheduleErrorClear()
    } finally {
      processingRef.current = false
      rearmIfNeeded()
    }
  }, [scheduleErrorClear, rearmIfNeeded, handleRecognizedText])

  /**
   * Захват микрофона с учётом настроек (constraints + выбранный deviceId).
   * Активный поток переиспользуется, пока не сменился micDeviceId.
   */
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    const settings = useAvcStore.getState().settings
    const existing = streamRef.current
    if (existing && existing.active && streamDeviceRef.current === settings.micDeviceId) {
      return existing
    }
    existing?.getTracks().forEach((t) => t.stop())
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(settings),
    })
    streamRef.current = stream
    streamDeviceRef.current = settings.micDeviceId
    return stream
  }, [])

  /**
   * Лёгкий индикатор уровня для Web Speech API (micGain на сам движок повлиять
   * не может — цепочка здесь только для показа micLevel).
   */
  const startLevelIndicator = useCallback(async () => {
    const seq = sessionSeqRef.current
    try {
      const stream = await ensureStream()
      // сессия могла смениться/завершиться, пока захватывался поток
      if (seq !== sessionSeqRef.current || !mountedRef.current) return
      if (useAvcStore.getState().voiceStatus !== 'listening') return
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      lightChainRef.current = { ctx, analyser }
      analyserRef.current = analyser
      startRafLoop(false)
    } catch {
      // индикатор не критичен
    }
  }, [ensureStream, startRafLoop])

  /** Движок 1: Web Speech API (ru-RU, interim-результаты) */
  const startBrowserSession = useCallback(
    (SRCtor: SpeechRecognitionCtor) => {
      const recognition = new SRCtor()
      recognition.lang = 'ru-RU'
      recognition.continuous = false
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      finalTranscriptRef.current = ''
      recognitionActiveRef.current = true

      recognition.onresult = (e: SpeechRecognitionEventLike) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]
          if (res.isFinal) {
            finalTranscriptRef.current += ' ' + res[0].transcript
          } else {
            interim += res[0].transcript
          }
        }
        setInterimText(interim)
      }
      recognition.onerror = (e: SpeechRecognitionErrorEventLike) => {
        recognitionActiveRef.current = false
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          useAvcStore
            .getState()
            .setVoiceStatus(
              'error',
              'Нет доступа к микрофону. Разрешите доступ к микрофону для сайта и попробуйте снова.',
            )
          scheduleErrorClear()
        } else if (e.error === 'audio-capture') {
          useAvcStore.getState().setVoiceStatus('error', 'Микрофон не найден или не работает.')
          scheduleErrorClear()
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          useAvcStore.getState().setVoiceStatus('error', `Ошибка распознавания: ${e.error}`)
          scheduleErrorClear()
        }
      }
      recognition.onend = () => {
        recognitionActiveRef.current = false
        teardownAudio()
        setInterimText('')
        const transcript = finalTranscriptRef.current.trim()
        finalTranscriptRef.current = ''
        if (transcript) {
          useAvcStore.getState().setVoiceStatus('recognizing', 'Обрабатываю...')
          void handleRecognizedText(transcript)
        } else {
          const cur = useAvcStore.getState().voiceStatus
          if (cur === 'listening') useAvcStore.getState().setVoiceStatus('idle')
          rearmIfNeeded()
        }
      }
      recognitionRef.current = recognition
      recognition.start()
      startedAtRef.current = performance.now()
      setBrowserEngine(true) // движок фактически запустился
      useAvcStore.getState().setVoiceStatus('listening', 'Слушаю...')
      // индикатор уровня (параллельный лёгкий захват)
      void startLevelIndicator()
      // страховка: если движок «завис» без onend — прекращаем сами
      // кап берём из настроек (Настройки → Микрофон → Максимальная длительность фразы)
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      const maxMs = Math.min(
        60000,
        Math.max(4000, useAvcStore.getState().settings.maxUtteranceMs || DEFAULT_MAX_UTTERANCE_MS),
      )
      maxTimerRef.current = setTimeout(() => {
        stopRef.current?.()
      }, maxMs)
    },
    [scheduleErrorClear, handleRecognizedText, rearmIfNeeded, startLevelIndicator, teardownAudio],
  )

  /** Движок 2: MediaRecorder ИЗ ОБРАБОТАННОЙ цепочки + серверный ASR */
  const startServerSession = useCallback(async () => {
    const seq = sessionSeqRef.current
    try {
      const settings = useAvcStore.getState().settings
      const stream = await ensureStream()
      if (seq !== sessionSeqRef.current || !mountedRef.current) return // кнопку уже отпустили
      const chain = createMicChain(stream, settings.micGain)
      chainRef.current = chain
      analyserRef.current = chain.analyser

      const recorder = new MediaRecorder(chain.destination.stream, pickRecorderOptions())
      recorderMimeRef.current = recorder.mimeType || 'audio/webm'
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        void processRecording()
      }
      recorder.start()
      startedAtRef.current = performance.now()
      silenceStartRef.current = null
      setBrowserEngine(false) // движок фактически запустился
      useAvcStore.getState().setVoiceStatus('listening', 'Слушаю...')
      startRafLoop(true)
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      const maxMs = Math.min(
        60000,
        Math.max(4000, settings.maxUtteranceMs || DEFAULT_MAX_UTTERANCE_MS),
      )
      maxTimerRef.current = setTimeout(() => {
        stopRef.current?.()
      }, maxMs)
    } catch (e) {
      // сессию уже отменили/начали новую — не трогаем её аудио и статус
      if (seq !== sessionSeqRef.current) return
      teardownAudio()
      useAvcStore.getState().setVoiceStatus('error', micErrorMessage(e))
      scheduleErrorClear()
    }
  }, [ensureStream, processRecording, scheduleErrorClear, startRafLoop, teardownAudio])

  const startPushToTalk = useCallback(async () => {
    const st = useAvcStore.getState()
    if (st.voiceStatus === 'listening' || processingRef.current) return
    if (!isMicSupported) {
      st.setVoiceStatus('error', 'Микрофон не поддерживается этим браузером')
      scheduleErrorClear()
      return
    }

    // Настройки читаются на старте каждой сессии (gain/sensitivity/движок/устройство)
    const settings = st.settings
    vadRmsRef.current = sensitivityToRms(settings.vadSensitivity)
    setInterimText('')
    const seq = ++sessionSeqRef.current

    const SRCtor = getSpeechRecognitionCtor()
    if (settings.sttEngine === 'browser' && !SRCtor) {
      st.setVoiceStatus(
        'error',
        'Браузер не поддерживает распознавание речи (Web Speech API). Выберите движок «auto» или «server» в настройках.',
      )
      scheduleErrorClear()
      return
    }

    // --- Движок 1: Web Speech API (ru-RU) ---
    if (SRCtor && (settings.sttEngine === 'browser' || settings.sttEngine === 'auto')) {
      try {
        startBrowserSession(SRCtor)
        return
      } catch {
        // не удалось запустить Web Speech
        recognitionRef.current = null
        recognitionActiveRef.current = false
        if (seq !== sessionSeqRef.current) return // сессия уже отменена — молча выходим
        if (settings.sttEngine === 'browser') {
          st.setVoiceStatus('error', 'Не удалось запустить браузерное распознавание речи.')
          scheduleErrorClear()
          return
        }
        // в 'auto' — тихо падаем на серверный движок
      }
    }

    // --- Движок 2 (fallback / 'server'): MediaRecorder + серверный ASR ---
    await startServerSession()
  }, [isMicSupported, scheduleErrorClear, startBrowserSession, startServerSession])

  const stopPushToTalkAndProcess = useCallback(() => {
    sessionSeqRef.current++ // инвалидируем незавершённые асинхронные старты
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    // Web Speech: остановка — результат придёт в onend; индикатор глушим сразу
    // (защита от движка, который так и не вызовет onend)
    const recognition = recognitionRef.current
    if (recognition && recognitionActiveRef.current) {
      teardownAudio()
      try {
        recognition.stop()
      } catch {
        recognitionActiveRef.current = false
      }
      return
    }
    // Серверный движок: остановить запись и обработать
    teardownAudio()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }, [teardownAudio])

  const setAlwaysListening = useCallback(
    (v: boolean) => {
      setAlwaysListeningState(v)
      alwaysRef.current = v
      const st = useAvcStore.getState()
      const mode = v ? 'always-listening' : 'push-to-talk'
      if (st.settings.voiceMode !== mode) {
        st.updateSettings({ voiceMode: mode })
        void fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceMode: mode }),
        }).catch(() => undefined)
      }
      if (v) {
        void startPushToTalk()
      } else {
        if (rearmTimerRef.current) clearTimeout(rearmTimerRef.current)
        if (useAvcStore.getState().voiceStatus === 'listening') {
          stopPushToTalkAndProcess()
        }
      }
    },
    [startPushToTalk, stopPushToTalkAndProcess],
  )

  const toggleAlwaysListening = useCallback(() => {
    setAlwaysListening(!alwaysRef.current)
  }, [setAlwaysListening])

  // связь взаимных ссылок между колбэками (анализатор -> stop; re-arm -> start)
  useEffect(() => {
    startRef.current = startPushToTalk
    stopRef.current = stopPushToTalkAndProcess
  }, [startPushToTalk, stopPushToTalkAndProcess])

  // при переключении режима из настроек — синхронизировать слушание
  const voiceMode = useAvcStore((s) => s.settings.voiceMode)
  useEffect(() => {
    const want = voiceMode === 'always-listening'
    if (want !== alwaysRef.current) setAlwaysListening(want)
  }, [voiceMode, setAlwaysListening])

  // очистка при размонтировании
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionSeqRef.current++
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      if (rearmTimerRef.current) clearTimeout(rearmTimerRef.current)
      const recognition = recognitionRef.current
      if (recognition) {
        recognition.onend = null
        recognition.onresult = null
        recognition.onerror = null
        try {
          recognition.abort()
        } catch {
          // уже остановлено
        }
      }
      recognitionRef.current = null
      teardownAudio()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null
        recorder.stop()
      }
      recorderRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      streamDeviceRef.current = null
      if (audioElRef.current) {
        audioElRef.current.pause()
        audioElRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [teardownAudio])

  return {
    voiceStatus,
    voiceMessage,
    isMicSupported,
    browserEngine,
    alwaysListening,
    startPushToTalk,
    stopPushToTalkAndProcess,
    toggleAlwaysListening,
    setAlwaysListening,
    speak,
    micLevel,
    interimText,
    micDevices,
    refreshMicDevices,
  }
}
