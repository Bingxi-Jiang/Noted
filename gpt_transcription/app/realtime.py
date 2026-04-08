from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from typing import Any

import websockets
from fastapi import WebSocket

from .config import settings
from .db import db
from .llm import llm_client
from .summarizer import rolling_summary_manager
from .text_utils import SentenceAssembler, format_ms


@dataclass
class ItemTiming:
    item_id: str
    previous_item_id: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


class RealtimeTranscriptionRuntime:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.browser_ws: WebSocket | None = None
        self.openai_ws: Any | None = None
        self.openai_reader_task: asyncio.Task | None = None
        self.outbound_lock = asyncio.Lock()
        self.item_timings: dict[str, ItemTiming] = {}
        self.partial_text_by_item: dict[str, str] = {}
        self.sentence_assembler = SentenceAssembler(
            max_pending_seconds=settings.final_transcript_max_pending_seconds,
            max_pending_chars=settings.final_transcript_max_pending_chars,
        )
        self.is_connected = False

    async def attach_browser(self, websocket: WebSocket) -> None:
        self.browser_ws = websocket
        if not self.is_connected:
            await self._connect_openai()

    async def detach(self) -> None:
        try:
            await self.flush_pending()
        finally:
            if self.openai_reader_task:
                self.openai_reader_task.cancel()
            if self.openai_ws:
                await self.openai_ws.close()
            self.is_connected = False

    async def handle_browser_bytes(self, data: bytes) -> None:
        if not self.openai_ws:
            return
        event = {
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(data).decode("utf-8"),
        }
        async with self.outbound_lock:
            await self.openai_ws.send(json.dumps(event))

    async def handle_browser_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "commit_audio_buffer" and self.openai_ws:
            async with self.outbound_lock:
                await self.openai_ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
        elif message_type == "flush":
            await self.flush_pending()
        elif message_type == "ping":
            await self.send_browser_event({"type": "pong"})

    async def flush_pending(self) -> None:
        flushed_spans = self.sentence_assembler.flush()
        for span in flushed_spans:
            await self._persist_final_sentence(span.text, span.start_ms, span.end_ms, item_id=None)
        summary = await rolling_summary_manager.flush(self.session_id)
        if summary:
            await self.send_browser_event(
                {
                    "type": "rolling_summary",
                    "summary": {
                        "id": summary.id,
                        "mode": summary.mode,
                        "text": summary.text,
                        "start_ms": summary.start_ms,
                        "end_ms": summary.end_ms,
                        "start_label": format_ms(summary.start_ms),
                        "end_label": format_ms(summary.end_ms),
                    },
                }
            )

    async def _connect_openai(self) -> None:
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required.")

        ws_model = settings.realtime_ws_model.strip() or "gpt-realtime"
        url = f"wss://api.openai.com/v1/realtime?model={ws_model}"
        try:
            self.openai_ws = await websockets.connect(
                url,
                additional_headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                ping_interval=20,
                ping_timeout=20,
                max_size=8_000_000,
            )
        except websockets.exceptions.InvalidStatus as exc:
            raise RuntimeError(
                f"Failed to connect to OpenAI Realtime. Check REALTIME_WS_MODEL={ws_model!r} and your API key. Details: {exc}"
            ) from exc

        session_update = {
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "noise_reduction": {"type": "near_field"},
                        "transcription": {
                            "model": settings.realtime_transcribe_model,
                            "language": settings.transcript_language,
                            "prompt": settings.transcription_prompt,
                        },
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": settings.vad_threshold,
                            "prefix_padding_ms": settings.vad_prefix_padding_ms,
                            "silence_duration_ms": settings.vad_silence_duration_ms,
                        },
                    }
                },
                "include": ["item.input_audio_transcription.logprobs"],
            },
        }
        await self.openai_ws.send(json.dumps(session_update))
        self.openai_reader_task = asyncio.create_task(self._openai_event_loop())
        self.is_connected = True
        await self.send_browser_event(
            {
                "type": "status",
                "status": "connected",
                "message": (
                    "Realtime transcription connected "
                    f"(ws_model={settings.realtime_ws_model}, asr_model={settings.realtime_transcribe_model})."
                ),
            }
        )

    async def _openai_event_loop(self) -> None:
        assert self.openai_ws is not None
        try:
            async for raw_event in self.openai_ws:
                event = json.loads(raw_event)
                await self._handle_openai_event(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send_browser_event(
                {
                    "type": "error",
                    "message": f"OpenAI realtime connection error: {exc}",
                }
            )

    async def _handle_openai_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "input_audio_buffer.committed":
            item_id = event.get("item_id")
            if item_id:
                timing = self.item_timings.setdefault(item_id, ItemTiming(item_id=item_id))
                timing.previous_item_id = event.get("previous_item_id")
        elif event_type == "input_audio_buffer.speech_started":
            item_id = event.get("item_id")
            if item_id:
                timing = self.item_timings.setdefault(item_id, ItemTiming(item_id=item_id))
                timing.start_ms = int(event.get("audio_start_ms", 0))
                await self.send_browser_event({"type": "speech_started", "item_id": item_id})
        elif event_type == "input_audio_buffer.speech_stopped":
            item_id = event.get("item_id")
            if item_id:
                timing = self.item_timings.setdefault(item_id, ItemTiming(item_id=item_id))
                timing.end_ms = int(event.get("audio_end_ms", 0))
                await self.send_browser_event({"type": "speech_stopped", "item_id": item_id})
        elif event_type == "conversation.item.input_audio_transcription.delta":
            item_id = event.get("item_id")
            delta = event.get("delta", "")
            if item_id:
                current = self.partial_text_by_item.get(item_id, "")
                updated = f"{current}{delta}"
                self.partial_text_by_item[item_id] = updated
                await self.send_browser_event(
                    {"type": "partial_transcript", "item_id": item_id, "text": updated}
                )
        elif event_type == "conversation.item.input_audio_transcription.completed":
            await self._handle_completed_transcript(event)
        elif event_type == "error":
            message = self._format_openai_error(event)
            await self.send_browser_event({"type": "error", "message": message, "raw": event})

    def _format_openai_error(self, event: dict[str, Any]) -> str:
        error = event.get("error") or {}
        code = error.get("code") or event.get("code")
        message = error.get("message") or event.get("message") or json.dumps(event)
        if code == "invalid_model":
            return (
                "OpenAI rejected the model configuration. Use a realtime model for REALTIME_WS_MODEL "
                f"(current: {settings.realtime_ws_model}) and a transcription model for REALTIME_TRANSCRIBE_MODEL "
                f"(current: {settings.realtime_transcribe_model}). Raw message: {message}"
            )
        return message

    async def _handle_completed_transcript(self, event: dict[str, Any]) -> None:
        item_id = event.get("item_id")
        transcript = (event.get("transcript") or "").strip()
        if not transcript:
            return

        timing = self.item_timings.get(item_id or "")
        start_ms = timing.start_ms if timing and timing.start_ms is not None else 0
        end_ms = timing.end_ms if timing and timing.end_ms is not None else start_ms

        utterance_segment = db.insert_transcript_segment(
            session_id=self.session_id,
            item_id=item_id,
            stage="utterance_final",
            text=transcript,
            start_ms=start_ms,
            end_ms=end_ms,
            embedding=None,
        )
        utterance_embedding = await asyncio.to_thread(llm_client.embed_text, transcript)
        db.set_transcript_embedding(utterance_segment.id, utterance_embedding)
        utterance_segment.embedding = utterance_embedding

        await self.send_browser_event(
            {
                "type": "utterance_final",
                "segment": {
                    "id": utterance_segment.id,
                    "item_id": item_id,
                    "text": utterance_segment.text,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "start_label": format_ms(start_ms),
                    "end_label": format_ms(end_ms),
                },
            }
        )

        flushed_spans = self.sentence_assembler.ingest(transcript, start_ms, end_ms)
        for span in flushed_spans:
            await self._persist_final_sentence(span.text, span.start_ms, span.end_ms, item_id=item_id)

        self.partial_text_by_item.pop(item_id, None)
        await self.send_browser_event({"type": "partial_transcript", "item_id": item_id, "text": ""})

    async def _persist_final_sentence(
        self,
        text: str,
        start_ms: int,
        end_ms: int,
        item_id: str | None,
    ) -> None:
        text = text.strip()
        if not text:
            return

        segment = db.insert_transcript_segment(
            session_id=self.session_id,
            item_id=item_id,
            stage="final_sentence",
            text=text,
            start_ms=start_ms,
            end_ms=end_ms,
            embedding=None,
        )
        embedding = await asyncio.to_thread(llm_client.embed_text, text)
        db.set_transcript_embedding(segment.id, embedding)
        segment.embedding = embedding

        await self.send_browser_event(
            {
                "type": "final_transcript",
                "segment": {
                    "id": segment.id,
                    "item_id": item_id,
                    "text": segment.text,
                    "start_ms": segment.start_ms,
                    "end_ms": segment.end_ms,
                    "start_label": format_ms(segment.start_ms),
                    "end_label": format_ms(segment.end_ms),
                },
            }
        )

        summary = await rolling_summary_manager.ingest_transcript_segment(self.session_id, segment)
        if summary:
            await self.send_browser_event(
                {
                    "type": "rolling_summary",
                    "summary": {
                        "id": summary.id,
                        "mode": summary.mode,
                        "text": summary.text,
                        "start_ms": summary.start_ms,
                        "end_ms": summary.end_ms,
                        "start_label": format_ms(summary.start_ms),
                        "end_label": format_ms(summary.end_ms),
                    },
                }
            )

    async def send_browser_event(self, payload: dict[str, Any]) -> None:
        if not self.browser_ws:
            return
        await self.browser_ws.send_json(payload)


class RuntimeManager:
    def __init__(self) -> None:
        self._runtimes: dict[str, RealtimeTranscriptionRuntime] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str) -> RealtimeTranscriptionRuntime:
        async with self._lock:
            runtime = self._runtimes.get(session_id)
            if runtime is None:
                runtime = RealtimeTranscriptionRuntime(session_id)
                self._runtimes[session_id] = runtime
            return runtime


runtime_manager = RuntimeManager()
