/**
 * TTS API — голосовой feedback программы (мастер-промпт #37).
 * POST { text } -> audio/wav
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string }
    if (!text?.trim()) {
      return NextResponse.json({ error: 'Поле text обязательно' }, { status: 400 })
    }
    const trimmed = text.trim().slice(0, 500)

    const zai = await ZAI.create()
    const response = await zai.audio.tts.create({
      input: trimmed,
      voice: 'tongtong',
      speed: 1.0,
      response_format: 'wav',
      stream: false,
    })
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(new Uint8Array(arrayBuffer))

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'no-cache',
      },
    })
  } catch (e) {
    console.error('[tts] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка синтеза речи' },
      { status: 500 },
    )
  }
}
