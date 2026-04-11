# 🎙️ SCRIBE — Real-Time Transcription System

A full-stack real-time transcription app with rolling summaries, topic detection, and RAG-powered Q&A.

## Architecture

```
Browser (Mic) ──audio──▸ WebSocket ──▸ Deepgram STT (streaming)
                                           │
                                    ┌──────┴──────┐
                                    │ partial      │ final
                                    │ transcript   │ transcript
                                    │ (live UI)    │ (→ SQLite)
                                    └──────────────┘
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                        Rolling       Topic         RAG Q&A
                        Summary     Detection     (keyword search
                        (Claude)    (Claude)       + Claude)
```

### Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, routes, session management |
| `transcriber.js` | Deepgram streaming bridge (audio → text) |
| `summarizer.js` | Claude API calls for summaries, topic detection, Q&A |
| `db.js` | SQLite (sql.js) — sessions, transcript chunks, summaries |
| `public/index.html` | Single-page frontend with all UI |
| `.env` | API keys (Deepgram + Anthropic) |

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure API Keys

Edit `.env`:

```env
DEEPGRAM_API_KEY=your_key_here     # https://deepgram.com (free tier available)
ANTHROPIC_API_KEY=your_key_here    # https://console.anthropic.com
PORT=3000
```

### 3. Run

```bash
npm start
```

Open `http://localhost:3000`

## Features

### Real-Time Transcription
- **Partial transcripts** — appear instantly as you speak (italic, purple border)
- **Final transcripts** — confirmed text saved to DB with timestamps (green border)
- Three view modes: **Split** (partial + final labeled), **Combined** (flowing text), **Final Only**

### Rolling Summaries (configurable)
Three modes available in the sidebar:

| Mode | Behavior |
|------|----------|
| **Time-based** | Auto-summarize every N minutes (2, 5, 10, 15) |
| **Topic-based** | Detect topic changes and summarize when speaker shifts subjects |
| **Manual** | Click buttons to summarize on demand |

### Q&A (RAG)
- Ask questions about anything said in the session
- Uses keyword search to find relevant transcript chunks
- Claude answers with timestamp references (e.g. "Around 5:30, the speaker mentioned...")
- Source timestamps shown below each answer

### Timeline
- Visual timeline of summaries and topic changes
- Color-coded: purple (events), orange (topics), cyan (summaries)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all sessions |
| `POST` | `/api/sessions` | Create new session |
| `GET` | `/api/sessions/:id/chunks` | Get all transcript chunks |
| `GET` | `/api/sessions/:id/summaries` | Get all summaries |
| `POST` | `/api/sessions/:id/ask` | Q&A — `{ "question": "..." }` |
| `POST` | `/api/sessions/:id/summarize` | Trigger summary — `{ "mode": "all"|"time", "minutes": 5 }` |

## WebSocket Protocol

Connect to `ws://localhost:3000/ws`

### Client → Server

```json
{ "type": "start_session", "session_id": "...", "summary_mode": "time", "summary_interval": 5 }
{ "type": "stop_session" }
{ "type": "update_settings", "summary_mode": "topic" }
// Binary: raw PCM 16-bit 16kHz mono audio frames
```

### Server → Client

```json
{ "type": "partial_transcript", "data": { "text": "...", "start": 0, "end": 1.5 } }
{ "type": "final_transcript", "data": { "text": "...", "start": 0, "end": 1.5, "speaker": "speaker_0" } }
{ "type": "summary", "data": { "summary_text": "...", "start_time": 0, "end_time": 300 } }
{ "type": "topic_change", "data": { "topic": "Neural Networks" } }
```

## Notes

- SQLite DB file is stored at `./transcription.db` (auto-created)
- Audio is processed as PCM 16-bit, 16kHz mono (browser does conversion)
- Deepgram Nova-2 model is used by default (best accuracy/speed)
- Summaries use Claude claude-sonnet-4-20250514 via Anthropic API
---
## Todo List

- [ ] Lecture mode using mic
- [ ] Meeting mode default name is "speaker 2"
- [ ] Chinese words in Meeting notes
- [ ] Latex not displaying in notes
 
