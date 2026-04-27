import os
import io
import json
import math
from dotenv import load_dotenv
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

load_dotenv()

APP_TITLE = "Stage 1 Voice Transcript QA MVP"
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("VOICE_RAG_DATA_DIR", SCRIPT_DIR / "voice_rag_data"))
AUDIO_DIR = DATA_DIR / "audio_chunks"
DB_PATH = Path(os.getenv("VOICE_RAG_DB", DATA_DIR / "voice_rag.db"))
MODEL_TRANSCRIBE = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
TRANSCRIBE_LANGUAGE = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "en")
MODEL_QA = os.getenv("OPENAI_QA_MODEL", "gpt-5.4-mini")
MAX_CONTEXT_CHUNKS = int(os.getenv("MAX_CONTEXT_CHUNKS", "12"))
MAX_TEXT_SCAN = int(os.getenv("MAX_TEXT_SCAN", "200"))

app = FastAPI(title=APP_TITLE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set.")
    return OpenAI(api_key=api_key)


def ensure_storage_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    ensure_storage_dirs()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                title TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'user_audio',
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            );

            CREATE INDEX IF NOT EXISTS idx_transcripts_session_chunk
            ON transcripts(session_id, chunk_index);
            """
        )


init_db()


class AskRequest(BaseModel):
    session_id: str
    question: str


class NewSessionRequest(BaseModel):
    title: str | None = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_session(session_id: str, title: str | None = None) -> None:
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO sessions(session_id, title, created_at) VALUES (?, ?, ?)",
                (session_id, title or session_id, utc_now_iso()),
            )
            conn.commit()


def create_session_id() -> str:
    return datetime.now().strftime("session_%Y%m%d_%H%M%S")


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return HTML_PAGE


@app.post("/api/session/new")
def new_session(payload: NewSessionRequest) -> Dict[str, str]:
    session_id = create_session_id()
    ensure_session(session_id, payload.title)
    return {"session_id": session_id, "title": payload.title or session_id}


@app.get("/api/session/{session_id}")
def get_session(session_id: str) -> Dict[str, Any]:
    with get_conn() as conn:
        session = conn.execute(
            "SELECT session_id, title, created_at FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        chunks = conn.execute(
            "SELECT id, chunk_index, text, created_at FROM transcripts WHERE session_id = ? ORDER BY chunk_index ASC",
            (session_id,),
        ).fetchall()

    return {
        "session": dict(session),
        "storage": {
            "data_dir": str(DATA_DIR),
            "db_path": str(DB_PATH),
            "audio_dir": str(AUDIO_DIR / session_id),
        },
        "transcripts": [dict(row) for row in chunks],
    }


def save_audio_chunk(session_id: str, chunk_index: int, suffix: str, audio_bytes: bytes) -> Path:
    session_audio_dir = AUDIO_DIR / session_id
    session_audio_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = session_audio_dir / f"chunk_{chunk_index:06d}{suffix}"
    chunk_path.write_bytes(audio_bytes)
    return chunk_path


@app.post("/api/transcribe")
async def transcribe_audio(
    session_id: str = Form(...),
    audio: UploadFile = File(...),
) -> Dict[str, Any]:
    ensure_session(session_id)

    content_type = (audio.content_type or "").lower()
    filename = audio.filename or "audio.webm"
    suffix = Path(filename).suffix.lower()
    if not suffix:
        if "wav" in content_type:
            suffix = ".wav"
        elif "mp4" in content_type or "m4a" in content_type:
            suffix = ".m4a"
        elif "mpeg" in content_type or "mp3" in content_type:
            suffix = ".mp3"
        elif "ogg" in content_type:
            suffix = ".ogg"
        else:
            suffix = ".webm"

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(chunk_index), -1) AS max_idx FROM transcripts WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        next_idx = int(row["max_idx"]) + 1

    try:
        client = get_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp.flush()
            tmp_path = tmp.name

        with open(tmp_path, "rb") as f:
            transcription = client.audio.transcriptions.create(
                model=MODEL_TRANSCRIBE,
                file=f,
                language=TRANSCRIBE_LANGUAGE,
            )
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Transcription failed for {suffix} audio ({content_type or 'unknown content type'}): {exc}",
        ) from exc
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    # SDK response may be a typed object or a dict-like object, depending on version.
    text = getattr(transcription, "text", None)
    if text is None and isinstance(transcription, dict):
        text = transcription.get("text")
    if not text:
        raise HTTPException(status_code=500, detail="Transcription returned no text")

    text = text.strip()
    if not text:
        return {"ok": True, "stored": False, "text": ""}

    audio_path = save_audio_chunk(session_id, next_idx, suffix, audio_bytes)

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO transcripts(session_id, chunk_index, text, created_at) VALUES (?, ?, ?, ?)",
            (session_id, next_idx, text, utc_now_iso()),
        )
        conn.commit()

    return {
        "ok": True,
        "stored": True,
        "chunk_index": next_idx,
        "text": text,
        "audio_path": str(audio_path),
        "db_path": str(DB_PATH),
    }



def simple_retrieve(session_id: str, question: str, limit: int = MAX_CONTEXT_CHUNKS) -> List[sqlite3.Row]:
    tokens = [t.lower() for t in question.replace("\n", " ").split() if t.strip()]
    tokens = [t.strip(".,?!:;()[]{}\"'") for t in tokens if t.strip(".,?!:;()[]{}\"'")]
    token_set = set(tokens)

    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, chunk_index, text, created_at FROM transcripts WHERE session_id = ? ORDER BY chunk_index DESC LIMIT ?",
            (session_id, MAX_TEXT_SCAN),
        ).fetchall()

    scored = []
    for row in rows:
        text_lower = row["text"].lower()
        overlap = sum(1 for tok in token_set if tok and tok in text_lower)
        recency_bonus = 1.0 / (1.0 + row["chunk_index"])
        score = overlap * 10 + recency_bonus
        if overlap > 0:
            score += 5
        scored.append((score, row))

    scored.sort(key=lambda x: (x[0], x[1]["chunk_index"]), reverse=True)
    best = [row for _, row in scored[:limit]]
    best.sort(key=lambda r: r["chunk_index"])
    return best



def build_context_block(rows: List[sqlite3.Row]) -> str:
    parts = []
    for row in rows:
        parts.append(
            f"[chunk {row['chunk_index']}] ({row['created_at']}) {row['text']}"
        )
    return "\n".join(parts)


@app.post("/api/ask")
def ask_question(payload: AskRequest) -> Dict[str, Any]:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    with get_conn() as conn:
        session = conn.execute(
            "SELECT session_id FROM sessions WHERE session_id = ?", (payload.session_id,)
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

    context_rows = simple_retrieve(payload.session_id, question)
    if not context_rows:
        return {
            "answer": "This session has no transcript yet.",
            "citations": [],
            "used_chunks": [],
        }

    context_text = build_context_block(context_rows)
    system_prompt = (
        "You answer questions only using the provided transcript chunks from one session. "
        "If the transcript does not contain enough information, say that clearly. "
        "Prefer concise answers. When making claims, cite chunk numbers in square brackets like [chunk 3]."
    )
    user_prompt = (
        f"Question:\n{question}\n\n"
        f"Transcript chunks:\n{context_text}\n\n"
        "Answer based only on the transcript above."
    )

    try:
        client = get_client()
        response = client.responses.create(
            model=MODEL_QA,
            input=[
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
            ],
        )
        answer = getattr(response, "output_text", None)
        if not answer:
            answer = ""
            if isinstance(response, dict):
                answer = response.get("output_text", "")
        answer = (answer or "").strip()
        if not answer:
            raise ValueError("Empty model response")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"QA failed: {exc}") from exc

    return {
        "answer": answer,
        "citations": [f"chunk {row['chunk_index']}" for row in context_rows],
        "used_chunks": [dict(row) for row in context_rows],
    }


HTML_PAGE = r"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stage 1 Voice Transcript QA</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; line-height: 1.5; }
    h1 { margin-bottom: 8px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
    button, input, textarea { font-size: 14px; }
    button { padding: 10px 14px; cursor: pointer; }
    textarea { width: 100%; min-height: 110px; }
    #log, #transcript, #answer { border: 1px solid #ddd; padding: 12px; border-radius: 8px; background: #fafafa; white-space: pre-wrap; }
    .pill { display: inline-block; background: #eef; padding: 4px 8px; border-radius: 999px; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <h1>Stage 1 Voice Transcript QA</h1>
  <div class="muted">录音分片上传 → 转写入库 → 对当前会话提问</div>

  <div class="row">
    <button id="newSessionBtn">New Session</button>
    <span>Current session: <span class="pill" id="sessionId">(none)</span></span>
  </div>
  <div class="muted" id="storageInfo">Storage: pending</div>

  <div class="row">
    <button id="startBtn" disabled>Start Recording</button>
    <button id="stopBtn" disabled>Stop Recording</button>
    <span id="recordingState" class="muted">Idle</span>
  </div>

  <h3>Transcript</h3>
  <div id="transcript">No transcript yet.</div>

  <h3>Ask</h3>
  <textarea id="question" placeholder="Ask something about this session..."></textarea>
  <div class="row">
    <button id="askBtn" disabled>Ask</button>
  </div>

  <h3>Answer</h3>
  <div id="answer">No answer yet.</div>

  <h3>Log</h3>
  <div id="log">Ready.</div>

<script>
let mediaRecorder = null;
let currentSessionId = null;
let isRecording = false;
let transcriptItems = [];

const sessionIdEl = document.getElementById('sessionId');
const recordingStateEl = document.getElementById('recordingState');
const transcriptEl = document.getElementById('transcript');
const answerEl = document.getElementById('answer');
const logEl = document.getElementById('log');
const questionEl = document.getElementById('question');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const askBtn = document.getElementById('askBtn');
const storageInfoEl = document.getElementById('storageInfo');

function log(msg) {
  const now = new Date().toLocaleTimeString();
  logEl.textContent = `[${now}] ${msg}\n` + logEl.textContent;
}

function renderTranscript() {
  if (!transcriptItems.length) {
    transcriptEl.textContent = 'No transcript yet.';
    return;
  }
  transcriptEl.textContent = transcriptItems
    .map(item => `[chunk ${item.chunk_index}] ${item.text}`)
    .join('\n');
}

async function createSession() {
  const res = await fetch('/api/session/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: null })
  });
  const data = await res.json();
  currentSessionId = data.session_id;
  sessionIdEl.textContent = currentSessionId;
  startBtn.disabled = false;
  askBtn.disabled = false;
  transcriptItems = [];
  renderTranscript();
  answerEl.textContent = 'No answer yet.';
  storageInfoEl.textContent = 'Storage folder: ./voice_rag_data';
  log(`Created session ${currentSessionId}`);
}

async function uploadChunk(blob) {
  if (!currentSessionId) {
    log('No active session.');
    return;
  }
  const formData = new FormData();
  formData.append('session_id', currentSessionId);
  formData.append('audio', blob, 'chunk.webm');

  const res = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData
  });
  const data = await res.json();

  if (!res.ok) {
    log(`Transcribe failed: ${data.detail || 'unknown error'}`);
    return;
  }
  if (data.stored) {
    transcriptItems.push({ chunk_index: data.chunk_index, text: data.text });
    renderTranscript();
    log(`Stored chunk ${data.chunk_index}: ${data.text}\nSaved audio: ${data.audio_path}`);
    storageInfoEl.textContent = `DB: ${data.db_path}`;
  } else {
    log('Transcription returned empty text.');
  }
}

let activeStream = null;
let chunkTimer = null;
const CHUNK_MS = 4000;

function chooseMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

function clearChunkTimer() {
  if (chunkTimer) {
    clearTimeout(chunkTimer);
    chunkTimer = null;
  }
}

function scheduleChunkStop() {
  clearChunkTimer();
  chunkTimer = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, CHUNK_MS);
}

async function beginRecorderCycle() {
  if (!activeStream || !isRecording) return;

  const mimeType = chooseMimeType();
  mediaRecorder = mimeType
    ? new MediaRecorder(activeStream, { mimeType })
    : new MediaRecorder(activeStream);

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data && event.data.size > 0) {
      const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
      const blob = new Blob([event.data], { type: mimeType || 'audio/webm' });
      await uploadChunk(new File([blob], `chunk.${ext}`, { type: blob.type }));
    }
  };

  mediaRecorder.onstop = async () => {
    clearChunkTimer();
    if (!isRecording) {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
        activeStream = null;
      }
      return;
    }
    await beginRecorderCycle();
  };

  mediaRecorder.start();
  scheduleChunkStop();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('getUserMedia is not supported in this browser.');
    return;
  }
  activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  isRecording = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  recordingStateEl.textContent = 'Recording (self-contained 4s chunks)';
  log('Recording started.');
  await beginRecorderCycle();
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordingStateEl.textContent = 'Idle';
  clearChunkTimer();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else if (activeStream) {
    activeStream.getTracks().forEach(track => track.stop());
    activeStream = null;
  }
  log('Recording stopped.');
}

async function askQuestion() {
  const question = questionEl.value.trim();
  if (!question) {
    alert('Please enter a question.');
    return;
  }
  if (!currentSessionId) {
    alert('Please create a session first.');
    return;
  }

  answerEl.textContent = 'Thinking...';
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: currentSessionId, question })
  });
  const data = await res.json();
  if (!res.ok) {
    answerEl.textContent = `Error: ${data.detail || 'unknown error'}`;
    log(`Ask failed: ${data.detail || 'unknown error'}`);
    return;
  }
  answerEl.textContent = data.answer;
  log('Question answered.');
}

document.getElementById('newSessionBtn').addEventListener('click', createSession);
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
askBtn.addEventListener('click', askQuestion);
</script>
</body>
</html>
"""


if __name__ == "__main__":
    import uvicorn
    ensure_storage_dirs()
    print(f"[storage] data_dir={DATA_DIR}")
    print(f"[storage] db_path={DB_PATH}")
    print(f"[openai] transcribe_model={MODEL_TRANSCRIBE}, language={TRANSCRIBE_LANGUAGE}")
    print(f"[storage] audio_dir={AUDIO_DIR}")
    uvicorn.run("stage1_voice_rag_app:app", host="0.0.0.0", port=8000, reload=True)
