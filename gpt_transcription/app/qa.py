from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .db import SummaryEntry, TranscriptSegment, db
from .llm import cosine_similarity, llm_client
from .text_utils import format_ms, lexical_overlap_score


@dataclass
class RetrievedContext:
    source_id: str
    source_type: str
    text: str
    start_ms: int
    end_ms: int
    score: float


async def answer_question(session_id: str, question: str, minutes_back: int | None = None) -> dict:
    question_embedding = await asyncio.to_thread(llm_client.embed_text, question)

    transcript_segments = db.get_recent_transcript_segments(
        session_id=session_id,
        stage="final_sentence",
        minutes_back=minutes_back,
        limit=600,
    )
    summaries = db.get_recent_summaries(session_id=session_id, minutes_back=minutes_back, limit=100)

    ranked_context = rank_context(question, question_embedding, transcript_segments, summaries)
    top_context = ranked_context[:8]

    if not top_context:
        return {
            "answer": "I could not find any transcript context for that question yet.",
            "sources": [],
        }

    context_text = build_context(top_context)
    answer = await asyncio.to_thread(llm_client.answer_question, question, context_text)
    return {
        "answer": answer,
        "sources": [
            {
                "id": item.source_id,
                "type": item.source_type,
                "text": item.text,
                "start_ms": item.start_ms,
                "end_ms": item.end_ms,
                "start_label": format_ms(item.start_ms),
                "end_label": format_ms(item.end_ms),
                "score": round(item.score, 4),
            }
            for item in top_context
        ],
    }


def rank_context(
    question: str,
    question_embedding: list[float],
    transcript_segments: list[TranscriptSegment],
    summaries: list[SummaryEntry],
) -> list[RetrievedContext]:
    ranked: list[RetrievedContext] = []

    for idx, segment in enumerate(transcript_segments, start=1):
        semantic = cosine_similarity(question_embedding, segment.embedding or [])
        lexical = lexical_overlap_score(question, segment.text)
        score = semantic * 0.8 + lexical * 0.2
        ranked.append(
            RetrievedContext(
                source_id=f"T{idx}",
                source_type="transcript",
                text=segment.text,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                score=score,
            )
        )

    for idx, summary in enumerate(summaries, start=1):
        semantic = cosine_similarity(question_embedding, summary.embedding or [])
        lexical = lexical_overlap_score(question, summary.text)
        score = semantic * 0.65 + lexical * 0.15 + 0.2
        ranked.append(
            RetrievedContext(
                source_id=f"S{idx}",
                source_type="summary",
                text=summary.text,
                start_ms=summary.start_ms,
                end_ms=summary.end_ms,
                score=score,
            )
        )

    return sorted(ranked, key=lambda item: item.score, reverse=True)


def build_context(items: list[RetrievedContext]) -> str:
    blocks: list[str] = []
    for item in items:
        blocks.append(
            f"[{item.source_id}] ({item.source_type}) {format_ms(item.start_ms)}–{format_ms(item.end_ms)}\n{item.text}"
        )
    return "\n\n".join(blocks)
