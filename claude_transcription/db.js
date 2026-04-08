// db.js — SQLite database via sql.js (pure JS, no native deps)
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'transcription.db');

let db;

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    save();
    saveTimer = null;
  }, 2000);
}

export async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transcript_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      speaker TEXT DEFAULT 'speaker_0',
      is_final INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      summary_type TEXT DEFAULT 'rolling',
      topic_label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON transcript_chunks(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_time ON transcript_chunks(session_id, start_time)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id)`);

  save();
  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  scheduleSave();
}

// ── Session CRUD ──

export function createSession(id, title) {
  run('INSERT INTO sessions (id, title) VALUES (?, ?)', [id, title]);
  return { id, title };
}

export function getSession(id) {
  return get('SELECT * FROM sessions WHERE id = ?', [id]);
}

export function listSessions() {
  return all('SELECT * FROM sessions ORDER BY created_at DESC');
}

// ── Transcript Chunks ──

export function insertChunk(sessionId, text, startTime, endTime, speaker = 'speaker_0') {
  run(
    'INSERT INTO transcript_chunks (session_id, text, start_time, end_time, speaker) VALUES (?, ?, ?, ?, ?)',
    [sessionId, text, startTime, endTime, speaker]
  );
  run("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?", [sessionId]);
}

export function getChunks(sessionId, fromTime = 0, toTime = Infinity) {
  if (toTime === Infinity) {
    return all(
      'SELECT * FROM transcript_chunks WHERE session_id = ? AND start_time >= ? ORDER BY start_time ASC',
      [sessionId, fromTime]
    );
  }
  return all(
    'SELECT * FROM transcript_chunks WHERE session_id = ? AND start_time >= ? AND end_time <= ? ORDER BY start_time ASC',
    [sessionId, fromTime, toTime]
  );
}

export function getRecentChunks(sessionId, lastNSeconds) {
  const latest = get('SELECT MAX(end_time) as max_time FROM transcript_chunks WHERE session_id = ?', [sessionId]);
  if (!latest || !latest.max_time) return [];
  const from = Math.max(0, latest.max_time - lastNSeconds);
  return getChunks(sessionId, from);
}

export function getAllChunks(sessionId) {
  return all('SELECT * FROM transcript_chunks WHERE session_id = ? ORDER BY start_time ASC', [sessionId]);
}

export function getFullTranscriptText(sessionId) {
  const chunks = getAllChunks(sessionId);
  return chunks.map(c => c.text).join(' ');
}

// ── Summaries ──

export function insertSummary(sessionId, summaryText, startTime, endTime, type = 'rolling', topicLabel = null) {
  run(
    'INSERT INTO summaries (session_id, summary_text, start_time, end_time, summary_type, topic_label) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, summaryText, startTime, endTime, type, topicLabel]
  );
}

export function getSummaries(sessionId) {
  return all('SELECT * FROM summaries WHERE session_id = ? ORDER BY start_time ASC', [sessionId]);
}

export function getLatestSummary(sessionId) {
  return get('SELECT * FROM summaries WHERE session_id = ? ORDER BY end_time DESC LIMIT 1', [sessionId]);
}

// ── RAG: keyword search ──

export function searchChunks(sessionId, keywords) {
  const words = keywords.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return getAllChunks(sessionId);

  const conditions = words.map(w => `LOWER(text) LIKE '%${w.replace(/'/g, "''")}%'`).join(' OR ');

  return all(
    `SELECT * FROM transcript_chunks WHERE session_id = ? AND (${conditions}) ORDER BY start_time ASC`,
    [sessionId]
  );
}

export function getDB() {
  return db;
}
