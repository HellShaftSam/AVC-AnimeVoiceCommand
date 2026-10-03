#!/usr/bin/env node
/**
 * assemble-ai-pack — подготовка изолированного AI-слоя для упаковки в EXE
 * (спецификация §113–§114).
 *
 * Собирает electron-app/ai-pack/:
 *   ai/                    — voice-pipeline + сервисы + ai-worker.cjs + models-manifest.json
 *     node_modules/        — ЧИСТЫЕ КОПИИ нативных пакетов (asar неприменим: воркер —
 *                            отдельный процесс на чистом Node, а napi-бинарники должны
 *                            лежать реальными файлами)
 *   runtime-node/          — чистый Node-рантайм (node.exe) для AI-воркера:
 *                            Electron запрещает napi external arraybuffers в своих
 *                            процессах, поэтому воркер работает на отдельном Node
 *                            (§112 соблюдено: рантайм в комплекте, ставить ничего не нужно)
 *
 * Запуск: node scripts/assemble-ai-pack.mjs   (из корня репозитория; до electron-builder)
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'electron-app')
const PACK = path.join(APP, 'ai-pack')

const PLATFORM_PKGS = {
  win32: ['sherpa-onnx-win-x64'],
  linux: ['sherpa-onnx-linux-x64'],
  darwin: ['sherpa-onnx-darwin-x64', 'sherpa-onnx-darwin-arm64'],
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function main() {
  fs.rmSync(PACK, { recursive: true, force: true })
  fs.mkdirSync(PACK, { recursive: true })

  // 1) ai-модули (воркер и сервисы — реальные файлы, не asar)
  copyDir(path.join(APP, 'ai'), path.join(PACK, 'ai'))

  // 2) нативные npm-пакеты, нужные воркеру
  const nmSrc = path.join(APP, 'node_modules')
  const nmDest = path.join(PACK, 'ai', 'node_modules')
  const wanted = ['sherpa-onnx-node', 'node-llama-cpp']
  for (const p of PLATFORM_PKGS[process.platform] || []) wanted.push(p)
  // платформенные пакеты node-llama-cpp (бинатники llama.cpp в комплекте)
  try {
    const scope = path.join(nmSrc, '@node-llama-cpp')
    if (fs.existsSync(scope)) {
      for (const d of fs.readdirSync(scope)) {
        if (d.startsWith(`${process.platform}-`) && !d.endsWith('-cuda') && !d.endsWith('-vulkan') && !d.endsWith('-ext')) {
          wanted.push(`@node-llama-cpp/${d}`)
        }
      }
    }
  } catch { /* нет scope — ок */ }

  for (const w of wanted) {
    const src = path.join(nmSrc, w)
    if (!fs.existsSync(src)) {
      console.warn(`[ai-pack] предупреждение: пакет ${w} не найден (npm install в electron-app?)`)
      continue
    }
    copyDir(src, path.join(nmDest, w))
  }

  // 3) чистый Node-рантайм (если подготовлен CI-шагом)
  const runtimeSrc = path.join(APP, 'runtime-node')
  if (fs.existsSync(runtimeSrc)) {
    copyDir(runtimeSrc, path.join(PACK, 'runtime-node'))
    console.log('[ai-pack] runtime-node включён в комплект')
  } else {
    console.warn('[ai-pack] runtime-node НЕ найден — в packaged-сборке AI-воркер потребует node в PATH')
  }

  const size = (dir) => {
    let total = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else total += fs.statSync(p).size
      }
    }
    walk(dir)
    return (total / 1024 / 1024).toFixed(1)
  }
  console.log(`[ai-pack] готово: ${PACK} (${size(PACK)} МБ)`)
}

main()
