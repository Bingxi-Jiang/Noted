from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .db import db
from .qa import answer_question
from .realtime import runtime_manager
from .summarizer import rolling_summary_manager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Realtime Transcription + RAG Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class CreateSessionRequest(BaseModel):
    name: str = Field(default="Live Lecture Session")
    summary_mode: str = Field(default=settings.default_summary_mode)
    summary_interval_seconds: int = Field(default=settings.default_summary_interval_seconds)
    topic_similarity_threshold: float = Field(default=settings.default_topic_similarity_threshold)


class UpdateSummaryConfigRequest(BaseModel):
    summary_mode: str
    summary_interval_seconds: int = Field(default=300)
    topic_similarity_threshold: float = Field(default=0.72)


class QARequest(BaseModel):
    session_id: str
    question: str
    minutes_back: int | None = Field(default=15)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/api/sessions")
async def create_session(payload: CreateSessionRequest) -> dict:
    session_id = db.create_session(
        name=payload.name,
        summary_mode=payload.summary_mode,
        summary_interval_seconds=payload.summary_interval_seconds,
        topic_similarity_threshold=payload.topic_similarity_threshold,
    )
    rolling_summary_manager.configure(
        session_id,
        payload.summary_mode,
        payload.summary_interval_seconds,
        payload.topic_similarity_threshold,
    )
    return {"session_id": session_id}


@app.get("/api/sessions")
async def list_sessions() -> dict:
    return {"sessions": db.list_sessions()}


@app.post("/api/sessions/{session_id}/summary-config")
async def update_summary_config(session_id: str, payload: UpdateSummaryConfigRequest) -> dict:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.update_summary_config(
        session_id=session_id,
        summary_mode=payload.summary_mode,
        summary_interval_seconds=payload.summary_interval_seconds,
        topic_similarity_threshold=payload.topic_similarity_threshold,
    )
    rolling_summary_manager.configure(
        session_id,
        payload.summary_mode,
        payload.summary_interval_seconds,
        payload.topic_similarity_threshold,
    )
    return {"ok": True}


@app.get("/api/sessions/{session_id}/transcripts")
async def get_transcripts(session_id: str) -> dict:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    segments = db.get_transcript_segments(session_id=session_id, stage="final_sentence", limit=1000)
    return {
        "segments": [
            {
                "id": seg.id,
                "text": seg.text,
                "start_ms": seg.start_ms,
                "end_ms": seg.end_ms,
            }
            for seg in segments
        ]
    }


@app.post("/api/qa")
async def qa(payload: QARequest) -> dict:
    session = db.get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return await answer_question(
        session_id=payload.session_id,
        question=payload.question,
        minutes_back=payload.minutes_back,
    )


@app.websocket("/ws/transcribe/{session_id}")
async def websocket_transcribe(websocket: WebSocket, session_id: str) -> None:
    session = db.get_session(session_id)
    if not session:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Unknown session_id"})
        await websocket.close()
        return

    await websocket.accept()
    rolling_summary_manager.configure(
        session_id,
        session["summary_mode"],
        int(session["summary_interval_seconds"]),
        float(session["topic_similarity_threshold"]),
    )
    runtime = await runtime_manager.get_or_create(session_id)
    await runtime.attach_browser(websocket)

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                await runtime.handle_browser_bytes(message["bytes"])
            elif message.get("text") is not None:
                import json

                payload = json.loads(message["text"])
                await runtime.handle_browser_message(payload)
    except WebSocketDisconnect:
        await runtime.flush_pending()
    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.app_host, port=settings.app_port, reload=settings.debug)
