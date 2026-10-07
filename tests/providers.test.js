import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAI } from '../ai-client.js';
import { validateSettings, publicSettings } from '../settings.js';
import { buildDriveUpload, uploadToDrive } from '../public/drive-upload.js';
import { generateDocx, generatePdf } from '../exporter.js';

const valid = { text: { provider: 'gemini', model: 'gemini-3.8-flash' }, vision: { provider: 'openai', model: 'gpt-6.1-sol' }, deepgram: { model: 'nova-3', language: 'en' }, googleDriveClientId: '' };

test('settings support independent channels and reject invalid providers/models', () => {
  assert.equal(validateSettings(valid).vision.provider, 'openai');
  for (const provider of ['invalid', '__proto__']) assert.throws(() => validateSettings({ ...valid, text: { provider, model: 'x' } }));
  assert.throws(() => validateSettings({ ...valid, vision: { provider: 'openai', model: '../../secrets' } }));
  assert.throws(() => validateSettings({ ...valid, deepgram: { model: 'flux', language: 'en' } }));
  assert.throws(() => validateSettings({ ...valid, googleDriveClientId: 'not-a-client' }));
  assert.equal(validateSettings({ ...valid, deepgram: { model: 'nova-3', language: 'zh-TW' } }).deepgram.language, 'zh-TW');
  assert.equal(validateSettings({ ...valid, deepgram: { model: 'nova-3', language: 'multi' } }).deepgram.language, 'multi');
});

test('public settings expose key status without exposing credentials', () => {
  process.env.OPENAI_API_KEY = 'test-secret-only';
  try {
    assert.equal(publicSettings().providers.openai.configured, true);
    assert.ok(!JSON.stringify(publicSettings()).includes('test-secret-only'));
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('all providers send image input and extract text from their response schema', async t => {
  for (const provider of ['gemini', 'openai', 'claude']) {
    await t.test(provider, async t => {
      let request;
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        request = { url, headers: options.headers, body: JSON.parse(options.body) };
        return Response.json(provider === 'gemini' ? { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '{"answer":"ok"}' }] } }] }
          : provider === 'openai' ? { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }] }
          : { content: [{ type: 'thinking' }, { type: 'text', text: '{"answer":"ok"}' }], stop_reason: 'end_turn' });
      });
      const model = { gemini: 'gemini-3.8-flash', openai: 'gpt-6.1-sol', claude: 'claude-sonnet-5-5' }[provider];
      const output = await generateAI({ provider, model, apiKey: 'fake-test-key' }, 'Return JSON.', 'Read this slide.', { imageBase64: 'aW1hZ2U=', mimeType: 'image/png', responseMimeType: 'application/json', thinkingLevel: 'minimal', maxOutputTokens: 300 });
      assert.deepEqual(JSON.parse(output), { answer: 'ok' });
      assert.ok(!JSON.stringify(request.body).includes('fake-test-key'));
      if (provider === 'gemini') {
        assert.equal(request.body.contents[0].parts[0].inlineData.mimeType, 'image/png');
        assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'low');
        assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
      } else if (provider === 'openai') {
        assert.equal(request.body.input[0].content[0].image_url, 'data:image/png;base64,aW1hZ2U=');
        assert.equal(request.body.reasoning.effort, 'low');
        assert.ok(request.body.max_output_tokens > 300);
        assert.equal(request.body.store, false);
      } else {
        assert.equal(request.body.messages[0].content[0].source.media_type, 'image/png');
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
      }
    });
  }
});

test('missing keys, provider errors, and truncated output are surfaced', async t => {
  await assert.rejects(generateAI({ provider: 'gemini', model: 'x', apiKey: 'your_key_here' }, 'x', 'y'), /Missing/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Bad key fake-test-key' } }, { status: 401 }));
  await assert.rejects(generateAI({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'fake-test-key' }, 'x', 'y'), e => e.message.includes('401') && !e.message.includes('fake-test-key'));
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete', output: [] }));
  await assert.rejects(generateAI({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'fake-test-key' }, 'x', 'y'), /incomplete/);
});

test('Drive multipart includes valid metadata, original binary data and closing boundary', async () => {
  const binary = new Uint8Array([0, 255, 42, 13, 10]);
  const { body, contentType } = buildDriveUpload(new Blob([binary], { type: 'application/pdf' }), 'Lecture.pdf', 'boundary_test');
  assert.equal(contentType, 'multipart/related; boundary=boundary_test');
  const bytes = Buffer.from(await body.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from(binary)));
  assert.ok(bytes.includes(Buffer.from('"name":"Lecture.pdf"')));
  assert.ok(bytes.toString().endsWith('--boundary_test--\r\n'));
});

test('Drive upload returns a file link and reports expired authorization', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(url.includes('uploadType=multipart'));
    assert.ok(options.headers['Content-Type'].startsWith('multipart/related'));
    return Response.json({ id: 'test', webViewLink: 'https://drive.google.com/file/d/test/view' });
  });
  assert.equal((await uploadToDrive(new Blob(['test']), 'Test.txt', 'fake-token')).id, 'test');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }));
  await assert.rejects(uploadToDrive(new Blob(['test']), 'Test.txt', 'fake-token'), e => e.status === 401 && e.message.includes('expired'));
});

test('existing DOCX and PDF exports still produce valid file signatures', async () => {
  const docx = await generateDocx('Test notes', '## Summary\n- One point', { date: '2026-10-06', mode: 'Lecture' });
  const pdf = await generatePdf('Test notes', '## Summary\n- One point', { date: '2026-10-06', mode: 'Lecture' });
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});
