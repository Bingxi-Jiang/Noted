from __future__ import annotations

import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .config import settings
from .llm import vector_from_json, vector_to_json


@dataclass
class TranscriptSegment:
    id: str
    session_id: str
    item_id: str | None
    stage: str
    text: str
    start_ms: int
    end_ms: int
    created_at: str
    embedding: list[float] | None = None


@dataclass
class SummaryEntry:
    id: str
    session_id: str
    mode: str
    text: str
    start_ms: int
    end_ms: int
    created_at: str
    embedding: list[float] | None = None


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    summary_mode TEXT NOT NULL,
                    summary_interval_seconds INTEGER NOT NULL,
                    topic_similarity_threshold REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS transcript_segments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    item_id TEXT,
                    stage TEXT NOT NULL,
                    text TEXT NOT NULL,
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    embedding_json TEXT,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );

                CREATE TABLE IF NOT EXISTS summary_entries (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    text TEXT NOT NULL,
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    embedding_json TEXT,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );
                """
            )
            conn.commit()

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def create_session(
        self,
        name: str,
        summary_mode: str,
        summary_interval_seconds: int,
        topic_similarity_threshold: float,
    ) -> str:
        session_id = str(uuid.uuid4())
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions(id, name, created_at, summary_mode, summary_interval_seconds, topic_similarity_threshold)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    name,
                    self._utc_now(),
                    summary_mode,
                    summary_interval_seconds,
                    topic_similarity_threshold,
                ),
            )
            conn.commit()
        return session_id

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            return dict(row) if row else None

    def list_sessions(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def update_summary_config(
        self,
        session_id: str,
        summary_mode: str,
        summary_interval_seconds: int,
        topic_similarity_threshold: float,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET summary_mode = ?, summary_interval_seconds = ?, topic_similarity_threshold = ?
                WHERE id = ?
                """,
                (summary_mode, summary_interval_seconds, topic_similarity_threshold, session_id),
            )
            conn.commit()

    def insert_transcript_segment(
        self,
        session_id: str,
        stage: str,
        text: str,
        start_ms: int,
        end_ms: int,
        item_id: str | None = None,
        embedding: list[float] | None = None,
    ) -> TranscriptSegment:
        segment = TranscriptSegment(
            id=str(uuid.uuid4()),
            session_id=session_id,
            item_id=item_id,
            stage=stage,
            text=text,
            start_ms=start_ms,
            end_ms=end_ms,
            created_at=self._utc_now(),
            embedding=embedding,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO transcript_segments(id, session_id, item_id, stage, text, start_ms, end_ms, created_at, embedding_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    segment.id,
                    segment.session_id,
                    segment.item_id,
                    segment.stage,
                    segment.text,
                    segment.start_ms,
                    segment.end_ms,
                    segment.created_at,
                    vector_to_json(segment.embedding),
                ),
            )
            conn.commit()
        return segment

    def set_transcript_embedding(self, segment_id: str, embedding: list[float]) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE transcript_segments SET embedding_json = ? WHERE id = ?",
                (vector_to_json(embedding), segment_id),
            )
            conn.commit()

    def insert_summary_entry(
        self,
        session_id: str,
        mode: str,
        text: str,
        start_ms: int,
        end_ms: int,
        embedding: list[float] | None = None,
    ) -> SummaryEntry:
        summary = SummaryEntry(
            id=str(uuid.uuid4()),
            session_id=session_id,
            mode=mode,
            text=text,
            start_ms=start_ms,
            end_ms=end_ms,
            created_at=self._utc_now(),
            embedding=embedding,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO summary_entries(id, session_id, mode, text, start_ms, end_ms, created_at, embedding_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    summary.id,
                    summary.session_id,
                    summary.mode,
                    summary.text,
                    summary.start_ms,
                    summary.end_ms,
                    summary.created_at,
                    vector_to_json(summary.embedding),
                ),
            )
            conn.commit()
        return summary

    def set_summary_embedding(self, summary_id: str, embedding: list[float]) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE summary_entries SET embedding_json = ? WHERE id = ?",
                (vector_to_json(embedding), summary_id),
            )
            conn.commit()

    def get_transcript_segments(
        self,
        session_id: str,
        stage: str = "final_sentence",
        limit: int = 500,
    ) -> list[TranscriptSegment]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM transcript_segments
                WHERE session_id = ? AND stage = ?
                ORDER BY start_ms ASC
                LIMIT ?
                """,
                (session_id, stage, limit),
            ).fetchall()
        return [self._segment_from_row(row) for row in rows]

    def get_recent_transcript_segments(
        self,
        session_id: str,
        stage: str = "final_sentence",
        minutes_back: int | None = None,
        limit: int = 500,
    ) -> list[TranscriptSegment]:
        with self._connect() as conn:
            if minutes_back is None:
                rows = conn.execute(
                    """
                    SELECT * FROM transcript_segments
                    WHERE session_id = ? AND stage = ?
                    ORDER BY start_ms DESC
                    LIMIT ?
                    """,
                    (session_id, stage, limit),
                ).fetchall()
            else:
                latest = conn.execute(
                    "SELECT COALESCE(MAX(end_ms), 0) AS max_end FROM transcript_segments WHERE session_id = ? AND stage = ?",
                    (session_id, stage),
                ).fetchone()
                max_end = int(latest["max_end"] if latest else 0)
                cutoff = max(0, max_end - minutes_back * 60 * 1000)
                rows = conn.execute(
                    """
                    SELECT * FROM transcript_segments
                    WHERE session_id = ? AND stage = ? AND end_ms >= ?
                    ORDER BY start_ms ASC
                    LIMIT ?
                    """,
                    (session_id, stage, cutoff, limit),
                ).fetchall()
        return [self._segment_from_row(row) for row in rows]

    def get_recent_summaries(
        self,
        session_id: str,
        minutes_back: int | None = None,
        limit: int = 100,
    ) -> list[SummaryEntry]:
        with self._connect() as conn:
            if minutes_back is None:
                rows = conn.execute(
                    """
                    SELECT * FROM summary_entries
                    WHERE session_id = ?
                    ORDER BY start_ms DESC
                    LIMIT ?
                    """,
                    (session_id, limit),
                ).fetchall()
            else:
                latest = conn.execute(
                    "SELECT COALESCE(MAX(end_ms), 0) AS max_end FROM summary_entries WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
                max_end = int(latest["max_end"] if latest else 0)
                cutoff = max(0, max_end - minutes_back * 60 * 1000)
                rows = conn.execute(
                    """
                    SELECT * FROM summary_entries
                    WHERE session_id = ? AND end_ms >= ?
                    ORDER BY start_ms ASC
                    LIMIT ?
                    """,
                    (session_id, cutoff, limit),
                ).fetchall()
        return [self._summary_from_row(row) for row in rows]

    def _segment_from_row(self, row: sqlite3.Row) -> TranscriptSegment:
        return TranscriptSegment(
            id=row["id"],
            session_id=row["session_id"],
            item_id=row["item_id"],
            stage=row["stage"],
            text=row["text"],
            start_ms=int(row["start_ms"]),
            end_ms=int(row["end_ms"]),
            created_at=row["created_at"],
            embedding=vector_from_json(row["embedding_json"]),
        )

    def _summary_from_row(self, row: sqlite3.Row) -> SummaryEntry:
        return SummaryEntry(
            id=row["id"],
            session_id=row["session_id"],
            mode=row["mode"],
            text=row["text"],
            start_ms=int(row["start_ms"]),
            end_ms=int(row["end_ms"]),
            created_at=row["created_at"],
            embedding=vector_from_json(row["embedding_json"]),
        )


db = Database(settings.database_path)
