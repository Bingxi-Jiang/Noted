import sqlite3
from datetime import datetime, timezone
from typing import Optional

from .config import AUDIO_DIR, DATA_DIR, DB_PATH


def ensure_storage_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    ensure_storage_dirs()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_session_id() -> str:
    return datetime.now().strftime("session_%Y%m%d_%H%M%S")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, column_type: str) -> None:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")
        conn.commit()


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
                audio_path TEXT,
                status TEXT NOT NULL DEFAULT 'accepted',
                reject_reason TEXT,
                duration_ms INTEGER,
                rms_dbfs REAL,
                channels INTEGER,
                frame_rate INTEGER,
                sample_width INTEGER,
                capture_mode TEXT,
                language_mode TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            );

            CREATE INDEX IF NOT EXISTS idx_transcripts_session_chunk
            ON transcripts(session_id, chunk_index);

            CREATE TABLE IF NOT EXISTS summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                summary_index INTEGER NOT NULL,
                start_chunk_index INTEGER NOT NULL,
                end_chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            );

            CREATE INDEX IF NOT EXISTS idx_summaries_session_idx
            ON summaries(session_id, summary_index);
            """
        )
        _ensure_column(conn, "transcripts", "audio_path", "TEXT")
        _ensure_column(conn, "transcripts", "status", "TEXT NOT NULL DEFAULT 'accepted'")
        _ensure_column(conn, "transcripts", "reject_reason", "TEXT")
        _ensure_column(conn, "transcripts", "duration_ms", "INTEGER")
        _ensure_column(conn, "transcripts", "rms_dbfs", "REAL")
        _ensure_column(conn, "transcripts", "channels", "INTEGER")
        _ensure_column(conn, "transcripts", "frame_rate", "INTEGER")
        _ensure_column(conn, "transcripts", "sample_width", "INTEGER")
        _ensure_column(conn, "transcripts", "capture_mode", "TEXT")
        _ensure_column(conn, "transcripts", "language_mode", "TEXT")


def ensure_session(session_id: str, title: Optional[str] = None) -> None:
    with get_conn() as conn:
        row = conn.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO sessions(session_id, title, created_at) VALUES (?, ?, ?)",
                (session_id, title or session_id, utc_now_iso()),
            )
            conn.commit()
