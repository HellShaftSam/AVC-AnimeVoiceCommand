/**
 * ASR API (ЛОКАЛЬНЫЙ офлайн-движок) — мост к Electron bridge (Task 16-b).
 *
 * В приложении AVC (EXE) main.cjs поднимает локальный HTTP-мост
 * (127.0.0.1:<port>/asr) с офлайн-STT (sherpa-onnx + модель T-One, ru) и
 * передаёт его адрес в окружение встроенного Next.js сервера:
 *   AVC_BRIDGE_URL / AVC_SPEECH_URL = http://127.0.0.1:<bridgePort>
 *
 * Этот маршрут принимает тот же JSON, что и /api/voice/asr
 * ({ audio: <base64>, mime: 'audio/wav' | 'audio/webm;codecs=opus' | ... }),
 * пересылает аудио в мост и возвращает { text }.
 *
 * В веб-песочнице (AVC_BRIDGE_URL не задан) делается ОДНА попытка на
 * http://127.0.0.1:3010/asr (dev-порт моста); если мост не отвечает —
 * честный 503 с понятным сообщением.
 */
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Дружелюбные русские сообщения для кодов ошибок моста */
const BRIDGE_ERROR_MESSAGES: Record<string, string> = {
  SPEECH_NATIVE_UNAVAILABLE: 'Локальное распознавание недоступно: не загружен sherpa-onnx',
  SPEECH_MODEL_UNAVAILABLE: 'Локальная модель не загружена',
  SPEECH_AUDIO_TOO_SHORT: 'Аудио слишком короткое',
  SPEECH_DECODE_FAILED: 'Не удалось декодировать аудио для локального распознавания',
  SPEECH_RECOGNIZE_FAILED: 'Ошибка локального распознавания. Попробуйте ещё раз.',
  SPEECH_UNAVAILABLE: 'Локальное распознавание недоступно',
}

/** Сокращаем время ожидания моста: распознавание фразы занимает секунды, не минуты */
const BRIDGE_TIMEOUT_MS = 25_000

function bridgeUrl(): string | null {
  return process.env.AVC_BRIDGE_URL || process.env.AVC_SPEECH_URL || null
}

async function callBridge(base: string, audioBase64: string, mime: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS)
  try {
    return await fetch(`${base.replace(/\/+$/, '')}/asr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: audioBase64, mime }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError' || /fetch|network|ECONNREFUSED|ECONNRESET|socket/i.test(e.message))
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { audio?: string; audio_base64?: string; mime?: string }
      | null
    const audioBase64 = (body?.audio ?? body?.audio_base64 ?? '').replace(/^data:[^;]+;base64,/, '')
    if (!audioBase64 || audioBase64.length < 100) {
      return NextResponse.json({ error: 'Аудио слишком короткое' }, { status: 400 })
    }
    const mime = body?.mime || 'audio/wav'

    // Адрес моста: env от Electron main (EXE) либо dev-порт моста в песочнице
    const base = bridgeUrl() ?? 'http://127.0.0.1:3010'
    const explicitBridge = Boolean(bridgeUrl())

    let res: Response
    try {
      res = await callBridge(base, audioBase64, mime)
    } catch {
      // мост не отвечает
      const msg = explicitBridge
        ? 'Локальный STT-мост недоступен'
        : 'Локальный STT доступен только в приложении AVC (EXE)'
      return NextResponse.json({ error: msg }, { status: 503 })
    }

    if (res.status === 200) {
      const data = (await res.json().catch(() => null)) as { text?: string } | null
      const text = (data?.text ?? '').trim()
      return NextResponse.json({ text, success: text.length > 0 })
    }

    const data = (await res.json().catch(() => null)) as { error?: string } | null
    const code = data?.error ?? ''
    const msg =
      BRIDGE_ERROR_MESSAGES[code] ??
      (isNetworkError(code) ? 'Локальный STT-мост недоступен' : 'Локальное распознавание не удалось')
    return NextResponse.json({ error: msg }, { status: 503 })
  } catch (e) {
    console.error('[asr-local] error:', e)
    return NextResponse.json(
      { error: 'Ошибка локального распознавания речи' },
      { status: 500 },
    )
  }
}
