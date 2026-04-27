from pathlib import Path
from threading import Lock
from typing import Any, Dict, List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .audio_utils import (
    analyze_audio_file,
    browser_stats_from_form,
    cleanup_temp_file,
    compress_immediate_phrase_repetition,
    is_text_complete_enough,
    likely_fragment,
    looks_like_noise_text,
    merge_audio_stats,
    merge_pending_text,
    normalize_text,
    save_audio_chunk,
    should_reject_audio,
    strip_leading_overlap,
    write_temp_audio,
)
from .config import APP_TITLE, AUDIO_DIR, DB_PATH, DATA_DIR, TRANSCRIBE_LANGUAGE, TRANSCRIBE_LANGUAGE_MODE
from .db import create_session_id, ensure_session, ensure_storage_dirs, get_conn, init_db, utc_now_iso
from .html_page import HTML_PAGE
from .models import AskRequest, NewSessionRequest, SummaryRequest
from .openai_client import get_client
from .retrieval import build_context_block, retrieve_raw_chunks, retrieve_summaries
from .services.summary_service import maybe_create_summary
from .services.transcription_service import transcribe_file

app = FastAPI(title=APP_TITLE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

_PENDING_BY_SESSION: Dict[str, str] = {}
_PENDING_LOCK = Lock()


def _recent_texts(session_id: str, limit: int = 3) -> List[str]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT text FROM transcripts WHERE session_id = ? AND status = 'accepted' ORDER BY chunk_index DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
    return [str(row["text"]) for row in reversed(rows)]


def _next_chunk_index(session_id: str) -> int:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(chunk_index), -1) AS max_idx FROM transcripts WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    return int(row["max_idx"]) + 1


def _store_transcript_chunk(
    session_id: str,
    text: str,
    suffix: str,
    audio_bytes: bytes,
    stats: Dict[str, Any],
    capture_mode: str,
) -> Dict[str, Any]:
    next_idx = _next_chunk_index(session_id)
    audio_path = save_audio_chunk(session_id, next_idx, suffix, audio_bytes)

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO transcripts(
                session_id, chunk_index, text, created_at, audio_path, status, reject_reason,
                duration_ms, rms_dbfs, channels, frame_rate, sample_width, capture_mode, language_mode
            ) VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                next_idx,
                text,
                utc_now_iso(),
                str(audio_path),
                stats.get("duration_ms"),
                stats.get("rms_dbfs"),
                stats.get("channels"),
                stats.get("frame_rate"),
                stats.get("sample_width"),
                capture_mode,
                f"{TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}",
            ),
        )
        conn.commit()

    summary = maybe_create_summary(session_id)
    return {
        "ok": True,
        "stored": True,
        "filtered": False,
        "chunk_index": next_idx,
        "text": text,
        "audio_path": str(audio_path),
        "db_path": str(DB_PATH),
        "audio_stats": stats,
        "capture_mode": capture_mode,
        "language_mode": f"{TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}",
        "summary_created": summary,
    }



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
            """
            SELECT id, chunk_index, text, created_at, status, reject_reason, duration_ms, rms_dbfs,
                   channels, frame_rate, sample_width, audio_path, capture_mode, language_mode
            FROM transcripts WHERE session_id = ? ORDER BY chunk_index ASC
            """,
            (session_id,),
        ).fetchall()
        summaries = conn.execute(
            """
            SELECT id, summary_index, start_chunk_index, end_chunk_index, text, created_at
            FROM summaries WHERE session_id = ? ORDER BY summary_index ASC
            """,
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
        "summaries": [dict(row) for row in summaries],
    }


@app.post("/api/transcribe")
async def transcribe_audio(
    session_id: str = Form(...),
    capture_mode: str = Form("mic"),
    audio_stats_json: str | None = Form(None),
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

    tmp_path = None
    try:
        tmp_path = write_temp_audio(audio_bytes, suffix)
        server_stats = analyze_audio_file(tmp_path)
        browser_stats = browser_stats_from_form(audio_stats_json)
        stats = merge_audio_stats(server_stats, browser_stats)

        reject_audio, reject_reason = should_reject_audio(stats)
        if reject_audio:
            return {
                "ok": True,
                "stored": False,
                "filtered": True,
                "filter_reason": reject_reason,
                "audio_stats": stats,
                "capture_mode": capture_mode,
                "language_mode": f"{TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}",
            }

        # Build context hint from recent DB-stored transcripts to prime Whisper.
        # This is the single biggest accuracy improvement: Whisper uses the prompt
        # as conditioning context, so it knows what words came before this chunk.
        recent_texts = _recent_texts(session_id, limit=5)
        with _PENDING_LOCK:
            pending_text = _PENDING_BY_SESSION.get(session_id, "")
        context_parts = recent_texts[:]
        if pending_text:
            context_parts.append(pending_text)
        context_hint = " ".join(context_parts)

        raw_text = normalize_text(transcribe_file(tmp_path, context_hint=context_hint))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Transcription failed for {suffix} audio ({content_type or 'unknown content type'}): {exc}",
        ) from exc
    finally:
        cleanup_temp_file(tmp_path)

    # --- ALWAYS return raw_text so the frontend can show it in the live panel ---
    base_response = {
        "ok": True,
        "raw_text": raw_text,  # <-- Always present for live display
        "audio_stats": stats,
        "capture_mode": capture_mode,
        "language_mode": f"{TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}",
    }

    reject_text, reject_reason = looks_like_noise_text(raw_text)
    if reject_text:
        return {
            **base_response,
            "stored": False,
            "filtered": True,
            "filter_reason": reject_reason,
            "text": raw_text,
        }

    text = raw_text
    recent_texts = _recent_texts(session_id, limit=3)
    text, overlap_reason = strip_leading_overlap(text, recent_texts, max_ngram=12)
    if overlap_reason == "duplicate_overlap_chunk" or not text:
        return {
            **base_response,
            "stored": False,
            "filtered": True,
            "filter_reason": overlap_reason or "duplicate_overlap_chunk",
            "text": text,
        }

    text, repeated_phrase_changed = compress_immediate_phrase_repetition(text)

    with _PENDING_LOCK:
        pending = _PENDING_BY_SESSION.get(session_id, "")
        merged = merge_pending_text(pending, text) if pending else text
        merged = normalize_text(merged)

        if likely_fragment(merged) and not is_text_complete_enough(merged):
            _PENDING_BY_SESSION[session_id] = merged
            return {
                **base_response,
                "stored": False,
                "filtered": True,
                "filter_reason": overlap_reason or "pending_fragment",
                "text": merged,
                "pending_text": merged,  # <-- Show what's buffered
            }

        if not is_text_complete_enough(merged):
            _PENDING_BY_SESSION[session_id] = merged
            return {
                **base_response,
                "stored": False,
                "filtered": True,
                "filter_reason": overlap_reason or "pending_incomplete_sentence",
                "text": merged,
                "pending_text": merged,  # <-- Show what's buffered
            }

        _PENDING_BY_SESSION[session_id] = ""

    response = _store_transcript_chunk(
        session_id=session_id,
        text=merged,
        suffix=suffix,
        audio_bytes=audio_bytes,
        stats=stats,
        capture_mode=capture_mode,
    )
    response["raw_text"] = raw_text  # <-- Include raw for live panel
    if overlap_reason:
        response["merge_reason"] = overlap_reason
    if repeated_phrase_changed:
        response["phrase_dedup"] = True
    return response


@app.post("/api/summary")
def create_summary(payload: SummaryRequest) -> Dict[str, Any]:
    ensure_session(payload.session_id)
    return {"ok": True, "summary": maybe_create_summary(payload.session_id)}


@app.post("/api/ask")
def ask_question(payload: AskRequest) -> Dict[str, Any]:
    question = normalize_text(payload.question)
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    with get_conn() as conn:
        session = conn.execute(
            "SELECT session_id FROM sessions WHERE session_id = ?",
            (payload.session_id,),
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

    raw_rows = retrieve_raw_chunks(payload.session_id, question)
    summary_rows = retrieve_summaries(payload.session_id, question)
    if not raw_rows and not summary_rows:
        return {"answer": "This session has no transcript yet.", "citations": [], "used_chunks": []}

    context_parts: List[str] = []
    if summary_rows:
        context_parts.append("Session summaries:\n" + build_context_block(summary_rows, "summary"))
    if raw_rows:
        context_parts.append("Transcript chunks:\n" + build_context_block(raw_rows, "chunk"))
    context_text = "\n\n".join(context_parts)

    system_prompt = (
        "You answer questions only using the provided transcript evidence from one session. "
        "The session is primarily English but can contain short multilingual phrases. "
        "Do not normalize, translate, or erase multilingual snippets unless the user asks. "
        "If the evidence is insufficient, say that clearly. Cite chunk numbers and summary ranges when useful."
    )
    user_prompt = (
        f"Question:\n{question}\n\n"
        f"Evidence:\n{context_text}\n\n"
        "Answer based only on the evidence above."
    )

    try:
        client = get_client()
        response = client.responses.create(
            model="gpt-5.4-mini",
            input=[
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
            ],
        )
        answer = normalize_text(getattr(response, "output_text", "") or "")
        if not answer:
            raise ValueError("Empty model response")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"QA failed: {exc}") from exc

    citations = [f"chunk {row['chunk_index']}" for row in raw_rows]
    citations.extend(
        f"summary {row['summary_index']} ({row['start_chunk_index']}-{row['end_chunk_index']})" for row in summary_rows
    )
    return {
        "answer": answer,
        "citations": citations,
        "used_chunks": [dict(row) for row in raw_rows],
        "used_summaries": [dict(row) for row in summary_rows],
    }


if __name__ == "__main__":
    import uvicorn

    ensure_storage_dirs()
    print(f"[storage] data_dir={DATA_DIR}")
    print(f"[storage] db_path={DB_PATH}")
    print(f"[storage] audio_dir={AUDIO_DIR}")
    print(f"[transcribe] language_mode={TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}")
    uvicorn.run("voice_rag_stage2.app:app", host="0.0.0.0", port=8000, reload=True)
