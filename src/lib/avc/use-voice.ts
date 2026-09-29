'use client'
/**
 * useVoice — клиентский голосовой слой (движки распознавания + TTS + пуш-ту-ток).
 *
 * ДВИЖКИ (мастер-промпт #9 — голосовой слой абстрактен):
 *   1. Web Speech API браузера (primary, lang=ru-RU, отлично работает в Chrome/Edge) —
 *      веб-аналог локального Windows Speech Recognition.
 *   2. Серверный ASR (/api/voice/asr, z-ai-web-dev-sdk) — fallback для браузеров
 *      без Web Speech API (например Firefox).
 *
 * Push-to-talk: удержание кнопки или Ctrl+Space; остановка — отпустить
 * (для серверного движка — автоостановка по тишине, максимум 8 с).
 * Always-listening: после каждой обработки микрофон перезахватывается через 400 мс;
 * wake word (если включён) отфильтровывает фразы не для приложения.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { executeText } from './executor'
import { useAvcStore, VoiceStatus } from './store'

const SILENCE_RMS = 0.015
const SILENCE_MS = 1300
const MIN_UTTERANCE_MS = 700
const MAX_UTTERANCE_MS = 8000
const REARM_DELAY_MS = 400
const ERROR_CLEAR_MS = 4000

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

export interface VoiceApi {
  voiceStatus: VoiceStatus
  voiceMessage: string
  isMicSupported: boolean
  /** true — основной движок: Web Speech API браузера (ru-RU) */
  browserEngine: boolean
  alwaysListening: boolean
  startPushToTalk: () => Promise<void>
  stopPushToTalkAndProcess: () => void
  toggleAlwaysListening: () => void
  setAlwaysListening: (v: boolean) => void
  speak: (text: string) => Promise<void>
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

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = Array.from(bytes.subarray(i, i + chunkSize))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export function useVoice(): VoiceApi {
  const voiceStatus = useAvcStore((s) => s.voiceStatus)
  const voiceMessage = useAvcStore((s) => s.voiceMessage)

  // При SSR считаем микрофон поддержанным (true), чтобы hydration совпадал;
  // фактическую поддержку уточняем после монтирования.
  const [isMicSupported, setIsMicSupported] = useState<boolean>(true)
  const [browserEngine, setBrowserEngine] = useState<boolean>(false)
  useEffect(() => {
    setIsMicSupported(
      typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    )
    setBrowserEngine(getSpeechRecognitionCtor() !== null)
  }, [])
  const [alwaysListening, setAlwaysListeningState] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processingRef = useRef(false)
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

  const stopAnalyser = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined)
      audioCtxRef.current = null
    }
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

  const processRecording = useCallback(async () => {
    // Серверный движок (MediaRecorder → /api/voice/asr)
    if (processingRef.current) return
    processingRef.current = true
    const setVoiceStatus = useAvcStore.getState().setVoiceStatus
    try {
      if (chunksRef.current.length === 0) {
        setVoiceStatus('idle')
        return
      }
      const mime = recorderRef.current?.mimeType || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type: mime })
      chunksRef.current = []
      setVoiceStatus('recognizing', 'Распознаю...')

      const buf = await blob.arrayBuffer()
      const base64 = bufferToBase64(buf)
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64 }),
      })
      if (!res.ok) {
        const errData = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(errData?.error ?? `ASR HTTP ${res.status}`)
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text ?? '').trim()
      if (!text) {
        setVoiceStatus('idle', 'Речь не распознана')
        return
      }
      processingRef.current = false
      await handleRecognizedText(text)
    } catch (e) {
      setVoiceStatus('error', e instanceof Error && e.message ? e.message : 'Ошибка распознавания. Попробуйте ещё раз.')
      scheduleErrorClear()
      processingRef.current = false
      rearmIfNeeded()
    }
  }, [scheduleErrorClear, rearmIfNeeded, handleRecognizedText])

  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    const existing = streamRef.current
    if (existing && existing.active) return existing
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    streamRef.current = stream
    return stream
  }, [])

  const startAnalyser = useCallback((stream: MediaStream) => {
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      audioCtxRef.current = ctx
      analyserRef.current = analyser
      silenceStartRef.current = null

      const tick = () => {
        if (!analyserRef.current || !mountedRef.current) return
        const data = new Uint8Array(analyserRef.current.fftSize)
        analyserRef.current.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        const now = performance.now()
        if (rms < SILENCE_RMS) {
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
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch {
      // анализатор тишины не обязателен
    }
  }, [])

  const startPushToTalk = useCallback(async () => {
    const st = useAvcStore.getState()
    if (st.voiceStatus === 'listening' || processingRef.current) return
    if (!isMicSupported) {
      st.setVoiceStatus('error', 'Микрофон не поддерживается этим браузером')
      scheduleErrorClear()
      return
    }

    // --- Движок 1: Web Speech API (ru-RU) ---
    const SRCtor = getSpeechRecognitionCtor()
    if (SRCtor) {
      try {
        const recognition = new SRCtor()
        recognition.lang = 'ru-RU'
        recognition.continuous = false
        recognition.interimResults = true
        recognition.maxAlternatives = 1
        finalTranscriptRef.current = ''
        recognitionActiveRef.current = true
        recognition.onresult = (e: SpeechRecognitionEventLike) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i]
            if (res.isFinal) {
              finalTranscriptRef.current += ' ' + res[0].transcript
            }
          }
        }
        recognition.onerror = (e: SpeechRecognitionErrorEventLike) => {
          recognitionActiveRef.current = false
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            useAvcStore
              .getState()
              .setVoiceStatus('error', 'Нет доступа к микрофону. Проверьте разрешения браузера.')
            scheduleErrorClear()
          } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
            useAvcStore.getState().setVoiceStatus('error', `Ошибка распознавания: ${e.error}`)
            scheduleErrorClear()
          }
        }
        recognition.onend = () => {
          recognitionActiveRef.current = false
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
        st.setVoiceStatus('listening', 'Слушаю...')
        return
      } catch {
        // не удалось запустить Web Speech — падаем на серверный движок
        recognitionRef.current = null
      }
    }

    // --- Движок 2 (fallback): MediaRecorder + серверный ASR ---
    try {
      const stream = await ensureStream()
      const recorder = new MediaRecorder(stream, pickRecorderOptions())
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
      startAnalyser(stream)
      st.setVoiceStatus('listening', 'Слушаю...')
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      maxTimerRef.current = setTimeout(() => {
        stopRef.current?.()
      }, MAX_UTTERANCE_MS)
    } catch {
      useAvcStore
        .getState()
        .setVoiceStatus('error', 'Не удалось получить доступ к микрофону. Проверьте разрешения.')
      scheduleErrorClear()
    }
  }, [ensureStream, isMicSupported, processRecording, scheduleErrorClear, startAnalyser, handleRecognizedText, rearmIfNeeded])

  const stopPushToTalkAndProcess = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    // Web Speech: остановка — результат придёт в onend
    const recognition = recognitionRef.current
    if (recognition && recognitionActiveRef.current) {
      try {
        recognition.stop()
      } catch {
        recognitionActiveRef.current = false
      }
      return
    }
    // Серверный движок
    stopAnalyser()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    recorderRef.current = null
  }, [stopAnalyser])

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
      stopAnalyser()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null
        recorder.stop()
      }
      recorderRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (audioElRef.current) {
        audioElRef.current.pause()
        audioElRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [stopAnalyser])

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
  }
}
