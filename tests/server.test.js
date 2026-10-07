import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

test('settings persist, routes use the selected provider, and recording rejects a missing key', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-test-'));
  const settingsPath = path.join(dir, 'settings.json');
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', NOTED_DB_PATH: path.join(dir, 'test.db'), NOTED_SETTINGS_PATH: settingsPath, GEMINI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '' };
  const processes = [];
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child);
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server startup timed out: ${output}`)); }, 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ child, base: `http://127.0.0.1:${match[1]}` }); }
    });
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('exit', code => { if (!output.match(/http:\/\/localhost:(\d+)/)) { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); } });
    child.stderr.on('data', chunk => { output += chunk; });
  });
  t.after(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('noted-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { child, base } = await start();
  const initial = await (await fetch(`${base}/api/settings`)).json();
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
  const settings = { ...initial, vision: { provider: 'openai', model: 'gpt-6.1-sol' }, deepgram: { model: 'nova-3', language: 'zh' } };
  const saved = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).vision.provider, 'openai');
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://another-site.example' }, body: JSON.stringify(settings) })).status, 403);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, text: { provider: 'bad', model: 'bad' } }) })).status, 400);
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Isolated test', mode: 'lecture' }) })).json();
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  for (const [endpoint, body, key] of [['screen-capture', { image: 'aGVsbG8=' }, 'OPENAI_API_KEY'], ['ask', { question: 'What happened?' }, 'GEMINI_API_KEY']]) {
    const response = await fetch(`${base}/api/sessions/${created.id}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
    assert.ok((await response.json()).error.includes(key));
  }
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  await once(ws, 'open');
  const message = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'start_session', session_id: created.id }));
  const [raw] = await message;
  assert.equal(JSON.parse(raw).type, 'error');
  ws.close();
  await once(ws, 'close');
  const exited = once(child, 'exit'); child.kill(); await exited;
  const restarted = await start();
  const loaded = await (await fetch(`${restarted.base}/api/settings`)).json();
  assert.equal(loaded.vision.provider, 'openai');
  assert.equal(loaded.deepgram.language, 'zh');
  assert.ok(!JSON.stringify(loaded).includes('apiKey'));
});
