'use client'
/**
 * SettingsDialog — настройки приложения. Каждое изменение мгновенно в store,
 * затем debounce 600 мс -> PUT /api/settings.
 *
 * Вкладки:
 *  - Общие: микрофон-режим, wake word, голос, воспроизведение, сайт, приватность;
 *  - Микрофон: движок STT, устройство, усиление/чувствительность, шумоподавление,
 *    тест микрофона (3.5 с запись → WAV 16 кГц → /api/voice/asr) с живым уровнем;
 *  - Озвучки: пользовательские алиасы произношения (требуют входа).
 *
 * Примечание: список устройств берётся напрямую через listMicDevices() — это тот же
 * источник данных, что и voice.micDevices, но диалог не должен зависеть от чужого
 * экземпляра хука useVoice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Mic, RefreshCw, X } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, getElectronBridge, type AiHardwareInfo, type AiStatusSnapshot } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import type { AiProfile, AppSettings, SttEngine } from '@/lib/avc/types'
import {
  buildAudioConstraints,
  bufferToBase64,
  createMicChain,
  encodeWav16kMono,
  listMicDevices,
  rmsLevel,
  type MicChain,
} from '@/lib/voice/audio-utils'
import { DEFAULT_VOICE_ALIASES } from '@/lib/voice/provider-resolver'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-400/90">
      {children}
    </h3>
  )
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useAvcStore((s) => s.settingsOpen)
  const setOpen = useAvcStore((s) => s.setSettingsOpen)
  const settings = useAvcStore((s) => s.settings)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const change = (partial: Partial<AppSettings>) => {
    updateSettings(partial)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useAvcStore.getState().settings),
      }).catch(() => undefined)
    }, 600)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>
            Изменения применяются сразу и сохраняются автоматически.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="shrink-0 bg-zinc-900/70">
            <TabsTrigger value="general" className="data-[state=active]:text-amber-300">
              Общие
            </TabsTrigger>
            <TabsTrigger value="mic" className="data-[state=active]:text-amber-300">
              Микрофон
            </TabsTrigger>
            <TabsTrigger value="voices" className="data-[state=active]:text-amber-300">
              Озвучки
            </TabsTrigger>
            <TabsTrigger value="ai" className="data-[state=active]:text-amber-300">
              AI
            </TabsTrigger>
          </TabsList>

          <div className="avc-scroll -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            {/* ------------------------------------------------ Общие */}
            <TabsContent value="general" className="mt-0 space-y-3">
              <section>
                <SectionTitle>Общие</SectionTitle>
                <div className="py-1">
                  <div className="text-sm text-zinc-200">Режим микрофона</div>
                  <RadioGroup
                    value={settings.voiceMode}
                    onValueChange={(v: string) =>
                      change({
                        voiceMode: v === 'always-listening' ? 'always-listening' : 'push-to-talk',
                      })
                    }
                    className="mt-2 gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="push-to-talk" id="vm-ptt" />
                      <Label htmlFor="vm-ptt" className="text-sm text-zinc-300">
                        Рация — удерживать кнопку / Ctrl+Space
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="always-listening" id="vm-always" />
                      <Label htmlFor="vm-always" className="text-sm text-zinc-300">
                        Постоянное слушание (с автоостановкой по тишине)
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
                <SettingRow label="Wake word" hint="Команды только после слова-активатора">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={settings.wakeWordEnabled}
                      onCheckedChange={(v: boolean) => change({ wakeWordEnabled: v })}
                      aria-label="Включить wake word"
                    />
                    <Input
                      value={settings.wakeWord}
                      onChange={(e) => change({ wakeWord: e.target.value })}
                      disabled={!settings.wakeWordEnabled}
                      aria-label="Слово-активатор"
                      className="h-9 w-28 border-zinc-800 bg-zinc-900"
                    />
                  </div>
                </SettingRow>
                <SettingRow label="Режим дивана" hint="Крупный интерфейс с дивана">
                  <Switch
                    checked={settings.couchMode}
                    onCheckedChange={(v: boolean) => change({ couchMode: v })}
                    aria-label="Режим дивана"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-zinc-800" />

              <section>
                <SectionTitle>Голос</SectionTitle>
                <div className="py-2">
                  <div className="flex items-center justify-between text-sm text-zinc-200">
                    <span>Порог уверенности</span>
                    <span className="tabular-nums text-amber-300">
                      {Math.round(settings.confidenceThreshold * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.confidenceThreshold]}
                    min={0.3}
                    max={0.9}
                    step={0.05}
                    aria-label="Порог уверенности распознавания"
                    className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
                    onValueChange={(v: number[]) => {
                      const val = Array.isArray(v) ? v[0] : undefined
                      if (typeof val === 'number') change({ confidenceThreshold: val })
                    }}
                  />
                </div>
                <SettingRow label="Голосовые ответы" hint="Озвучивать результаты команд (TTS)">
                  <Switch
                    checked={settings.ttsEnabled}
                    onCheckedChange={(v: boolean) => change({ ttsEnabled: v })}
                    aria-label="Голосовые ответы"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-zinc-800" />

              <section>
                <SectionTitle>Воспроизведение</SectionTitle>
                <SettingRow label="Шаг перемотки">
                  <Select
                    value={String(settings.seekStep)}
                    onValueChange={(v: string) => change({ seekStep: Number(v) })}
                  >
                    <SelectTrigger
                      aria-label="Шаг перемотки"
                      className="h-9 w-24 border-zinc-800 bg-zinc-900"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-800 bg-zinc-900">
                      <SelectItem value="5">5 сек</SelectItem>
                      <SelectItem value="10">10 сек</SelectItem>
                      <SelectItem value="30">30 сек</SelectItem>
                      <SelectItem value="60">60 сек</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Шаг громкости">
                  <Select
                    value={String(settings.volumeStep)}
                    onValueChange={(v: string) => change({ volumeStep: Number(v) })}
                  >
                    <SelectTrigger
                      aria-label="Шаг громкости"
                      className="h-9 w-24 border-zinc-800 bg-zinc-900"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-800 bg-zinc-900">
                      <SelectItem value="5">5%</SelectItem>
                      <SelectItem value="10">10%</SelectItem>
                      <SelectItem value="20">20%</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <div className="py-2">
                  <div className="flex items-center justify-between text-sm text-zinc-200">
                    <span>Громкость по умолчанию</span>
                    <span className="tabular-nums text-amber-300">{settings.defaultVolume}%</span>
                  </div>
                  <Slider
                    value={[settings.defaultVolume]}
                    min={0}
                    max={100}
                    step={5}
                    aria-label="Громкость по умолчанию"
                    className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
                    onValueChange={(v: number[]) => {
                      const val = Array.isArray(v) ? v[0] : undefined
                      if (typeof val === 'number') change({ defaultVolume: val })
                    }}
                  />
                </div>
                <SettingRow label="Автопереход к следующей серии">
                  <Switch
                    checked={settings.autoplayNext}
                    onCheckedChange={(v: boolean) => change({ autoplayNext: v })}
                    aria-label="Автопереход к следующей серии"
                  />
                </SettingRow>
                <SettingRow
                  label="Автопропуск опенинга/эндинга"
                  hint="Перематывает интро по таймингам сайта, если они есть"
                >
                  <Switch
                    checked={settings.autoSkipIntros}
                    onCheckedChange={(v: boolean) => change({ autoSkipIntros: v })}
                    aria-label="Автопропуск опенинга и эндинга"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-zinc-800" />

              <section>
                <SectionTitle>Сайт</SectionTitle>
                <SettingRow label="Базовый URL" hint="Адрес аниме-сайта для адаптера">
                  <Input
                    value={settings.baseUrl}
                    onChange={(e) => change({ baseUrl: e.target.value })}
                    aria-label="Базовый URL сайта"
                    className="h-9 w-56 border-zinc-800 bg-zinc-900 text-xs"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-zinc-800" />

              <section>
                <SectionTitle>Приватность</SectionTitle>
                <SettingRow label="Сохранять историю команд">
                  <Switch
                    checked={settings.saveHistory}
                    onCheckedChange={(v: boolean) => change({ saveHistory: v })}
                    aria-label="Сохранять историю"
                  />
                </SettingRow>
                <SettingRow
                  label="LLM-fallback"
                  hint="Если локальный парсер не уверен — фраза уходит в LLM"
                >
                  <Switch
                    checked={settings.llmFallback}
                    onCheckedChange={(v: boolean) => change({ llmFallback: v })}
                    aria-label="LLM-fallback"
                  />
                </SettingRow>
              </section>
            </TabsContent>

            {/* ------------------------------------------------ Микрофон */}
            <TabsContent value="mic" className="mt-0 space-y-3">
              <MicSettings change={change} />
            </TabsContent>

            {/* ------------------------------------------------ Озвучки */}
            <TabsContent value="voices" className="mt-0">
              <VoiceAliasesSettings />
            </TabsContent>

            {/* ------------------------------------------------ Локальный AI */}
            <TabsContent value="ai" className="mt-0">
              <AiSettingsPanel change={change} />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «Микрофон»
// ---------------------------------------------------------------------------

function MicSettings({ change }: { change: (partial: Partial<AppSettings>) => void }) {
  const settings = useAvcStore((s) => s.settings)
  const open = useAvcStore((s) => s.settingsOpen)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'recording' | 'recognizing'>('idle')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [liveLevel, setLiveLevel] = useState(0)

  /** Всё, что надо погасить, если диалог закрыли посреди проверки */
  const testCleanupRef = useRef<(() => void) | null>(null)

  const refreshDevices = useCallback(async () => {
    setRefreshing(true)
    try {
      setMicDevices(await listMicDevices())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Список устройств обновляется при открытии диалога (permission могли выдать недавно)
  useEffect(() => {
    if (open) void refreshDevices()
  }, [open, refreshDevices])

  // Остановка теста при закрытии диалога/размонтировании
  useEffect(() => {
    return () => {
      testCleanupRef.current?.()
    }
  }, [])

  const runMicTest = async () => {
    if (testState !== 'idle') return
    setTestError(null)
    setTestResult(null)
    setLiveLevel(0)

    let stream: MediaStream | null = null
    let chain: MicChain | null = null
    let raf = 0
    let recorder: MediaRecorder | null = null

    const cleanup = () => {
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void chain?.ctx.close().catch(() => undefined)
      testCleanupRef.current = null
    }
    testCleanupRef.current = cleanup

    try {
      setTestState('recording')
      stream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints(settings) })
      chain = createMicChain(stream, settings.micGain)

      // Живой уровень (RMS) с анализатора — уже усиленного сигнала
      const tick = () => {
        setLiveLevel(rmsLevel(chain!.analyser))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)

      // 3.5 секунды записи из обработанного потока (micGain применён)
      const chunks: Blob[] = []
      recorder = new MediaRecorder(chain.destination.stream)
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const stopped = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve()
      })
      recorder.start()
      await new Promise((r) => setTimeout(r, 3500))
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped

      cleanup()
      setLiveLevel(0)
      setTestState('recognizing')

      // gain уже применён в цепочке — здесь 1, чтобы не усилить дважды
      const wav = await encodeWav16kMono(new Blob(chunks), 1)
      const audio = bufferToBase64(await wav.arrayBuffer())
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, mime: 'audio/wav' }),
      })
      const data = (await res.json()) as { text?: string; error?: string }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const text = data.text?.trim()
      setTestResult(text ? `Распознано: «${text}»` : 'Речь не распознана — попробуйте ещё раз')
    } catch (e) {
      cleanup()
      setLiveLevel(0)
      setTestError(
        e instanceof Error && e.message ? e.message : 'Не удалось проверить микрофон',
      )
    } finally {
      setTestState('idle')
    }
  }

  const levelPct = Math.round(Math.min(1, Math.max(0, liveLevel)) * 100)
  const levelColor =
    levelPct < 30 ? 'bg-zinc-600' : levelPct < 70 ? 'bg-amber-400' : 'bg-rose-500'

  return (
    <div>
      <section>
        <SectionTitle>Движок распознавания</SectionTitle>
        <SettingRow
          label="Движок STT"
          hint="В EXE «Авто» = локальный офлайн-движок (T-One). Браузерный доступен только в web-версии (Chrome/Edge)"
        >
          <Select
            value={settings.sttEngine}
            onValueChange={(v: string) => change({ sttEngine: v as SttEngine })}
          >
            <SelectTrigger aria-label="Движок распознавания" className="h-9 w-52 border-zinc-800 bg-zinc-900 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="auto">Авто (браузер → сервер)</SelectItem>
              <SelectItem value="browser">Браузерный (Chrome/Edge)</SelectItem>
              <SelectItem value="server">Серверный (Whisper)</SelectItem>
              <SelectItem value="local">Локальный (T-One, офлайн)</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      <Separator className="bg-zinc-800" />

      <section>
        <SectionTitle>Микрофон</SectionTitle>
        <SettingRow
          label="Устройство"
          hint={micDevices.length === 0 ? 'Разрешите доступ к микрофону' : undefined}
        >
          <div className="flex items-center gap-1.5">
            <Select
              value={settings.micDeviceId || '__default__'}
              onValueChange={(v: string) => change({ micDeviceId: v === '__default__' ? '' : v })}
              disabled={micDevices.length === 0}
            >
              <SelectTrigger
                aria-label="Устройство микрофона"
                className="h-9 w-44 border-zinc-800 bg-zinc-900 text-xs"
              >
                <SelectValue placeholder="По умолчанию" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="__default__">По умолчанию</SelectItem>
                {micDevices.map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 12)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label="Обновить список микрофонов"
              title="Обновить список"
              onClick={() => void refreshDevices()}
              className="h-9 w-9 shrink-0 border-zinc-800 bg-zinc-900 hover:border-amber-400/50 hover:text-amber-300"
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
        </SettingRow>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-zinc-200">
            <span>Усиление микрофона</span>
            <span className="tabular-nums text-amber-300">×{settings.micGain}</span>
          </div>
          <Slider
            value={[settings.micGain]}
            min={1}
            max={4}
            step={0.25}
            aria-label="Усиление микрофона"
            className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ micGain: val })
            }}
          />
          <p className="mt-1.5 text-xs text-zinc-500">
            Если вы далеко от микрофона — поставьте 2–3
          </p>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-zinc-200">
            <span>Чувствительность</span>
            <span className="tabular-nums text-amber-300">{settings.vadSensitivity}</span>
          </div>
          <Slider
            value={[settings.vadSensitivity]}
            min={0}
            max={100}
            step={1}
            aria-label="Чувствительность к тишине"
            className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ vadSensitivity: val })
            }}
          />
          <p className="mt-1.5 text-xs text-zinc-500">Выше = лучше ловит тихую речь</p>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-zinc-200">
            <span>Максимальная длительность фразы</span>
            <span className="tabular-nums text-amber-300">
              {Math.round(settings.maxUtteranceMs / 1000)} с
            </span>
          </div>
          <Slider
            value={[settings.maxUtteranceMs]}
            min={4000}
            max={30000}
            step={1000}
            aria-label="Максимальная длительность фразы"
            className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ maxUtteranceMs: val })
            }}
          />
          <p className="mt-1.5 text-xs text-zinc-500">
            Если микрофон обрезает длинные фразы — увеличьте до 20–30 с
          </p>
        </div>

        <SettingRow label="Шумоподавление">
          <Switch
            checked={settings.noiseSuppression}
            onCheckedChange={(v: boolean) => change({ noiseSuppression: v })}
            aria-label="Шумоподавление"
          />
        </SettingRow>
        <SettingRow label="Автоусиление" hint="Автоматическая регулировка усиления (AGC)">
          <Switch
            checked={settings.autoGainControl}
            onCheckedChange={(v: boolean) => change({ autoGainControl: v })}
            aria-label="Автоусиление"
          />
        </SettingRow>
        <SettingRow label="Эхоподавление">
          <Switch
            checked={settings.echoCancellation}
            onCheckedChange={(v: boolean) => change({ echoCancellation: v })}
            aria-label="Эхоподавление"
          />
        </SettingRow>

        {/* Проверка микрофона */}
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-zinc-200">Проверить микрофон</div>
              <div className="text-xs text-zinc-500">Запись 3.5 с и серверное распознавание</div>
            </div>
            <Button
              variant="outline"
              onClick={() => void runMicTest()}
              disabled={testState !== 'idle'}
              aria-label="Проверить микрофон"
              className="min-h-11 shrink-0 gap-1.5 border-zinc-700 bg-zinc-900 hover:border-amber-400/50 hover:text-amber-300"
            >
              {testState !== 'idle' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Mic className="h-4 w-4" aria-hidden />
              )}
              {testState === 'recording'
                ? 'Говорите…'
                : testState === 'recognizing'
                  ? 'Распознаю…'
                  : 'Проверить'}
            </Button>
          </div>

          {testState === 'recording' && (
            <div
              className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
              role="meter"
              aria-label="Уровень записи"
              aria-valuenow={levelPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn('h-full rounded-full transition-all duration-75', levelColor)}
                style={{ width: `${levelPct}%` }}
              />
            </div>
          )}
          {testResult && <p className="mt-2 text-xs text-emerald-400">{testResult}</p>}
          {testError && (
            <p role="alert" className="mt-2 text-xs text-rose-400">
              {testError}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «Озвучки» — пользовательские алиасы произношения
// ---------------------------------------------------------------------------

function VoiceAliasesSettings() {
  const voiceAliases = useAvcStore((s) => s.voiceAliases)
  const setVoiceAliases = useAvcStore((s) => s.setVoiceAliases)
  const [aliasInput, setAliasInput] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [openList, setOpenList] = useState(false)

  const addAlias = async () => {
    const alias = aliasInput.trim()
    const target = targetInput.trim()
    if (!alias || !target) {
      toast({ variant: 'destructive', description: 'Заполните оба поля' })
      return
    }
    setBusy(true)
    try {
      const row = await avcApi.addAlias(target, alias)
      if (!row) {
        toast({ variant: 'destructive', description: 'Войдите, чтобы сохранять алиасы' })
        return
      }
      setVoiceAliases([...voiceAliases, row])
      setAliasInput('')
      setTargetInput('')
      toast({ description: `Алиас «${alias}» → «${target}» сохранён` })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось сохранить алиас' })
    } finally {
      setBusy(false)
    }
  }

  const removeAlias = async (id: string) => {
    const ok = await avcApi.deleteAlias(id)
    if (ok) {
      setVoiceAliases(voiceAliases.filter((r) => r.id !== id))
    } else {
      toast({ variant: 'destructive', description: 'Не удалось удалить алиас' })
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-400/90">
          Мои алиасы озвучек
        </h3>
        <p className="text-xs text-zinc-500">
          Скажите: «добавь ани либрия как команду для AniLibria» — и приложение запомнит
        </p>
      </div>

      {voiceAliases.length > 0 && (
        <ul className="space-y-1.5">
          {voiceAliases.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-2"
            >
              <span className="min-w-0 truncate text-sm">
                <span className="text-zinc-100">«{row.alias}»</span>
                <span className="mx-1.5 text-zinc-600">→</span>
                <span className="text-amber-300">{row.targetName}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Удалить алиас ${row.alias}`}
                onClick={() => void removeAlias(row.id)}
                className="h-8 w-8 shrink-0 rounded-full text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(
        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="avc-alias-input" className="text-xs text-zinc-400">
              Произношение (как вы это говорите)
            </Label>
            <Input
              id="avc-alias-input"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="ани либрия"
              aria-label="Алиас произношения"
              className="h-10 border-zinc-800 bg-zinc-900 focus-visible:ring-amber-400/50"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="avc-alias-target" className="text-xs text-zinc-400">
              Официальное имя озвучки
            </Label>
            <Input
              id="avc-alias-target"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder="AniLibria"
              aria-label="Официальное имя озвучки"
              className="h-10 border-zinc-800 bg-zinc-900 focus-visible:ring-amber-400/50"
            />
          </div>
          <Button
            onClick={() => void addAlias()}
            disabled={busy || !aliasInput.trim() || !targetInput.trim()}
            aria-label="Добавить алиас"
            className="min-h-11 w-full gap-1.5 bg-amber-400 text-zinc-950 hover:bg-amber-300"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Добавить
          </Button>
        </div>
      )}

      <Collapsible open={openList} onOpenChange={setOpenList}>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-xs font-medium text-zinc-300 hover:border-amber-400/40 hover:text-amber-300">
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
          Встроенные варианты произношения
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            {Object.entries(DEFAULT_VOICE_ALIASES).map(([target, aliases]) => (
              <li key={target} className="text-xs leading-relaxed">
                <span className="font-medium text-amber-300">{target}</span>
                <span className="text-zinc-600"> — </span>
                <span className="text-zinc-400">{aliases.join(', ')}</span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «AI» — локальный AI-слой (спецификация §96–§98)
// ---------------------------------------------------------------------------

function AiSettingsPanel({ change }: { change: (partial: Partial<AppSettings>) => void }) {
  const settings = useAvcStore((s) => s.settings)
  const [status, setStatus] = useState<AiStatusSnapshot | null>(null)
  const [hardware, setHardware] = useState<AiHardwareInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const isExe = typeof window !== 'undefined' && !!getElectronBridge()?.ai?.available

  const refresh = useCallback(async () => {
    const ai = getElectronBridge()?.ai
    if (!ai?.available) return
    try {
      setStatus(await ai.getStatus())
      setHardware(await ai.getHardware())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    if (!isExe) return
    void refresh()
  }, [isExe, refresh])

  if (!isExe) {
    return (
      <div className="space-y-3">
        <section>
          <SectionTitle>Локальный AI</SectionTitle>
          <p className="py-2 text-sm text-zinc-400">
            Локальный AI (офлайн-распознавание T-One, локальный роутер Qwen3 и голосовые ответы)
            доступен в приложении AVC-Anime (EXE). В браузере используются браузерное/серверное
            распознавание и облачный fallback.
          </p>
        </section>
      </div>
    )
  }

  const readyBadge = (ready: boolean, state: string, error: string | null) => {
    if (ready) return <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-400">READY</span>
    if (error) return <span className="rounded bg-rose-950 px-1.5 py-0.5 text-[11px] text-rose-400">ОШИБКА</span>
    return <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{state || 'OFF'}</span>
  }

  return (
    <div className="space-y-3">
      <section>
        <SectionTitle>Локальный AI</SectionTitle>
        <SettingRow label="Профиль производительности" hint="Максимальная отзывчивость — минимум задержек (§19)">
          <Select
            value={settings.aiProfile}
            onValueChange={(v: string) => {
              change({ aiProfile: v as AiProfile })
              void getElectronBridge()?.ai?.setProfile(v)
            }}
          >
            <SelectTrigger aria-label="Профиль AI" className="h-9 w-56 border-zinc-800 bg-zinc-900 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="max_responsiveness">Максимальная отзывчивость</SelectItem>
              <SelectItem value="balanced">Сбалансированный</SelectItem>
              <SelectItem value="quality">Качество</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Локальная озвучка ответов" hint="Офлайн TTS вместо облачного">
          <Switch
            checked={settings.aiLocalTts}
            onCheckedChange={(v: boolean) => change({ aiLocalTts: v })}
            aria-label="Локальная озвучка ответов"
          />
        </SettingRow>
        <SettingRow label="Голос" hint="Русский голос офлайн-синтеза">
          <Select
            value={settings.aiVoice}
            onValueChange={(v: string) => {
              change({ aiVoice: v })
              void getElectronBridge()?.ai?.setVoice(v)
            }}
          >
            <SelectTrigger aria-label="Голос TTS" className="h-9 w-52 border-zinc-800 bg-zinc-900 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              {(status?.voices ?? [{ id: 'irina', name: 'Ирина (женский)', default: true }]).map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      <Separator className="bg-zinc-800" />

      <section>
        <SectionTitle>Модели и диагностика</SectionTitle>
        {hardware && (
          <div className="mb-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-400">
            {hardware.cpu} · RAM {hardware.ramHuman}
            {hardware.gpu?.name ? ` · GPU ${hardware.gpu.name}` : ''}
            {hardware.freeDisk != null ? ` · диск ${(hardware.freeDisk / 1024 / 1024 / 1024).toFixed(1)} ГБ` : ''}
          </div>
        )}
        {status ? (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-1.5">
              {status.models.map((m) => (
                <div key={m.key} className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs">
                  <span className="truncate text-zinc-300">{m.name}</span>
                  <span className={m.installed ? 'text-emerald-400' : 'text-amber-400'}>
                    {m.installed ? 'Установлено' : 'Не установлено'}
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <div className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs">
                <span className="text-zinc-300">STT · T-One (распознавание)</span>
                <span className="flex items-center gap-2">
                  {status.stt.lastFinalMs != null && <span className="text-zinc-500">{status.stt.lastFinalMs} мс</span>}
                  {readyBadge(status.ready.stt, status.stt.state, status.stt.error)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs">
                <span className="text-zinc-300">LLM · Qwen3 (семантика)</span>
                <span className="flex items-center gap-2">
                  {status.llm.lastRouteMs != null && <span className="text-zinc-500">{status.llm.lastRouteMs} мс</span>}
                  {readyBadge(status.ready.llm, status.llm.state, status.llm.error)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs">
                <span className="text-zinc-300">TTS · офлайн-синтез</span>
                <span className="flex items-center gap-2">
                  {status.tts.lastSynthMs != null && <span className="text-zinc-500">{status.tts.lastSynthMs} мс</span>}
                  {readyBadge(status.ready.tts, status.tts.state, status.tts.error)}
                </span>
              </div>
            </div>
            {(status.stt.error || status.llm.error || status.tts.error) && (
              <p className="text-[11px] leading-relaxed text-rose-400">
                {[status.stt.error, status.llm.error, status.tts.error].filter(Boolean).join(' ')}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Загружаю статус AI…
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Обновить
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await getElectronBridge()?.ai?.initialize()
                await refresh()
                toast({ description: 'AI-сервисы инициализированы' })
              } catch {
                toast({ variant: 'destructive', description: 'Не удалось инициализировать AI-сервисы' })
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Перезапустить сервисы
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              localStorage.removeItem('avc-ai-setup-dismissed')
              toast({ description: 'Мастер установки откроется при следующем запуске, если модели не установлены' })
            }}
          >
            Мастер установки
          </Button>
        </div>
      </section>
    </div>
  )
}
