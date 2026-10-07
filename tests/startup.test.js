import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('an occupied port reports an actionable error and exits cleanly', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-startup-test-'));
  const blocker = createServer();
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close');
      child.kill();
      await exited;
    }
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('noted-startup-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const port = blocker.address().port;
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      NOTED_DB_PATH: path.join(dir, 'test.db'),
      NOTED_SETTINGS_PATH: path.join(dir, 'settings.json'),
      GEMINI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 20000);
  t.after(() => clearTimeout(timeout));
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, output);
  assert.equal(code, 1, output);
  assert.ok(output.includes(`Port ${port} is already in use`), output);
  assert.match(output, /choose another PORT in \.env/);
  assert.doesNotMatch(output, /Assertion failed|UV_HANDLE_CLOSING|Unhandled 'error' event/);
  assert.ok(blocker.listening);
});
