from typing import Any, Dict, List, Optional

from ..config import MODEL_TRANSCRIBE, TRANSCRIBE_LANGUAGE, TRANSCRIBE_LANGUAGE_MODE, TRANSCRIBE_PROMPT
from ..openai_client import get_client


def choose_language_arg() -> Optional[str]:
    if TRANSCRIBE_LANGUAGE_MODE == "force":
        return TRANSCRIBE_LANGUAGE
    return None


def transcribe_file(tmp_path: str, context_hint: str = "") -> str:
    """Transcribe audio file.

    Args:
        tmp_path: Path to the audio file.
        context_hint: Recent transcript text to prime the model for continuity.
            Whisper's `prompt` parameter conditions the model on prior context,
            which dramatically improves accuracy at chunk boundaries.
    """
    client = get_client()

    # Build the prompt: base instructions + trailing context from recent chunks.
    # Whisper treats the prompt as "what was said just before this audio",
    # so appending the last ~200 chars of recent transcript helps it
    # maintain word continuity and avoid hallucinating repeated phrases.
    prompt_parts = [TRANSCRIBE_PROMPT]
    if context_hint:
        # Keep it short - Whisper prompt has a ~224 token limit
        tail = context_hint.strip()[-300:]
        prompt_parts.append(tail)
    prompt = " ".join(prompt_parts)

    request_args: Dict[str, Any] = {
        "model": MODEL_TRANSCRIBE,
        "prompt": prompt,
    }
    language = choose_language_arg()
    if language:
        request_args["language"] = language

    with open(tmp_path, "rb") as audio_file:
        request_args["file"] = audio_file
        transcription = client.audio.transcriptions.create(**request_args)

    text = getattr(transcription, "text", None)
    if text is None and isinstance(transcription, dict):
        text = transcription.get("text")
    if text is None:
        raise ValueError("Transcription returned no text")
    return str(text)
