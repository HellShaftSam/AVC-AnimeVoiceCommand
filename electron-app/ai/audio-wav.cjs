/**
 * audio-wav — чтение/запись WAV (PCM16/float32) для selftest/бенчмарков STT.
 * Выделено из stt-service.cjs при замене STT-движка на faster-whisper (v1.0.22).
 */
'use strict'

const fs = require('fs')

/** WAV (PCM16/float32, mono/stereo) → { samples: Float32Array, sampleRate } */
function readWavAsFloat32(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Не WAV файл')
  let pos = 12
  let sampleRate = 16000
  let bits = 16
  let channels = 1
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size)
    }
    pos += 8 + size + (size % 2)
  }
  if (!data) throw new Error('Нет data-чанка')
  let samples
  if (bits === 16) {
    const n = Math.floor(data.length / 2)
    samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  } else if (bits === 32 && data.length / 4 > 0) {
    const n = Math.floor(data.length / 4)
    samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = data.readFloatLE(i * 4)
  } else {
    throw new Error(`Формат WAV не поддержан в selftest: ${bits} бит`)
  }
  if (channels > 1) {
    const mono = new Float32Array(Math.floor(samples.length / channels))
    for (let i = 0; i < mono.length; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += samples[i * channels + c]
      mono[i] = acc / channels
    }
    samples = mono
  }
  return { samples, sampleRate }
}

/** Float32 → PCM16 mono WAV-файл */
function writeWavFromFloat32(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

module.exports = { readWavAsFloat32, writeWavFromFloat32 }
