const { app } = require('electron');
const { fork } = require('child_process');
const path = require('path');
app.whenReady().then(async () => {
  const worker = fork(path.join(__dirname, '..', 'ai', 'ai-worker.cjs'), [], { env: { ...process.env, AVC_MODELS_DIR: path.join(__dirname, '..', 'models'), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let id = 0; const pending = new Map();
  worker.on('message', (msg) => { if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  worker.on('exit', () => console.log('WORKER EXITED'));
  const req = (type) => new Promise((res) => { const i = 'r' + ++id; pending.set(i, res); worker.send({ id: i, type }); });
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await req('status');
    if (!st.ok) { console.log('REQ ERR:', st.error); break; }
    console.log('poll', i, 'tts:', st.result.tts.state, '|', st.result.tts.error || '', '| stt:', st.result.ready.stt, 'llm:', st.result.ready.llm);
    if (st.result.ready.tts || st.result.tts.error) break;
  }
  app.exit(0);
});
