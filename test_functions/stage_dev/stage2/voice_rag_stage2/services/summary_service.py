from typing import Any, Dict, List, Optional

from ..audio_utils import normalize_text
from ..config import MODEL_SUMMARY, SUMMARY_EVERY_N_CHUNKS, SUMMARY_SOURCE_WINDOW
from ..db import get_conn, utc_now_iso
from ..openai_client import get_client


def _tokenize_for_overlap(text: str) -> List[str]:
    return [tok for tok in normalize_text(text).lower().split() if tok]


def _merge_text_with_overlap(left: str, right: str, *, min_tokens: int = 4, max_tokens: int = 24) -> Optional[str]:
    left_tokens = _tokenize_for_overlap(left)
    right_tokens = _tokenize_for_overlap(right)
    if not left_tokens or not right_tokens:
        return None

    limit = min(len(left_tokens), len(right_tokens), max_tokens)
    for size in range(limit, min_tokens - 1, -1):
        if left_tokens[-size:] == right_tokens[:size]:
            merged_tokens = left_tokens + right_tokens[size:]
            return " ".join(merged_tokens)
    return None


def _build_summary_blocks(rows) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    for row in rows:
        text = normalize_text(row["text"])
        if not text:
            continue

        if blocks:
            merged = _merge_text_with_overlap(blocks[-1]["text"], text)
            if merged is not None:
                blocks[-1]["text"] = merged
                blocks[-1]["end_chunk_index"] = int(row["chunk_index"])
                continue

        blocks.append(
            {
                "start_chunk_index": int(row["chunk_index"]),
                "end_chunk_index": int(row["chunk_index"]),
                "created_at": row["created_at"],
                "text": text,
            }
        )
    return blocks


def maybe_create_summary(session_id: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        last_summary = conn.execute(
            "SELECT end_chunk_index FROM summaries WHERE session_id = ? ORDER BY summary_index DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        min_chunk = 0 if last_summary is None else int(last_summary["end_chunk_index"]) + 1
        rows = conn.execute(
            """
            SELECT chunk_index, text, created_at
            FROM transcripts
            WHERE session_id = ? AND status = 'accepted' AND chunk_index >= ?
            ORDER BY chunk_index ASC
            LIMIT ?
            """,
            (session_id, min_chunk, SUMMARY_SOURCE_WINDOW),
        ).fetchall()

    if len(rows) < SUMMARY_EVERY_N_CHUNKS:
        return None

    merged_blocks = _build_summary_blocks(rows)
    if not merged_blocks:
        return None

    context = "\n".join(
        f"[chunks {block['start_chunk_index']}-{block['end_chunk_index']}] ({block['created_at']}) {block['text']}"
        for block in merged_blocks
    )
    prompt = (
        "Summarize the transcript chunk block into 3-5 concise bullet-style sentences. "
        "Keep named entities, decisions, and action items. Do not invent facts."
    )
    client = get_client()
    response = client.responses.create(
        model=MODEL_SUMMARY,
        input=[
            {"role": "system", "content": [{"type": "input_text", "text": prompt}]},
            {"role": "user", "content": [{"type": "input_text", "text": context}]},
        ],
    )
    summary_text = normalize_text(getattr(response, "output_text", "") or "")
    if not summary_text:
        return None

    start_chunk = int(rows[0]["chunk_index"])
    end_chunk = int(rows[-1]["chunk_index"])
    with get_conn() as conn:
        next_idx_row = conn.execute(
            "SELECT COALESCE(MAX(summary_index), -1) AS max_idx FROM summaries WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        next_idx = int(next_idx_row["max_idx"]) + 1
        conn.execute(
            """
            INSERT INTO summaries(session_id, summary_index, start_chunk_index, end_chunk_index, text, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (session_id, next_idx, start_chunk, end_chunk, summary_text, utc_now_iso()),
        )
        conn.commit()
    return {
        "summary_index": next_idx,
        "start_chunk_index": start_chunk,
        "end_chunk_index": end_chunk,
        "text": summary_text,
    }
