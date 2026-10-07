import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { publicSettings } from '../settings.js';

console.log(`Node ${process.version} (${process.execPath})`);
const npm = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm.cmd --version'], { encoding: 'utf8' })
  : spawnSync('npm', ['--version'], { encoding: 'utf8' });
console.log(`npm: ${npm.status === 0 ? npm.stdout.trim() : 'unavailable; try setup.cmd or refresh the terminal PATH'}`);
const require = createRequire(import.meta.url);
for (const name of ['express', 'ws', 'dotenv', 'sql.js', 'docx', 'pdfkit']) {
  try { console.log(`${name}: installed (${require.resolve(name)})`); }
  catch { console.log(`${name}: MISSING — run npm.cmd ci`); process.exitCode = 1; }
}
const settings = publicSettings();
console.log(`Deepgram: ${settings.deepgramConfigured ? 'key configured' : 'key missing'} / ${settings.deepgram.model} / ${settings.deepgram.language}`);
for (const [name, p] of Object.entries(settings.providers)) console.log(`${p.keyEnv}: ${p.configured ? 'configured' : 'missing'} (${name})`);
console.log(`Text: ${settings.text.provider} / ${settings.text.model}`);
console.log(`Vision: ${settings.vision.provider} / ${settings.vision.model}`);
console.log(`Google OAuth: ${settings.googleDriveClientId ? 'client ID configured; browser consent/origin still required' : 'client ID missing'}`);
if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Install Node.js 22 or newer.'); process.exitCode = 1; }
