/**
 * Стриминговое распознавание (T-One Russian, sherpa-onnx, CPU) — задача 17.
 *
 * POST /api/voice/stream
 *   { action: 'start' }                          -> { sessionId } | { error }
 *   { action: 'chunk', sessionId, pcm }          -> { partial, finals, speech, chunkMs }
 *                                                   (pcm — base64 int16 16кГц)
 *   { action: 'stop',  sessionId }               -> { final }
 *
 * GET /api/voice/stream -> { status }  (диагностика)
 *
 * Приватность (§31): partial/финалы не логируются без AVC_LOG_TRANSCRIPTS=1.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  feedChunk,
  getStatus,
  startSession,
  stopSession,
} from '@/lib/avc/stt-stream'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ status: getStatus() })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { action?: string; sessionId?: string; pcm?: string }
      | null
    const action = body?.action

    if (action === 'start') {
      const res = await startSession()
      if ('error' in res) return NextResponse.json(res, { status: 503 })
      return NextResponse.json({ sessionId: res.sessionId, sampleRate: 16000 })
    }

    if (action === 'chunk') {
      const { sessionId, pcm } = body ?? {}
      if (!sessionId || !pcm) {
        return NextResponse.json({ error: 'Нужны sessionId и pcm' }, { status: 400 })
      }
      const res = feedChunk(sessionId, pcm)
      if (!res) {
        return NextResponse.json({ error: 'Сессия не найдена' }, { status: 404 })
      }
      return NextResponse.json(res)
    }

    if (action === 'stop') {
      const { sessionId } = body ?? {}
      if (!sessionId) {
        return NextResponse.json({ error: 'Нужен sessionId' }, { status: 400 })
      }
      const res = stopSession(sessionId)
      return NextResponse.json(res ?? { final: '' })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('[stream] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка стримингового распознавания' },
      { status: 500 },
    )
  }
}
