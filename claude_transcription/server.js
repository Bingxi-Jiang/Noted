// server.js — Main server: Express HTTP + WebSocket for real-time transcription
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDB, createSession, getSession, listSessions, insertChunk, getChunks, getAllChunks, getRecentChunks, searchChunks, insertSummary, getSummaries, getLatestSummary } from './db.js';
import { createTranscriber } from './transcriber.js';
import { generateRollingSummary, detectTopicChange, answerQuestion } from './summarizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!DEEPGRAM_KEY || DEEPGRAM_KEY === 'your_deepgram_api_key_here') {
  console.warn('\n⚠️  DEEPGRAM_API_KEY not set in .env — transcription will not work.\n');
}
if (!ANTHROPIC_KEY || ANTHROPIC_KEY === 'your_anthropic_api_key_here') {
  console.warn('\n⚠️  ANTHROPIC_API_KEY not set in .env — summaries and Q&A will not work.\n');
}

// ── Initialize ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Init DB before starting (async)
await initDB();

// ── Active transcription sessions ──
const activeSessions = new Map(); // sessionId -> { transcriber, clients, finalBuffer, ... }

// ── REST API ──

app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

app.post('/api/sessions', (req, res) => {
  const id = uuid();
  const title = req.body.title || `Session ${new Date().toLocaleString()}`;
  const session = createSession(id, title);
  res.json(session);
});

app.get('/api/sessions/:id/chunks', (req, res) => {
  const chunks = getAllChunks(req.params.id);
  res.json(chunks);
});

app.get('/api/sessions/:id/summaries', (req, res) => {
  const summaries = getSummaries(req.params.id);
  res.json(summaries);
});

// Q&A endpoint
app.post('/api/sessions/:id/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const sessionId = req.params.id;
    // RAG: search for relevant chunks + get summaries
    const relevant = searchChunks(sessionId, question);
    const allChunks = getAllChunks(sessionId);
    const summaries = getSummaries(sessionId);

    // Use relevant chunks if we found some, otherwise fall back to recent chunks
    const context = relevant.length > 0 ? relevant : allChunks.slice(-50);

    const answer = await answerQuestion(ANTHROPIC_KEY, question, context, summaries);
    res.json({
      answer,
      sources: context.slice(0, 10).map(c => ({
        text: c.text,
        start_time: c.start_time,
        end_time: c.end_time,
      })),
    });
  } catch (err) {
    console.error('[Q&A Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual summary trigger
app.post('/api/sessions/:id/summarize', async (req, res) => {
  const { mode, minutes } = req.body; // mode: 'time' | 'topic' | 'all'
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const sessionId = req.params.id;
    let chunks;
    let startTime = 0;
    let endTime = 0;

    if (mode === 'time' && minutes) {
      chunks = getRecentChunks(sessionId, minutes * 60);
    } else {
      chunks = getAllChunks(sessionId);
    }

    if (chunks.length === 0) return res.json({ summary: 'No transcript data yet.' });

    startTime = chunks[0].start_time;
    endTime = chunks[chunks.length - 1].end_time;

    const prev = getLatestSummary(sessionId);
    const summary = await generateRollingSummary(ANTHROPIC_KEY, chunks, prev?.summary_text);

    insertSummary(sessionId, summary, startTime, endTime, mode === 'topic' ? 'topic' : 'rolling');

    // Broadcast to connected clients
    broadcastToSession(sessionId, {
      type: 'summary',
      data: { summary_text: summary, start_time: startTime, end_time: endTime, summary_type: mode },
    });

    res.json({ summary, start_time: startTime, end_time: endTime });
  } catch (err) {
    console.error('[Summary Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── WebSocket handling ──

function broadcastToSession(sessionId, message) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const payload = JSON.stringify(message);
  session.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

wss.on('connection', (ws) => {
  let sessionId = null;
  let transcriber = null;

  console.log('[WS] New client connected');

  ws.on('message', async (raw, isBinary) => {
    // Binary = audio data
    if (isBinary) {
      if (transcriber && transcriber.isOpen) {
        transcriber.sendAudio(Buffer.from(raw));
      }
      return;
    }

    // Text = control messages
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[WS] Control message:', msg.type);

      if (msg.type === 'start_session') {
        sessionId = msg.session_id;
        console.log('[WS] Starting session:', sessionId);

        // Register client
        if (!activeSessions.has(sessionId)) {
          activeSessions.set(sessionId, {
            clients: new Set(),
            transcriber: null,
            finalBuffer: [],
            lastSummaryTime: 0,
            currentTopic: '',
            summaryMode: msg.summary_mode || 'time',
            summaryInterval: msg.summary_interval || 5,
            chunkCount: 0,
          });
        }

        const session = activeSessions.get(sessionId);
        session.clients.add(ws);
        session.summaryMode = msg.summary_mode || session.summaryMode;
        session.summaryInterval = msg.summary_interval || session.summaryInterval;

        // Start Deepgram transcriber if not running
        if (!session.transcriber && DEEPGRAM_KEY) {
          console.log('[WS] Creating Deepgram transcriber...');
          transcriber = createTranscriber(DEEPGRAM_KEY, {
            interim_results: true,
            smart_format: true,
            utterance_end_ms: 1500,
          });

          session.transcriber = transcriber;

          // WAIT for Deepgram to connect before telling client we're ready
          transcriber.on('open', () => {
            console.log('[WS] Deepgram connected — sending session_ready');
            ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
          });

          transcriber.on('transcript', async (data) => {
            console.log(`[WS] Transcript [${data.is_final ? 'FINAL' : 'partial'}]: "${data.text.substring(0, 60)}"`);
            broadcastToSession(sessionId, {
              type: data.is_final ? 'final_transcript' : 'partial_transcript',
              data: {
                text: data.text,
                start: data.start,
                end: data.end,
                speaker: data.speaker,
                confidence: data.confidence,
                is_final: data.is_final,
                speech_final: data.speech_final,
              },
            });

            if (data.is_final && data.text.trim()) {
              insertChunk(sessionId, data.text, data.start, data.end, data.speaker);
              session.chunkCount++;
              await maybeAutoSummarize(sessionId, session, data.end);
            }
          });

          transcriber.on('error', (err) => {
            console.error('[WS] Deepgram error:', err.message);
            broadcastToSession(sessionId, {
              type: 'error',
              data: { message: `Transcription error: ${err.message}` },
            });
          });

          transcriber.on('close', ({ code, reason }) => {
            console.log('[WS] Deepgram closed:', code, reason);
            broadcastToSession(sessionId, {
              type: 'transcriber_closed',
              data: { code, reason },
            });
          });
        } else if (session.transcriber) {
          transcriber = session.transcriber;
          console.log('[WS] Reusing existing transcriber, isOpen:', transcriber.isOpen);
          // Transcriber already exists and is (hopefully) connected
          ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
        } else {
          console.warn('[WS] No DEEPGRAM_KEY — sending session_ready without transcriber');
          ws.send(JSON.stringify({ type: 'session_ready', session_id: sessionId }));
        }
      }

      else if (msg.type === 'stop_session') {
        console.log('[WS] Stopping session:', sessionId);
        stopSession(sessionId);
      }

      else if (msg.type === 'update_settings') {
        const session = activeSessions.get(sessionId);
        if (session) {
          if (msg.summary_mode) session.summaryMode = msg.summary_mode;
          if (msg.summary_interval) session.summaryInterval = msg.summary_interval;
        }
      }

    } catch (e) {
      console.error('[WS] Message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected, session:', sessionId);
    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.clients.delete(ws);
      // If no more clients, keep session alive for a bit (don't immediately kill transcriber)
    }
  });
});


async function maybeAutoSummarize(sessionId, session, currentTime) {
  if (!ANTHROPIC_KEY) return;

  if (session.summaryMode === 'time') {
    const elapsed = currentTime - session.lastSummaryTime;
    if (elapsed >= session.summaryInterval * 60) {
      try {
        const chunks = getChunks(sessionId, session.lastSummaryTime, currentTime);
        if (chunks.length < 3) return; // not enough content

        const prev = getLatestSummary(sessionId);
        const summary = await generateRollingSummary(ANTHROPIC_KEY, chunks, prev?.summary_text);
        insertSummary(sessionId, summary, session.lastSummaryTime, currentTime, 'rolling');
        session.lastSummaryTime = currentTime;

        broadcastToSession(sessionId, {
          type: 'summary',
          data: { summary_text: summary, start_time: chunks[0].start_time, end_time: currentTime, summary_type: 'rolling' },
        });
      } catch (err) {
        console.error('[Auto-Summary Error]', err.message);
      }
    }
  }

  else if (session.summaryMode === 'topic') {
    // Check for topic change every ~10 final chunks
    if (session.chunkCount % 10 === 0) {
      try {
        const recent = getRecentChunks(sessionId, 120); // last 2 minutes
        if (recent.length < 3) return;

        const result = await detectTopicChange(ANTHROPIC_KEY, recent, session.currentTopic);
        if (result.changed) {
          const chunks = getChunks(sessionId, session.lastSummaryTime, currentTime);
          if (chunks.length > 0) {
            const prev = getLatestSummary(sessionId);
            const summary = await generateRollingSummary(ANTHROPIC_KEY, chunks, prev?.summary_text);
            insertSummary(sessionId, summary, session.lastSummaryTime, currentTime, 'topic', result.topic);
            session.lastSummaryTime = currentTime;
            session.currentTopic = result.topic;

            broadcastToSession(sessionId, {
              type: 'summary',
              data: { summary_text: summary, start_time: chunks[0].start_time, end_time: currentTime, summary_type: 'topic', topic_label: result.topic },
            });

            broadcastToSession(sessionId, {
              type: 'topic_change',
              data: { topic: result.topic },
            });
          }
        }
      } catch (err) {
        console.error('[Topic Detection Error]', err.message);
      }
    }
  }
}


function stopSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  if (session.transcriber) {
    session.transcriber.close();
    session.transcriber = null;
  }
  broadcastToSession(sessionId, { type: 'session_stopped', data: {} });
}


// ── Start server ──
server.listen(PORT, () => {
  console.log(`\n🎙️  Real-Time Transcription Server`);
  console.log(`   http://localhost:${PORT}\n`);
});
