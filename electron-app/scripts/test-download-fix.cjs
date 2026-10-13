// Тест исправленного downloadFile: HF resolve/main всегда 302 → CDN
const path = require('path')
const fs = require('fs')
const mm = require('/home/z/exe-build/app/electron-app/speech/model-manager.cjs')

;(async () => {
  const dir = '/tmp/avc-dl-test'
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const spec = mm.MANIFEST.asr.files.find((f) => f.path === 't-one/tokens.txt')
  const t0 = Date.now()
  try {
    await mm.ensureFile(dir, 't-one/tokens.txt', {
      onProgress: (p) => console.log('progress:', p.phase, p.received, '/', p.total),
    })
    console.log('OK tokens.txt за', Date.now() - t0, 'мс')
    const st = fs.statSync(path.join(dir, 't-one/tokens.txt'))
    console.log('размер:', st.size, 'ожидался:', spec.bytes, st.size === spec.bytes ? '(совпал)' : '(НЕ СОВПАЛ!)')
  } catch (e) {
    console.error('FAIL:', e.message)
    process.exit(1)
  }
})()
