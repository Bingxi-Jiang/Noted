// db.js — SQLite database with folders, sessions, notes, speaker names, cross-session RAG
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'transcription.db');

let db;

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { save(); saveTimer = null; }, 2000);
}

export async function initDB() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6c5ce7',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    title TEXT,
    mode TEXT DEFAULT 'lecture',
    status TEXT DEFAULT 'active',
    duration REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (folder_id) REFERENCES folders(id)
  )`);

  // Migration: add mode column if missing
  try { db.run(`ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'lecture'`); } catch (e) { /* exists */ }

  db.run(`CREATE TABLE IF NOT EXISTS transcript_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    speaker TEXT DEFAULT 'speaker_0',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    summary_type TEXT DEFAULT 'rolling',
    topic_label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    method TEXT DEFAULT 'cornell',
    content TEXT NOT NULL,
    action_items TEXT DEFAULT '',
    action_items_log TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`);

  try { db.run(`ALTER TABLE notes ADD COLUMN action_items TEXT DEFAULT ''`); } catch (e) { /* exists */ }
  try { db.run(`ALTER TABLE notes ADD COLUMN action_items_log TEXT DEFAULT ''`); } catch (e) { /* exists */ }

  // Speaker name mapping for meeting mode
  db.run(`CREATE TABLE IF NOT EXISTS speaker_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    speaker_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    UNIQUE(session_id, speaker_key)
  )`);

  // Screen captures for vision-augmented transcription
  db.run(`CREATE TABLE IF NOT EXISTS screen_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    capture_time REAL NOT NULL,
    description TEXT NOT NULL,
    extracted_text TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON transcript_chunks(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_time ON transcript_chunks(session_id, start_time)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_speaker_names_session ON speaker_names(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_screen_captures_session ON screen_captures(session_id, capture_time)`);

  save();
  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

// ── Helpers ──
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
  scheduleSave();
}

// ── Folders ──
export function createFolder(id, name, color = '#6c5ce7') {
  run('INSERT INTO folders (id, name, color) VALUES (?, ?, ?)', [id, name, color]);
  return { id, name, color };
}
export function updateFolder(id, name, color) {
  if (name !== undefined) run('UPDATE folders SET name = ?, updated_at = datetime("now") WHERE id = ?', [name, id]);
  if (color !== undefined) run('UPDATE folders SET color = ?, updated_at = datetime("now") WHERE id = ?', [color, id]);
}
export function deleteFolder(id) {
  run('UPDATE sessions SET folder_id = NULL WHERE folder_id = ?', [id]);
  run('DELETE FROM folders WHERE id = ?', [id]);
}
export function listFolders() {
  const folders = all('SELECT * FROM folders ORDER BY created_at ASC');
  return folders.map(f => {
    const count = get('SELECT COUNT(*) as c FROM sessions WHERE folder_id = ?', [f.id]);
    return { ...f, session_count: count?.c || 0 };
  });
}
export function getFolder(id) {
  return get('SELECT * FROM folders WHERE id = ?', [id]);
}

// ── Sessions ──
export function createSession(id, title, folderId = null, mode = 'lecture') {
  run('INSERT INTO sessions (id, title, folder_id, mode) VALUES (?, ?, ?, ?)', [id, title, folderId, mode]);
  return { id, title, folder_id: folderId, mode, status: 'active' };
}
export function updateSession(id, updates) {
  if (updates.title !== undefined) run('UPDATE sessions SET title = ?, updated_at = datetime("now") WHERE id = ?', [updates.title, id]);
  if (updates.folder_id !== undefined) run('UPDATE sessions SET folder_id = ?, updated_at = datetime("now") WHERE id = ?', [updates.folder_id, id]);
  if (updates.status !== undefined) run('UPDATE sessions SET status = ?, updated_at = datetime("now") WHERE id = ?', [updates.status, id]);
  if (updates.duration !== undefined) run('UPDATE sessions SET duration = ?, updated_at = datetime("now") WHERE id = ?', [updates.duration, id]);
  if (updates.mode !== undefined) run('UPDATE sessions SET mode = ?, updated_at = datetime("now") WHERE id = ?', [updates.mode, id]);
}
export function deleteSession(id) {
  run('DELETE FROM transcript_chunks WHERE session_id = ?', [id]);
  run('DELETE FROM summaries WHERE session_id = ?', [id]);
  run('DELETE FROM notes WHERE session_id = ?', [id]);
  run('DELETE FROM speaker_names WHERE session_id = ?', [id]);
  run('DELETE FROM screen_captures WHERE session_id = ?', [id]);
  run('DELETE FROM sessions WHERE id = ?', [id]);
}
export function getSession(id) {
  return get('SELECT * FROM sessions WHERE id = ?', [id]);
}
export function listSessions(folderId = null) {
  if (folderId) return all('SELECT * FROM sessions WHERE folder_id = ? ORDER BY created_at DESC', [folderId]);
  return all('SELECT * FROM sessions ORDER BY created_at DESC');
}
export function listSessionsByFolder() {
  const folders = listFolders();
  const unfoldered = all("SELECT * FROM sessions WHERE folder_id IS NULL OR folder_id = '' ORDER BY created_at DESC");
  return { folders, unfoldered };
}

// ── Transcript Chunks ──
export function insertChunk(sessionId, text, startTime, endTime, speaker = 'speaker_0') {
  run('INSERT INTO transcript_chunks (session_id, text, start_time, end_time, speaker) VALUES (?, ?, ?, ?, ?)',
    [sessionId, text, startTime, endTime, speaker]);
  run("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?", [sessionId]);
}
export function getChunks(sessionId, fromTime = 0, toTime = Infinity) {
  if (toTime === Infinity)
    return all('SELECT * FROM transcript_chunks WHERE session_id = ? AND start_time >= ? ORDER BY start_time ASC', [sessionId, fromTime]);
  return all('SELECT * FROM transcript_chunks WHERE session_id = ? AND start_time >= ? AND end_time <= ? ORDER BY start_time ASC', [sessionId, fromTime, toTime]);
}
export function getRecentChunks(sessionId, lastNSeconds) {
  const latest = get('SELECT MAX(end_time) as max_time FROM transcript_chunks WHERE session_id = ?', [sessionId]);
  if (!latest?.max_time) return [];
  return getChunks(sessionId, Math.max(0, latest.max_time - lastNSeconds));
}
export function getAllChunks(sessionId) {
  return all('SELECT * FROM transcript_chunks WHERE session_id = ? ORDER BY start_time ASC', [sessionId]);
}
export function getFullTranscriptText(sessionId) {
  return getAllChunks(sessionId).map(c => c.text).join(' ');
}

// ── Speaker Names ──
export function getSpeakerNames(sessionId) {
  return all('SELECT * FROM speaker_names WHERE session_id = ? ORDER BY speaker_key ASC', [sessionId]);
}
export function upsertSpeakerName(sessionId, speakerKey, displayName) {
  const existing = get('SELECT id FROM speaker_names WHERE session_id = ? AND speaker_key = ?', [sessionId, speakerKey]);
  if (existing) {
    run('UPDATE speaker_names SET display_name = ?, updated_at = datetime("now") WHERE session_id = ? AND speaker_key = ?',
      [displayName, sessionId, speakerKey]);
  } else {
    run('INSERT INTO speaker_names (session_id, speaker_key, display_name) VALUES (?, ?, ?)',
      [sessionId, speakerKey, displayName]);
  }
}
export function getSpeakerNameMap(sessionId) {
  const names = getSpeakerNames(sessionId);
  const map = {};
  names.forEach(n => { map[n.speaker_key] = n.display_name; });
  return map;
}

// ── Summaries ──
export function insertSummary(sessionId, summaryText, startTime, endTime, type = 'rolling', topicLabel = null) {
  run('INSERT INTO summaries (session_id, summary_text, start_time, end_time, summary_type, topic_label) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, summaryText, startTime, endTime, type, topicLabel]);
}
export function getSummaries(sessionId) {
  return all('SELECT * FROM summaries WHERE session_id = ? ORDER BY start_time ASC', [sessionId]);
}
export function getLatestSummary(sessionId) {
  return get('SELECT * FROM summaries WHERE session_id = ? ORDER BY end_time DESC LIMIT 1', [sessionId]);
}

// ── Notes ──
export function upsertNote(id, sessionId, method, content, actionItems = '', actionItemsLog = '') {
  const existing = get('SELECT id FROM notes WHERE id = ?', [id]);
  if (existing) {
    run('UPDATE notes SET content = ?, method = ?, action_items = ?, action_items_log = ?, updated_at = datetime("now") WHERE id = ?', [content, method, actionItems, actionItemsLog, id]);
  } else {
    run('INSERT INTO notes (id, session_id, method, content, action_items, action_items_log) VALUES (?, ?, ?, ?, ?, ?)', [id, sessionId, method, content, actionItems, actionItemsLog]);
  }
}
export function getNote(sessionId) {
  return get('SELECT * FROM notes WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1', [sessionId]);
}
export function updateNoteContent(id, content) {
  run('UPDATE notes SET content = ?, updated_at = datetime("now") WHERE id = ?', [content, id]);
}

// ── Cross-session RAG ──
export function searchChunksInFolder(folderId, keywords) {
  const words = keywords.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return [];
  const conditions = words.map(w => `LOWER(tc.text) LIKE '%${w.replace(/'/g, "''")}%'`).join(' OR ');
  const sql = folderId
    ? `SELECT tc.*, s.title as session_title FROM transcript_chunks tc
       JOIN sessions s ON tc.session_id = s.id
       WHERE s.folder_id = ? AND (${conditions})
       ORDER BY tc.start_time ASC LIMIT 100`
    : `SELECT tc.*, s.title as session_title FROM transcript_chunks tc
       JOIN sessions s ON tc.session_id = s.id
       WHERE (${conditions})
       ORDER BY tc.start_time ASC LIMIT 100`;
  return folderId ? all(sql, [folderId]) : all(sql);
}

export function searchChunks(sessionId, keywords) {
  const words = keywords.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return getAllChunks(sessionId);
  const conditions = words.map(w => `LOWER(text) LIKE '%${w.replace(/'/g, "''")}%'`).join(' OR ');
  return all(`SELECT * FROM transcript_chunks WHERE session_id = ? AND (${conditions}) ORDER BY start_time ASC`, [sessionId]);
}

export function getFolderChunks(folderId, limit = 200) {
  return all(`SELECT tc.*, s.title as session_title FROM transcript_chunks tc
    JOIN sessions s ON tc.session_id = s.id
    WHERE s.folder_id = ?
    ORDER BY s.created_at ASC, tc.start_time ASC
    LIMIT ?`, [folderId, limit]);
}

export function getFolderSummaries(folderId) {
  return all(`SELECT sm.*, s.title as session_title FROM summaries sm
    JOIN sessions s ON sm.session_id = s.id
    WHERE s.folder_id = ?
    ORDER BY s.created_at ASC, sm.start_time ASC`, [folderId]);
}

// ── Screen Captures ──
export function insertScreenCapture(sessionId, captureTime, description, extractedText = '', thumbnail = '') {
  run('INSERT INTO screen_captures (session_id, capture_time, description, extracted_text, thumbnail) VALUES (?, ?, ?, ?, ?)',
    [sessionId, captureTime, description, extractedText, thumbnail]);
}
export function getScreenCaptures(sessionId) {
  return all('SELECT * FROM screen_captures WHERE session_id = ? ORDER BY capture_time ASC', [sessionId]);
}
export function getScreenCapturesInRange(sessionId, fromTime, toTime) {
  return all('SELECT * FROM screen_captures WHERE session_id = ? AND capture_time >= ? AND capture_time <= ? ORDER BY capture_time ASC',
    [sessionId, fromTime, toTime]);
}

export function getDB() { return db; }
