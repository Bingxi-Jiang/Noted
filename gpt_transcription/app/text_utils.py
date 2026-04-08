from __future__ import annotations

import re
from dataclasses import dataclass


SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")
WORD_RE = re.compile(r"[a-zA-Z0-9_']+")


@dataclass
class FinalizedSpan:
    text: str
    start_ms: int
    end_ms: int


class SentenceAssembler:
    def __init__(self, max_pending_seconds: int, max_pending_chars: int) -> None:
        self.max_pending_ms = max_pending_seconds * 1000
        self.max_pending_chars = max_pending_chars
        self.pending_text = ""
        self.pending_start_ms: int | None = None
        self.pending_end_ms: int | None = None

    def ingest(self, utterance_text: str, start_ms: int, end_ms: int) -> list[FinalizedSpan]:
        utterance_text = normalize_transcript_text(utterance_text)
        if not utterance_text:
            return []

        if self.pending_start_ms is None:
            self.pending_start_ms = start_ms
        self.pending_end_ms = end_ms

        if self.pending_text:
            self.pending_text = f"{self.pending_text} {utterance_text}".strip()
        else:
            self.pending_text = utterance_text

        finalized: list[FinalizedSpan] = []
        while True:
            split_point = find_last_complete_sentence_boundary(self.pending_text)
            if split_point is None:
                break
            finalized_text = self.pending_text[:split_point].strip()
            remaining = self.pending_text[split_point:].strip()
            if finalized_text:
                finalized.append(
                    FinalizedSpan(
                        text=finalized_text,
                        start_ms=self.pending_start_ms or start_ms,
                        end_ms=end_ms,
                    )
                )
            self.pending_text = remaining
            self.pending_start_ms = end_ms if remaining else None
            if not remaining:
                self.pending_end_ms = None
                break

        if self.pending_text and self.pending_start_ms is not None:
            pending_duration = (self.pending_end_ms or end_ms) - self.pending_start_ms
            if (
                pending_duration >= self.max_pending_ms
                or len(self.pending_text) >= self.max_pending_chars
            ):
                finalized.append(
                    FinalizedSpan(
                        text=self.pending_text,
                        start_ms=self.pending_start_ms,
                        end_ms=self.pending_end_ms or end_ms,
                    )
                )
                self.pending_text = ""
                self.pending_start_ms = None
                self.pending_end_ms = None
        return finalized

    def flush(self) -> list[FinalizedSpan]:
        if not self.pending_text or self.pending_start_ms is None or self.pending_end_ms is None:
            return []
        span = FinalizedSpan(
            text=self.pending_text,
            start_ms=self.pending_start_ms,
            end_ms=self.pending_end_ms,
        )
        self.pending_text = ""
        self.pending_start_ms = None
        self.pending_end_ms = None
        return [span]


def find_last_complete_sentence_boundary(text: str) -> int | None:
    candidates = [m.end() for m in re.finditer(r"[.!?](?:\s|$)", text)]
    if not candidates:
        return None
    return candidates[-1]


def normalize_transcript_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:?!])", r"\1", text)
    return text


def format_ms(ms: int) -> str:
    total_seconds = max(0, ms // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def lexical_overlap_score(query: str, text: str) -> float:
    q_tokens = set(token.lower() for token in WORD_RE.findall(query))
    t_tokens = set(token.lower() for token in WORD_RE.findall(text))
    if not q_tokens or not t_tokens:
        return 0.0
    return len(q_tokens & t_tokens) / len(q_tokens)
