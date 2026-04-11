// server.js — Express + WebSocket server with folders, sessions, notes
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initDB, createFolder, updateFolder, deleteFolder, listFolders, getFolder,
  createSession, updateSession, deleteSession, getSession, listSessions, listSessionsByFolder,
  insertChunk, getChunks, getAllChunks, getRecentChunks, searchChunks, searchChunksInFolder,
  getFolderChunks, getFolderSummaries,
  insertSummary, getSummaries, getLatestSummary,
  upsertNote, getNote, updateNoteContent
} from './db.js';
import { createTranscriber } from './transcriber.js';
import {
  generateRollingSummary, detectTopicChange, answerQuestion,
  generateSessionTitle, generateNotes, getNoteMethods
} from './summarizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!DEEPGRAM_KEY || DEEPGRAM_KEY === 'your_deepgram_api_key_here')
  console.warn('\n⚠️  DEEPGRAM_API_KEY not set — transcription won\'t work.\n');
if (!GEMINI_KEY || GEMINI_KEY === 'your_gemini_api_key_here')
  console.warn('\n⚠️  GEMINI_API_KEY not set — AI features won\'t work.\n');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
await initDB();

const activeSessions = new Map();

// ══════════════ Folder API ══════════════
app.get('/api/folders', (req, res) => res.json(listFolders()));
app.post('/api/folders', (req, res) => {
  const id = uuid();
  res.json(createFolder(id, req.body.name || 'New Folder', req.body.color));
});
app.put('/api/folders/:id', (req, res) => {
  updateFolder(req.params.id, req.body.name, req.body.color);
  res.json({ ok: true });
});
app.delete('/api/folders/:id', (req, res) => {
  deleteFolder(req.params.id);
  res.json({ ok: true });
});

// ══════════════ Session API ══════════════
app.get('/api/sessions', (req, res) => {
  if (req.query.folder_id) return res.json(listSessions(req.query.folder_id));
  res.json(listSessions());
});
app.get('/api/sessions/grouped', (req, res) => res.json(listSessionsByFolder()));
app.post('/api/sessions', (req, res) => {
  const id = uuid();
  const title = req.body.title || `Session ${new Date().toLocaleString()}`;
  res.json(createSession(id, title, req.body.folder_id || null));
});
app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});
app.put('/api/sessions/:id', (req, res) => {
  updateSession(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

// ══════════════ Transcript API ══════════════
app.get('/api/sessions/:id/chunks', (req, res) => res.json(getAllChunks(req.params.id)));
app.get('/api/sessions/:id/summaries', (req, res) => res.json(getSummaries(req.params.id)));

// ══════════════ Q&A (single session) ══════════════
app.post('/api/sessions/:id/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const sid = req.params.id;
    const session = getSession(sid);
    // If session is in a folder, search across all sessions in folder
    let context, summaries, crossSession = false;
    if (session?.folder_id) {
      context = searchChunksInFolder(session.folder_id, question);
      if (context.length === 0) context = getFolderChunks(session.folder_id, 100);
      summaries = getFolderSummaries(session.folder_id);
      crossSession = true;
    } else {
      const relevant = searchChunks(sid, question);
      context = relevant.length > 0 ? relevant : getAllChunks(sid).slice(-50);
      summaries = getSummaries(sid);
    }
    const answer = await answerQuestion(GEMINI_KEY, question, context, summaries, crossSession);
    res.json({ answer, sources: context.slice(0, 10).map(c => ({
      text: c.text, start_time: c.start_time, end_time: c.end_time,
      session_title: c.session_title || null
    }))});
  } catch (err) {
    console.error('[Q&A]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════ Folder-level Q&A ══════════════
app.post('/api/folders/:id/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    let context = searchChunksInFolder(req.params.id, question);
    if (context.length === 0) context = getFolderChunks(req.params.id, 100);
    const summaries = getFolderSummaries(req.params.id);
    const answer = await answerQuestion(GEMINI_KEY, question, context, summaries, true);
    res.json({ answer, sources: context.slice(0, 10).map(c => ({
      text: c.text, start_time: c.start_time, session_title: c.session_title
    }))});
  } catch (err) {
    console.error('[Folder Q&A]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════ Summary trigger ══════════════
app.post('/api/sessions/:id/summarize', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const sid = req.params.id;
    const { mode, minutes } = req.body;
    let chunks = (mode === 'time' && minutes) ? getRecentChunks(sid, minutes * 60) : getAllChunks(sid);
    if (chunks.length === 0) return res.json({ summary: 'No transcript data yet.' });
    const startTime = chunks[0].start_time;
    const endTime = chunks[chunks.length - 1].end_time;
    const prev = getLatestSummary(sid);
    const summary = await generateRollingSummary(GEMINI_KEY, chunks, prev?.summary_text);
    insertSummary(sid, summary, startTime, endTime, mode === 'topic' ? 'topic' : 'rolling');
    broadcastToSession(sid, { type: 'summary', data: { summary_text: summary, start_time: startTime, end_time: endTime, summary_type: mode } });
    res.json({ summary, start_time: startTime, end_time: endTime });
  } catch (err) {
    console.error('[Summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════ Notes API ══════════════
app.get('/api/note-methods', (req, res) => res.json(getNoteMethods()));

app.get('/api/sessions/:id/notes', (req, res) => {
  const note = getNote(req.params.id);
  res.json(note || null);
});

app.post('/api/sessions/:id/notes/generate', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const sid = req.params.id;
    const method = req.body.method || 'cornell';
    const chunks = getAllChunks(sid);
    if (chunks.length === 0) return res.status(400).json({ error: 'No transcript data' });
    const summaries = getSummaries(sid);
    const content = await generateNotes(GEMINI_KEY, chunks, summaries, method);
    const noteId = uuid();
    upsertNote(noteId, sid, method, content);
    res.json({ id: noteId, session_id: sid, method, content });
  } catch (err) {
    console.error('[Notes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:id', (req, res) => {
  updateNoteContent(req.params.id, req.body.content);
  res.json({ ok: true });
});

// ══════════════ Auto-title ══════════════
app.post('/api/sessions/:id/auto-title', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const chunks = getAllChunks(req.params.id);
    if (chunks.length === 0) return res.json({ title: 'Empty Session' });
    const title = await generateSessionTitle(GEMINI_KEY, chunks);
    updateSession(req.params.id, { title: title.trim() });
    res.json({ title: title.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════ WebSocket ══════════════
function broadcastToSession(sessionId, message) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const payload = JSON.stringify(message);
  session.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
}

wss.on('connection', (ws) => {
  let sessionId = null;
  let transcriber = null;
  console.log('[WS] Client connected');

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {
      if (transcriber?.isOpen) transcriber.sendAudio(Buffer.from(raw));
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[WS]', msg.type);

      if (msg.type === 'start_session') {
        sessionId = msg.session_id;
        if (!activeSessions.has(sessionId)) {
          activeSessions.set(sessionId, {
            clients: new Set(), transcriber: null,
            lastSummaryTime: 0, currentTopic: '', chunkCount: 0,
            summaryMode: msg.summary_mode || 'time',
            summaryInterval: msg.summary_interval || 5,
          });
        }
        const session = activeSessions.get(sessionId);
        session.clients.add(ws);
        session.summaryMode = msg.summary_mode || session.summaryMode;
        session.summaryInterval = msg.summary_interval || session.summaryInterval;

        if (!session.transcriber && DEEPGRAM_KEY) {
          transcriber = createTranscriber(DEEPGRAM_KEY, { interim_results: true, smart_format: true, utterance_end_ms: 1500 });
          session.transcriber = transcriber;

          transcriber.on('open', () => {
            console.log('[WS] Deepgram ready');
            ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
          });
          transcriber.on('transcript', async (data) => {
            broadcastToSession(sessionId, {
              type: data.is_final ? 'final_transcript' : 'partial_transcript',
              data: { text: data.text, start: data.start, end: data.end, speaker: data.speaker, confidence: data.confidence, is_final: data.is_final, speech_final: data.speech_final },
            });
            if (data.is_final && data.text.trim()) {
              insertChunk(sessionId, data.text, data.start, data.end, data.speaker);
              session.chunkCount++;
              await maybeAutoSummarize(sessionId, session, data.end);
            }
          });
          transcriber.on('error', (err) => {
            console.error('[WS] DG error:', err.message);
            broadcastToSession(sessionId, { type: 'error', data: { message: err.message } });
          });
          transcriber.on('close', ({ code, reason }) => {
            console.log('[WS] DG closed:', code);
            broadcastToSession(sessionId, { type: 'transcriber_closed', data: {} });
          });
        } else if (session.transcriber) {
          transcriber = session.transcriber;
          ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
        } else {
          ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
        }
      }
      else if (msg.type === 'stop_session') { stopSession(sessionId); }
      else if (msg.type === 'update_settings') {
        const s = activeSessions.get(sessionId);
        if (s) { if (msg.summary_mode) s.summaryMode = msg.summary_mode; if (msg.summary_interval) s.summaryInterval = msg.summary_interval; }
      }
    } catch (e) { console.error('[WS] Parse error:', e.message); }
  });

  ws.on('close', () => {
    if (sessionId && activeSessions.has(sessionId)) activeSessions.get(sessionId).clients.delete(ws);
  });
});

async function maybeAutoSummarize(sessionId, session, currentTime) {
  if (!GEMINI_KEY) return;
  if (session.summaryMode === 'time') {
    if (currentTime - session.lastSummaryTime >= session.summaryInterval * 60) {
      try {
        const chunks = getChunks(sessionId, session.lastSummaryTime, currentTime);
        if (chunks.length < 3) return;
        const prev = getLatestSummary(sessionId);
        const summary = await generateRollingSummary(GEMINI_KEY, chunks, prev?.summary_text);
        insertSummary(sessionId, summary, session.lastSummaryTime, currentTime, 'rolling');
        session.lastSummaryTime = currentTime;
        broadcastToSession(sessionId, { type: 'summary', data: { summary_text: summary, start_time: chunks[0].start_time, end_time: currentTime, summary_type: 'rolling' } });
      } catch (err) { console.error('[AutoSum]', err.message); }
    }
  } else if (session.summaryMode === 'topic' && session.chunkCount % 10 === 0) {
    try {
      const recent = getRecentChunks(sessionId, 120);
      if (recent.length < 3) return;
      const result = await detectTopicChange(GEMINI_KEY, recent, session.currentTopic);
      if (result.changed) {
        const chunks = getChunks(sessionId, session.lastSummaryTime, currentTime);
        if (chunks.length > 0) {
          const prev = getLatestSummary(sessionId);
          const summary = await generateRollingSummary(GEMINI_KEY, chunks, prev?.summary_text);
          insertSummary(sessionId, summary, session.lastSummaryTime, currentTime, 'topic', result.topic);
          session.lastSummaryTime = currentTime;
          session.currentTopic = result.topic;
          broadcastToSession(sessionId, { type: 'summary', data: { summary_text: summary, start_time: chunks[0].start_time, end_time: currentTime, summary_type: 'topic', topic_label: result.topic } });
          broadcastToSession(sessionId, { type: 'topic_change', data: { topic: result.topic } });
        }
      }
    } catch (err) { console.error('[TopicDetect]', err.message); }
  }
}

function stopSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  if (session.transcriber) { session.transcriber.close(); session.transcriber = null; }
  broadcastToSession(sessionId, { type: 'session_stopped', data: {} });

  // Auto-generate title and notes after stopping
  if (GEMINI_KEY) {
    const chunks = getAllChunks(sessionId);
    if (chunks.length > 0) {
      const dbSession = getSession(sessionId);
      // Auto-title if still default name
      if (dbSession?.title?.startsWith('Session ')) {
        generateSessionTitle(GEMINI_KEY, chunks).then(title => {
          updateSession(sessionId, { title: title.trim(), status: 'completed' });
          broadcastToSession(sessionId, { type: 'session_updated', data: { title: title.trim(), status: 'completed' } });
        }).catch(e => console.error('[AutoTitle]', e.message));
      } else {
        updateSession(sessionId, { status: 'completed' });
      }
      // Auto-generate notes
      const summaries = getSummaries(sessionId);
      generateNotes(GEMINI_KEY, chunks, summaries, 'cornell').then(content => {
        const noteId = uuid();
        upsertNote(noteId, sessionId, 'cornell', content);
        broadcastToSession(sessionId, { type: 'notes_generated', data: { id: noteId, method: 'cornell', content } });
      }).catch(e => console.error('[AutoNotes]', e.message));
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n🎙️  SCRIBE — Real-Time Transcription`);
  console.log(`   http://localhost:${PORT}\n`);
});
