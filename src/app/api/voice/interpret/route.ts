/**
 * LLMCommandInterpreter — опциональный продвинутый интерпретатор
 * (мастер-промпт #109, #110). Вызывается ТОЛЬКО когда локальный парсер
 * вернул низкий confidence или не распознал фразу.
 *
 * POST { text, context, candidates? } -> VoiceCommand[] | null
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { BrowserContext, VoiceCommand, VoiceCommandType } from '@/lib/avc/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const VALID_TYPES = new Set<string>(Object.values(VoiceCommandType))

export async function POST(req: NextRequest) {
  try {
    const { text, context } = (await req.json()) as {
      text?: string
      context?: BrowserContext
    }
    if (!text?.trim()) {
      return NextResponse.json({ error: 'Поле text обязательно' }, { status: 400 })
    }

    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Ты — парсер голосовых команд приложения "Anime Voice Controller" для управления аниме-сайтом.
Преобразуй русскую фразу в JSON-массив команд. Доступные типы:
OpenHome, OpenCatalog, OpenTop100, OpenOngoing, OpenAnnouncements, OpenSchedule, OpenRandom,
SearchAnime(query), OpenAnime(query), SelectEpisode(episode), NextEpisode, PreviousEpisode,
Play, Pause, TogglePlayPause, SeekForward(seconds), SeekBackward(seconds),
VolumeUp, VolumeDown, SetVolume(volume), Fullscreen, ExitFullscreen,
OpenNewTab, CloseTab, NextTab, PreviousTab, SelectTab(index), Reload, Back, Forward,
ScrollUp, ScrollDown, SelectVoice(dub), ShowEpisodes, ShowHelp, SelectOption(index), Unknown.

Правила:
- Верни СТРОГО JSON: {"commands":[{"type":"...","params":{...},"confidence":0.0-1.0}]}
- "найди/поищи X" -> SearchAnime с params.query
- "открой X" где X - название аниме -> SearchAnime с params.query и params.open=true
- "серия 5"/"пятая серия"/"включи пятую" -> SelectEpisode params.episode=5
- "вперед на 10 секунд" -> SeekForward params.seconds=10
- Если фраза не про управление аниме — верни Unknown с confidence 0.
- Никакого текста кроме JSON.`,
        },
        {
          role: 'user',
          content: `Контекст: секция=${context?.navigation?.currentSection ?? 'home'}, аниме=${context?.playback?.animeTitle ?? 'нет'}, серия=${context?.playback?.currentEpisode ?? 'нет'}, играет=${context?.playback?.isPlaying ?? false}.
Фраза: "${text.trim()}"`,
        },
      ],
      temperature: 0.1,
      max_tokens: 300,
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ commands: null })
    }

    const parsed = JSON.parse(jsonMatch[0]) as { commands?: Array<{ type: string; params?: Record<string, unknown>; confidence?: number }> }
    const commands: VoiceCommand[] = (parsed.commands ?? [])
      .filter((c) => VALID_TYPES.has(c.type))
      .map((c) => ({
        type: c.type as VoiceCommandType,
        params: (c.params ?? {}) as VoiceCommand['params'],
        confidence: Math.min(1, Math.max(0, c.confidence ?? 0.7)),
        label: `${c.type}`,
      }))

    return NextResponse.json({ commands: commands.length ? commands : null })
  } catch (e) {
    console.error('[interpret] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка LLM-интерпретации' },
      { status: 500 },
    )
  }
}
