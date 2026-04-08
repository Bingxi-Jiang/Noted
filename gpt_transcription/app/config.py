from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_host: str = os.getenv("APP_HOST", "127.0.0.1")
    app_port: int = int(os.getenv("APP_PORT", "8000"))
    debug: bool = os.getenv("DEBUG", "true").lower() == "true"

    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")

    database_path: str = os.getenv("DATABASE_PATH", "./data/realtime_transcription.sqlite3")

    # Realtime WebSocket connections use a realtime-capable model slug.
    # The actual ASR model is configured separately inside the transcription session.
    realtime_ws_model: str = os.getenv("REALTIME_WS_MODEL", "gpt-realtime")
    realtime_transcribe_model: str = os.getenv(
        "REALTIME_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"
    )
    qa_model: str = os.getenv("QA_MODEL", "gpt-5-mini")
    summary_model: str = os.getenv("SUMMARY_MODEL", "gpt-5-mini")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    transcript_language: str = os.getenv("TRANSCRIPT_LANGUAGE", "en")
    transcription_prompt: str = os.getenv(
        "TRANSCRIPTION_PROMPT",
        "Transcribe lecture audio accurately. Preserve terminology, formulas, named entities, and code terms. Use natural punctuation.",
    )

    vad_threshold: float = float(os.getenv("OPENAI_REALTIME_VAD_THRESHOLD", "0.5"))
    vad_prefix_padding_ms: int = int(os.getenv("OPENAI_REALTIME_PREFIX_PADDING_MS", "300"))
    vad_silence_duration_ms: int = int(os.getenv("OPENAI_REALTIME_SILENCE_MS", "500"))

    default_summary_mode: str = os.getenv("DEFAULT_SUMMARY_MODE", "time")
    default_summary_interval_seconds: int = int(os.getenv("DEFAULT_SUMMARY_INTERVAL_SECONDS", "300"))
    default_topic_similarity_threshold: float = float(
        os.getenv("DEFAULT_TOPIC_SIMILARITY_THRESHOLD", "0.72")
    )

    final_transcript_max_pending_seconds: int = int(
        os.getenv("FINAL_TRANSCRIPT_MAX_PENDING_SECONDS", "20")
    )
    final_transcript_max_pending_chars: int = int(
        os.getenv("FINAL_TRANSCRIPT_MAX_PENDING_CHARS", "240")
    )

    def ensure_paths(self) -> None:
        db_path = Path(self.database_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_paths()
