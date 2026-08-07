// Run inside Electron's main process to reproduce the bridge's fetch.
const { app } = require('electron');
app.whenReady().then(async () => {
  const url = "http://120.77.13.237:3099/v1/chat/completions";
  console.log('[electron-test] node version:', process.versions.node, 'electron:', process.versions.electron);
  console.log('[electron-test] undici?', typeof globalThis.fetch);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake' },
      body: JSON.stringify({ model: 'MiniMax-M3', messages: [{role:'user',content:'hi'}], max_tokens: 1, stream: true, stream_options: { include_usage: true } }),
    });
    console.log('[electron-test] STATUS:', res.status);
    const t = await res.text();
    console.log('[electron-test] BODY:', t.slice(0,150));
  } catch (err) {
    console.log('[electron-test] THREW:', err.name, '|', err.message);
    if (err.cause) console.log('[electron-test] CAUSE:', err.cause.code || err.cause.name, '-', err.cause.message);
    if (err.cause && err.cause.cause) console.log('[electron-test] CAUSE.CAUSE:', err.cause.cause.code || err.cause.cause.name, '-', err.cause.cause.message);
  }
  app.quit();
});
