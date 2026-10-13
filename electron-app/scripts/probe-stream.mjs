/* Эмпирическая проверка стримингового конвейера: Silero VAD + T-One streaming CTC.
 * Кормим WAV порциями по 100 мс, наблюдаем: isDetected/сегменты VAD, партиалы, тайминги декода.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const modelsDir = path.resolve(process.argv[2] || '../models')
const wavPath = process.argv[3]

function parseWav(buf) {
  let off = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, buf.length - body)
    }
    off = body + size + (size % 2)
  }
  const bytesPer = fmt.bits >> 3
  const frames = Math.floor(dataLen / (bytesPer * fmt.channels))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let ch = 0; ch < fmt.channels; ch++) {
      const p = dataOff + (i * fmt.channels + ch) * bytesPer
      sum += fmt.bits === 16 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p)
    }
    mono[i] = sum / fmt.channels
  }
  return { samples: mono, sampleRate: fmt.sampleRate }
}

function resample(samples, from, to) {
  if (from === to) return samples
  const ratio = to / from
  const out = new Float32Array(Math.floor(samples.length * ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i / ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const frac = pos - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

const t0 = Date.now()
const recognizer = new sherpa.OnlineRecognizer({
  modelConfig: {
    toneCtc: { model: path.join(modelsDir, 't-one', 'model.onnx') },
    tokens: path.join(modelsDir, 't-one', 'tokens.txt'),
    numThreads: 2,
    debug: 0,
    provider: 'cpu',
  },
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 1.4,
  rule3MinUtteranceLength: 30,
})
console.log('model load ms:', Date.now() - t0)

const vt0 = Date.now()
const vad = new sherpa.Vad(
  {
    sileroVad: { model: path.join(modelsDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.2, windowSize: 512, maxSpeechDuration: 30 },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  60,
)
console.log('vad load ms:', Date.now() - vt0)

const wav = parseWav(fs.readFileSync(wavPath))
const samples = resample(wav.samples, wav.sampleRate, 16000)
console.log('wav:', (samples.length / 16000).toFixed(2), 's @', wav.sampleRate, 'Hz')

let stream = recognizer.createStream()
const chunkN = 1600 // 100 ms @ 16k
let lastPartial = ''
const decodeTimes = []
const vadTimes = []
const events = []
for (let pos = 0; pos < samples.length; pos += chunkN) {
  const frame = samples.subarray(pos, Math.min(pos + chunkN, samples.length))
  const ts = ((pos / chunkN) * 0.1).toFixed(1)

  const v0 = performance.now()
  // Feeding VAD in 512-sample windows
  for (let w = 0; w < frame.length; w += 512) {
    const win = frame.subarray(w, Math.min(w + 512, frame.length))
    if (win.length === 512) vad.acceptWaveform(win)
  }
  vadTimes.push(performance.now() - v0)
  const detected = vad.isDetected()
  const hasSeg = !vad.isEmpty()
  if (detected || hasSeg) events.push(`${ts}s vad detected=${detected} seg=${hasSeg}`)

  const d0 = performance.now()
  stream.acceptWaveform({ samples: frame, sampleRate: 16000 })
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  decodeTimes.push(performance.now() - d0)

  const res = recognizer.getResult(stream)
  const text = (res && res.text) || ''
  if (text && text !== lastPartial) {
    lastPartial = text
    events.push(`${ts}s partial: "${text}"`)
  }
  if (recognizer.isEndpoint(stream)) {
    stream.inputFinished()
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    const fin = recognizer.getResult(stream)
    events.push(`${ts}s ENDPOINT final: "${(fin && fin.text) || ''}"`)
    stream = recognizer.createStream()
    lastPartial = ''
  }
  if (hasSeg) {
    const seg = vad.front()
    vad.pop()
    events.push(`${ts}s VAD-SEGMENT: ${(seg.samples.length / 16000).toFixed(2)}s start=${seg.start / 16000}`)
  }
}
// flush
stream.inputFinished()
while (recognizer.isReady(stream)) recognizer.decode(stream)
const fin = recognizer.getResult(stream)
console.log('FINAL:', JSON.stringify((fin && fin.text) || ''))
console.log('decode ms per 100ms chunk: avg', (decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length).toFixed(2), 'max', Math.max(...decodeTimes).toFixed(2))
console.log('vad ms per 100ms chunk: avg', (vadTimes.reduce((a, b) => a + b, 0) / vadTimes.length).toFixed(2), 'max', Math.max(...vadTimes).toFixed(2))
console.log('--- events ---')
for (const e of events) console.log(e)
