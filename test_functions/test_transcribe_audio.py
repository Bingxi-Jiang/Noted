import json
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
import os
from openai import OpenAI


# =========================
# CONFIG
# =========================
AUDIO_FILE_PATH = "outputs/audio/20260403_222630_overall.wav"
MODEL_NAME = "gpt-4o-transcribe"
LANGUAGE = "en"
OUTPUT_DIR = "outputs/transcribe"


def ensure_output_dir() -> Path:
    out_dir = Path(OUTPUT_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def validate_audio_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {path}")
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")


def get_openai_api_key() -> str:
    load_dotenv()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not found in .env")
    return api_key


def transcribe_file(
    client: OpenAI,
    audio_path: Path,
    model: str,
    language: str,
) -> str:
    with audio_path.open("rb") as f:
        transcript = client.audio.transcriptions.create(
            model=model,
            file=f,
            language=language,
        )

    text = getattr(transcript, "text", None)
    if not text:
        raise RuntimeError("No transcript text returned by API.")
    return text


def save_outputs(transcript_text: str, source_audio: Path, model: str) -> tuple[Path, Path]:
    out_dir = ensure_output_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = source_audio.stem

    txt_path = out_dir / f"{timestamp}_{stem}_transcript.txt"
    json_path = out_dir / f"{timestamp}_{stem}_transcript.json"

    txt_path.write_text(transcript_text, encoding="utf-8")

    payload = {
        "source_audio": str(source_audio),
        "model": model,
        "language": LANGUAGE,
        "transcript": transcript_text,
        "created_at": timestamp,
    }
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return txt_path, json_path


def main():
    try:
        api_key = get_openai_api_key()
        audio_path = Path(AUDIO_FILE_PATH)

        validate_audio_file(audio_path)

        client = OpenAI(api_key=api_key)

        print(f"[INFO] Transcribing: {audio_path}")
        transcript_text = transcribe_file(
            client=client,
            audio_path=audio_path,
            model=MODEL_NAME,
            language=LANGUAGE,
        )

        txt_path, json_path = save_outputs(
            transcript_text=transcript_text,
            source_audio=audio_path,
            model=MODEL_NAME,
        )

        print("[INFO] Transcription completed.")
        print(f"[INFO] TXT saved to:  {txt_path}")
        print(f"[INFO] JSON saved to: {json_path}")
        print("\n========== TRANSCRIPT ==========\n")
        print(transcript_text)
        print("\n================================")

    except Exception as e:
        print(f"[ERROR] Transcription failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()