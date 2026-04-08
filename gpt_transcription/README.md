# Realtime Transcription + Timeline RAG Demo

This project gives you a **real-time transcription web app** with four layers:

1. **Partial transcript**: live low-latency transcript shown while the user is still speaking.
2. **Committed utterances**: finalized speech-recognition chunks for each turn.
3. **Final transcript**: sentence-level transcript assembled from committed utterances and persisted to SQLite.
4. **RAG + rolling summary**: question answering over stored transcript spans and rolling summaries, with timestamps.

## What it does

- Browser microphone capture using an `AudioWorklet`
- Realtime streaming transcription using the **OpenAI Realtime API**
- Final transcript persisted into SQLite with `start_ms` / `end_ms`
- Rolling summary modes:
  - `off`
  - `time` (every N seconds of finalized transcript)
  - `topic` (flush when semantic similarity drops)
- Retrieval-based Q&A over transcript + summaries
- Timeline-aware source cards in the UI

## Project structure

```text
realtime_transcription_app/
├── app/
│   ├── config.py
│   ├── db.py
│   ├── llm.py
│   ├── main.py
│   ├── qa.py
│   ├── realtime.py
│   ├── summarizer.py
│   ├── text_utils.py
│   └── static/
│       ├── app.js
│       ├── audio-worklet.js
│       └── index.html
├── .env.example
├── README.md
└── requirements.txt
```

## Quick start

### 1. Create a virtual environment and install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
# Windows PowerShell:
# .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Then add your real API key:

```env
OPENAI_API_KEY=...
```

### 3. Run the server

```bash
uvicorn app.main:app --reload
```

### 4. Open the app

Visit:

```text
http://127.0.0.1:8000
```

## How the transcript pipeline works

### Partial transcript

The browser streams **24kHz mono PCM16 audio** to FastAPI over a WebSocket.
The backend forwards each chunk to the OpenAI Realtime transcription session.
As `delta` events arrive, the UI updates the **Partial transcript** panel.

### Committed utterances

When OpenAI emits `conversation.item.input_audio_transcription.completed`, that finalized utterance is shown in the **Committed utterances** panel and stored as `utterance_final`.

### Final transcript

A `SentenceAssembler` groups utterance-level chunks into more stable sentence-level spans. These are stored as `final_sentence` rows in SQLite and are the primary retrieval units for Q&A.

### Rolling summary

Each `final_sentence` segment is fed into the rolling summary manager.

- In `time` mode, the buffer flushes after `summary_interval_seconds`.
- In `topic` mode, the buffer flushes when the new segment embedding is semantically far enough from the prior buffer centroid.

## Database schema

The app uses SQLite and creates these tables automatically:

- `sessions`
- `transcript_segments`
- `summary_entries`

Important fields for transcript retrieval:

- `stage`: `utterance_final` or `final_sentence`
- `start_ms`
- `end_ms`
- `embedding_json`

## Q&A behavior

Q&A uses a hybrid ranking strategy:

- embedding similarity
- lexical overlap
- summary prior boost

The answer prompt is restricted to retrieved context and asks the model to cite source tags like `[T1]` and `[S1]`.

## Suggested next upgrades

### 1. Better final transcript quality

Right now, `final_sentence` uses sentence assembly over ASR-final utterances.
A stronger option is to run an **optional second-pass transcript refinement** per turn or per minute block.

### 2. Better storage

For production, replace SQLite with PostgreSQL + pgvector.

### 3. Better retrieval

Add:

- speaker diarization
- lecture section labels
- formula / keyword extraction
- vector index + BM25 hybrid search

### 4. Better UI

You may want to add:

- session history picker
- summary playback by clicking timeline spans
- auto-scroll pin toggle
- export transcript / summary JSON

## Important notes

- This is built as a **real-time engineering demo**, not a full production system.
- The topic-mode summarizer assumes embeddings are available and can incur extra cost.
- If you stop the mic mid-sentence, use **Flush Final/Summary** to force pending text into the database.

## Important model configuration

This project uses **two model settings**:

- `REALTIME_WS_MODEL` for the WebSocket connection to the Realtime API
- `REALTIME_TRANSCRIBE_MODEL` for the ASR/transcription model inside the transcription session

A common failure mode is using a transcription model as the WebSocket transport model. If you see `invalid_model`, keep `REALTIME_WS_MODEL=gpt-realtime` and only change `REALTIME_TRANSCRIBE_MODEL`.

## Audio input modes

The UI supports three browser-side input modes:

- **Microphone**
- **System / tab audio**
- **Both** (mixes mic + system audio before streaming)

For system audio, the browser will prompt you to share a tab, window, or screen. Some browser / OS combinations will not expose an audio track for every share target.
