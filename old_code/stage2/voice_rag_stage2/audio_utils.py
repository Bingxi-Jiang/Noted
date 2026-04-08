import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pydub import AudioSegment

from .config import AUDIO_DIR, MAX_SILENCE_DBFS, MIN_AUDIO_MS, MIN_TRANSCRIPT_CHARS, NOISE_EXACT_TEXTS


def save_audio_chunk(session_id: str, chunk_index: int, suffix: str, audio_bytes: bytes) -> Path:
    session_audio_dir = AUDIO_DIR / session_id
    session_audio_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = session_audio_dir / f"chunk_{chunk_index:06d}{suffix}"
    chunk_path.write_bytes(audio_bytes)
    return chunk_path


def normalize_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text


def alpha_ratio(text: str) -> float:
    meaningful = [c for c in text if not c.isspace()]
    if not meaningful:
        return 0.0
    alpha_num = sum(1 for c in meaningful if c.isalnum())
    return alpha_num / len(meaningful)


def tokenize_for_dedup(text: str) -> List[str]:
    return re.findall(r"[a-zA-Z0-9']+", (text or "").lower())


def looks_like_noise_text(text: str) -> Tuple[bool, Optional[str]]:
    t = normalize_text(text)
    if t.lower() in NOISE_EXACT_TEXTS or t in NOISE_EXACT_TEXTS:
        return True, "noise_text"
    if len(t) < MIN_TRANSCRIPT_CHARS:
        return True, "too_short_text"
    if alpha_ratio(t) < 0.25 and len(t) <= 6:
        return True, "low_signal_text"
    if re.fullmatch(r"([a-zA-Z哈啊哦嗯呃]{1,2})\1{2,}", t):
        return True, "repetitive_text"
    return False, None


def strip_leading_overlap(current: str, previous_texts: List[str], max_ngram: int = 12) -> Tuple[str, Optional[str]]:
    """Remove duplicated prefix in current text caused by overlapped audio windows."""
    curr = normalize_text(current)
    if not curr:
        return curr, None

    curr_tokens = tokenize_for_dedup(curr)
    if not curr_tokens:
        return curr, None

    prev_joined = " ".join(normalize_text(t) for t in previous_texts if t).strip()
    prev_tokens = tokenize_for_dedup(prev_joined)
    if not prev_tokens:
        return curr, None

    max_n = min(max_ngram, len(curr_tokens), len(prev_tokens))
    overlap_n = 0
    for n in range(max_n, 1, -1):
        if prev_tokens[-n:] == curr_tokens[:n]:
            overlap_n = n
            break

    if overlap_n == 0:
        return curr, None

    # Remove roughly the same number of word-like tokens from the raw text prefix.
    word_like = list(re.finditer(r"[a-zA-Z0-9']+", curr))
    if overlap_n >= len(curr_tokens):
        return "", "duplicate_overlap_chunk"
    if overlap_n <= len(word_like):
        cut_pos = word_like[overlap_n - 1].end()
        trimmed = normalize_text(curr[cut_pos:])
    else:
        trimmed = curr

    if not trimmed:
        return "", "duplicate_overlap_chunk"
    return trimmed, f"trimmed_overlap_tokens:{overlap_n}"


def compress_immediate_phrase_repetition(text: str, max_phrase: int = 6) -> Tuple[str, bool]:
    tokens = tokenize_for_dedup(text)
    if len(tokens) < 4:
        return normalize_text(text), False

    changed = False
    while True:
        replaced = False
        for n in range(min(max_phrase, len(tokens) // 2), 2, -1):
            prefix = tokens[:n]
            next_phrase = tokens[n : 2 * n]
            if prefix == next_phrase:
                tokens = prefix + tokens[2 * n :]
                changed = True
                replaced = True
                break
        if not replaced:
            break

    if not changed:
        return normalize_text(text), False
    return " ".join(tokens), True


def merge_pending_text(pending: str, current: str) -> str:
    pending = normalize_text(pending)
    current = normalize_text(current)
    if not pending:
        return current
    if not current:
        return pending

    # Remove overlap between pending tail and current head.
    current, _ = strip_leading_overlap(current, [pending], max_ngram=8)
    if not current:
        return pending

    if re.search(r"[.!?]['\"]?$", pending):
        merged = f"{pending} {current}"
    elif pending.endswith((",", ";", ":", "-", "—")):
        merged = f"{pending} {current}"
    else:
        merged = f"{pending} {current}"

    return normalize_text(merged)


def is_text_complete_enough(text: str, min_words: int = 12) -> bool:
    t = normalize_text(text)
    if not t:
        return False
    if re.search(r"[.!?]['\"]?$", t):
        return True
    words = tokenize_for_dedup(t)
    if len(words) >= min_words:
        return True
    return False


def likely_fragment(text: str, short_word_threshold: int = 4) -> bool:
    t = normalize_text(text)
    if not t:
        return True
    words = tokenize_for_dedup(t)
    if len(words) < short_word_threshold:
        return True
    if re.match(r"^(and|but|so|or|because|then|yeah|yes|uh|um)\b", t.lower()) and len(words) < 8:
        return True
    return False


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def browser_stats_from_form(audio_stats_json: Optional[str]) -> Dict[str, Any]:
    if not audio_stats_json:
        return {"source": "browser_missing"}
    try:
        payload = json.loads(audio_stats_json)
    except json.JSONDecodeError:
        return {"source": "browser_invalid_json"}
    return {
        "duration_ms": _safe_int(payload.get("duration_ms")),
        "rms_dbfs": _safe_float(payload.get("rms_dbfs")),
        "channels": _safe_int(payload.get("channels")),
        "frame_rate": _safe_int(payload.get("frame_rate")),
        "sample_width": _safe_int(payload.get("sample_width")),
        "source": payload.get("source") or "browser_client",
    }


def analyze_audio_file(file_path: str) -> Dict[str, Any]:
    try:
        seg = AudioSegment.from_file(file_path)
        return {
            "duration_ms": len(seg),
            "rms_dbfs": float(seg.dBFS) if seg.rms else float("-inf"),
            "channels": seg.channels,
            "frame_rate": seg.frame_rate,
            "sample_width": seg.sample_width,
            "source": "server_decode",
        }
    except Exception as exc:
        return {
            "duration_ms": None,
            "rms_dbfs": None,
            "channels": None,
            "frame_rate": None,
            "sample_width": None,
            "source": f"server_decode_failed:{type(exc).__name__}",
        }


def merge_audio_stats(primary: Dict[str, Any], fallback: Dict[str, Any]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    for key in ["duration_ms", "rms_dbfs", "channels", "frame_rate", "sample_width"]:
        merged[key] = primary.get(key) if primary.get(key) is not None else fallback.get(key)
    merged["source"] = primary.get("source") if any(primary.get(k) is not None for k in ["duration_ms", "rms_dbfs", "channels", "frame_rate", "sample_width"]) else fallback.get("source")
    merged["server_source"] = primary.get("source")
    merged["browser_source"] = fallback.get("source")
    return merged


def should_reject_audio(stats: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    duration_ms = stats.get("duration_ms")
    rms_dbfs = stats.get("rms_dbfs")
    if duration_ms is not None and duration_ms < MIN_AUDIO_MS:
        return True, "audio_too_short"
    if rms_dbfs == float("-inf"):
        return True, "audio_silence"
    if rms_dbfs is not None and rms_dbfs < MAX_SILENCE_DBFS:
        return True, "audio_too_quiet"
    return False, None


def write_temp_audio(audio_bytes: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        return tmp.name


def cleanup_temp_file(tmp_path: Optional[str]) -> None:
    if tmp_path:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
