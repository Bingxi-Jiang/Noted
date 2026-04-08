from __future__ import annotations

import json
import math
from typing import Iterable, Sequence

from openai import OpenAI

from .config import settings


class LLMClient:
    def __init__(self) -> None:
        self._client: OpenAI | None = None

    @property
    def client(self) -> OpenAI:
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required.")
        if self._client is None:
            self._client = OpenAI(api_key=settings.openai_api_key)
        return self._client

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        response = self.client.embeddings.create(
            model=settings.embedding_model,
            input=list(texts),
        )
        return [item.embedding for item in response.data]

    def embed_text(self, text: str) -> list[float]:
        embeddings = self.embed_texts([text])
        return embeddings[0]

    def summarize(self, transcript_block: str, mode: str) -> str:
        prompt = (
            "You are building rolling lecture summaries.\n"
            f"Summary mode: {mode}.\n"
            "Write a concise, high-signal summary of the provided transcript span.\n"
            "Requirements:\n"
            "- Preserve important technical terms and examples.\n"
            "- Keep chronology and topic transitions clear.\n"
            "- Do not add facts not present in the transcript.\n"
            "- Use 3 to 6 short bullet points.\n\n"
            "Transcript span:\n"
            f"{transcript_block}"
        )
        response = self.client.responses.create(
            model=settings.summary_model,
            input=prompt,
        )
        return getattr(response, "output_text", "").strip()

    def answer_question(self, question: str, context: str) -> str:
        prompt = (
            "Answer the question using ONLY the retrieved lecture context.\n"
            "If the answer is uncertain or missing, say so explicitly.\n"
            "Cite supporting spans inline using the source tags exactly as provided, such as [T1] or [S1].\n"
            "Prefer transcript citations over summary citations when both exist.\n\n"
            f"Question:\n{question}\n\n"
            f"Context:\n{context}"
        )
        response = self.client.responses.create(
            model=settings.qa_model,
            input=prompt,
        )
        return getattr(response, "output_text", "").strip()


llm_client = LLMClient()


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def vector_to_json(vector: Sequence[float] | None) -> str | None:
    if vector is None:
        return None
    return json.dumps(list(vector))


def vector_from_json(value: str | None) -> list[float] | None:
    if not value:
        return None
    return list(json.loads(value))
