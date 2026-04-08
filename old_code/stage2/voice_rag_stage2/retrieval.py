import sqlite3
from typing import List

from .audio_utils import normalize_text
from .config import MAX_CONTEXT_CHUNKS, MAX_TEXT_SCAN
from .db import get_conn


def text_score(question: str, text: str, recency_value: float) -> float:
    tokens = [tok.lower().strip(".,?!:;()[]{}\"'") for tok in question.replace("\n", " ").split()]
    tokens = [tok for tok in tokens if tok]
    token_set = set(tokens)
    text_lower = text.lower()
    overlap = sum(1 for tok in token_set if tok in text_lower)
    phrase_bonus = 8 if normalize_text(question).lower() in text_lower and len(question.strip()) > 6 else 0
    return overlap * 10 + phrase_bonus + recency_value


def build_context_block(rows: List[sqlite3.Row], tag: str) -> str:
    parts = []
    for row in rows:
        if tag == "summary":
            parts.append(
                f"[summary {row['summary_index']}, chunks {row['start_chunk_index']}-{row['end_chunk_index']}] "
                f"({row['created_at']}) {row['text']}"
            )
        else:
            parts.append(f"[chunk {row['chunk_index']}] ({row['created_at']}) {row['text']}")
    return "\n".join(parts)


def retrieve_raw_chunks(session_id: str, question: str, limit: int = MAX_CONTEXT_CHUNKS) -> List[sqlite3.Row]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, chunk_index, text, created_at
            FROM transcripts
            WHERE session_id = ? AND status = 'accepted'
            ORDER BY chunk_index DESC
            LIMIT ?
            """,
            (session_id, MAX_TEXT_SCAN),
        ).fetchall()

    scored = []
    for row in rows:
        recency_bonus = 2.0 / (1.0 + max(0, rows[0]["chunk_index"] - row["chunk_index"])) if rows else 0.0
        scored.append((text_score(question, row["text"], recency_bonus), row))

    scored.sort(key=lambda x: (x[0], x[1]["chunk_index"]), reverse=True)
    best = [row for _, row in scored[:limit]]
    best.sort(key=lambda r: r["chunk_index"])
    return best


def retrieve_summaries(session_id: str, question: str, limit: int = 4) -> List[sqlite3.Row]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, summary_index, start_chunk_index, end_chunk_index, text, created_at
            FROM summaries
            WHERE session_id = ?
            ORDER BY summary_index DESC
            LIMIT 50
            """,
            (session_id,),
        ).fetchall()

    scored = []
    for row in rows:
        recency_bonus = 1.0 / (1.0 + row["summary_index"])
        scored.append((text_score(question, row["text"], recency_bonus), row))

    scored.sort(key=lambda x: (x[0], x[1]["summary_index"]), reverse=True)
    best = [row for _, row in scored[:limit]]
    best.sort(key=lambda r: r["summary_index"])
    return best
