import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const settingsPath = process.env.NOTED_SETTINGS_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'settings.local.json');
export const PROVIDERS = {
  gemini: { label: 'Gemini', keyEnv: 'GEMINI_API_KEY', defaultModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'] },
  openai: { label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', defaultModel: process.env.OPENAI_MODEL || 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'] },
  claude: { label: 'Claude', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'] },
};

export function hasKey(name) {
  const value = process.env[name]?.trim();
  return Boolean(value && !/^(your_|replace_|<)/i.test(value));
}

function defaultChannel(provider = 'gemini') {
  if (!Object.hasOwn(PROVIDERS, provider)) provider = 'gemini';
  return { provider, model: PROVIDERS[provider].defaultModel };
}

const defaults = {
  text: defaultChannel(process.env.AI_TEXT_PROVIDER),
  vision: defaultChannel(process.env.AI_VISION_PROVIDER),
  deepgram: { model: process.env.DEEPGRAM_MODEL || 'nova-3', language: process.env.DEEPGRAM_LANGUAGE || 'en' },
  googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
};

export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Settings are required.');
  const out = {};
  for (const channel of ['text', 'vision']) {
    const value = input[channel];
    if (!value || !Object.hasOwn(PROVIDERS, value.provider)) throw new Error(`Choose a valid ${channel} provider.`);
    if (typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.model)) throw new Error(`Invalid ${channel} model ID.`);
    out[channel] = { provider: value.provider, model: value.model };
  }
  if (!['nova-3', 'nova-2'].includes(input.deepgram?.model)) throw new Error('Choose Nova-3 or Nova-2.');
  if (typeof input.deepgram.language !== 'string' || !/^(?:multi|[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?)$/.test(input.deepgram.language)) throw new Error('Invalid transcription language code.');
  out.deepgram = { model: input.deepgram.model, language: input.deepgram.language };
  const clientId = String(input.googleDriveClientId || '').trim();
  if (clientId && !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Use a Google OAuth Web client ID ending in .apps.googleusercontent.com.');
  out.googleDriveClientId = clientId;
  return out;
}

let settings = structuredClone(defaults);
if (fs.existsSync(settingsPath)) {
  try { settings = validateSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
  catch (err) { console.warn(`[Settings] Using .env defaults: ${err.message}`); }
}

export function getSettings() { return structuredClone(settings); }
export function saveSettings(input) {
  const next = validateSettings(input);
  const tempPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tempPath, settingsPath);
  settings = next;
  return publicSettings();
}

export function getAIConfig(channel = 'text') {
  const selected = settings[channel];
  return { ...selected, apiKey: process.env[PROVIDERS[selected.provider].keyEnv]?.trim() || '' };
}
export function hasAIKey(channel = 'text') { return hasKey(PROVIDERS[settings[channel].provider].keyEnv); }
export function missingKeyMessage(channel = 'text') { return `Set ${PROVIDERS[settings[channel].provider].keyEnv} in .env, then restart Noted.`; }

export function publicSettings() {
  return {
    ...getSettings(),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { ...p, configured: hasKey(p.keyEnv) }])),
    deepgramConfigured: hasKey('DEEPGRAM_API_KEY'),
  };
}
