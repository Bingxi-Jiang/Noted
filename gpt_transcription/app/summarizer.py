from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field

from .db import SummaryEntry, TranscriptSegment, db
from .llm import cosine_similarity, llm_client


@dataclass
class SessionSummaryState:
    mode: str = "off"
    interval_seconds: int = 300
    topic_similarity_threshold: float = 0.72
    buffer: list[TranscriptSegment] = field(default_factory=list)


class RollingSummaryManager:
    def __init__(self) -> None:
        self.states: dict[str, SessionSummaryState] = defaultdict(SessionSummaryState)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def configure(
        self,
        session_id: str,
        mode: str,
        interval_seconds: int,
        topic_similarity_threshold: float,
    ) -> None:
        self.states[session_id] = SessionSummaryState(
            mode=mode,
            interval_seconds=interval_seconds,
            topic_similarity_threshold=topic_similarity_threshold,
            buffer=self.states.get(session_id, SessionSummaryState()).buffer,
        )

    async def add_segment(self, segment: TranscriptSegment) -> SummaryEntry | None:
        session_id = segment.session_id
        async with self._locks[session_id]:
            state = self.states[session_id]
            if state.mode == "off":
                return None
            state.buffer.append(segment)
            if state.mode == "time":
                return await self._maybe_flush_by_time(session_id, state)
            if state.mode == "topic":
                return await self._maybe_flush_by_topic(session_id, state, segment)
            return None

    async def flush(self, session_id: str) -> SummaryEntry | None:
        async with self._locks[session_id]:
            state = self.states.get(session_id)
            if not state or not state.buffer:
                return None
            return await self._flush_buffer(session_id, state)

    async def _maybe_flush_by_time(
        self,
        session_id: str,
        state: SessionSummaryState,
    ) -> SummaryEntry | None:
        if len(state.buffer) < 2:
            return None
        start_ms = state.buffer[0].start_ms
        end_ms = state.buffer[-1].end_ms
        if end_ms - start_ms >= state.interval_seconds * 1000:
            return await self._flush_buffer(session_id, state)
        return None

    async def _maybe_flush_by_topic(
        self,
        session_id: str,
        state: SessionSummaryState,
        latest: TranscriptSegment,
    ) -> SummaryEntry | None:
        if len(state.buffer) < 3 or latest.embedding is None:
            return None
        previous_segments = state.buffer[:-1]
        previous_embeddings = [seg.embedding for seg in previous_segments if seg.embedding]
        if not previous_embeddings:
            return None
        centroid = average_vectors(previous_embeddings)
        similarity = cosine_similarity(latest.embedding, centroid)
        buffered_text_len = sum(len(seg.text) for seg in previous_segments)
        if similarity < state.topic_similarity_threshold and buffered_text_len >= 180:
            preserved_latest = state.buffer.pop()
            summary = await self._flush_buffer(session_id, state)
            state.buffer = [preserved_latest]
            return summary
        if sum(len(seg.text) for seg in state.buffer) >= 1200:
            return await self._flush_buffer(session_id, state)
        return None

    async def _flush_buffer(
        self,
        session_id: str,
        state: SessionSummaryState,
    ) -> SummaryEntry | None:
        if not state.buffer:
            return None
        transcript_block = "\n".join(
            f"[{seg.start_ms}-{seg.end_ms}] {seg.text}" for seg in state.buffer
        )
        summary_text = await asyncio.to_thread(llm_client.summarize, transcript_block, state.mode)
        start_ms = state.buffer[0].start_ms
        end_ms = state.buffer[-1].end_ms
        summary = db.insert_summary_entry(
            session_id=session_id,
            mode=state.mode,
            text=summary_text,
            start_ms=start_ms,
            end_ms=end_ms,
            embedding=None,
        )
        embedding = await asyncio.to_thread(llm_client.embed_text, summary.text)
        db.set_summary_embedding(summary.id, embedding)
        summary.embedding = embedding
        state.buffer.clear()
        return summary


def average_vectors(vectors: list[list[float]]) -> list[float]:
    if not vectors:
        return []
    dims = len(vectors[0])
    return [sum(vector[i] for vector in vectors) / len(vectors) for i in range(dims)]


rolling_summary_manager = RollingSummaryManager()
