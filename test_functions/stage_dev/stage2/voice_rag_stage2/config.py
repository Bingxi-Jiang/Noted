import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

APP_TITLE = "Stage 2 Voice Transcript QA"
BASE_DIR = Path(__file__).resolve().parent.parent
SCRIPT_DIR = BASE_DIR
DATA_DIR = Path(os.getenv("VOICE_RAG_DATA_DIR", SCRIPT_DIR / "voice_rag_data"))
AUDIO_DIR = DATA_DIR / "audio_chunks"
DB_PATH = Path(os.getenv("VOICE_RAG_DB", DATA_DIR / "voice_rag.db"))

MODEL_TRANSCRIBE = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
MODEL_QA = os.getenv("OPENAI_QA_MODEL", "gpt-5.4-mini")
MODEL_SUMMARY = os.getenv("OPENAI_SUMMARY_MODEL", MODEL_QA)

# Lock English for MVP, but the prompt asks the model to preserve brief foreign phrases
# rather than force-translating or hallucinating them away.
TRANSCRIBE_LANGUAGE_MODE = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE_MODE", "force").strip().lower()
TRANSCRIBE_LANGUAGE = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "en").strip().lower()
TRANSCRIBE_PROMPT = os.getenv(
    "OPENAI_TRANSCRIBE_PROMPT",
    "This is a lecture or conversation. Transcribe faithfully in the spoken language. "
    "Preserve technical terms, mathematical vocabulary, and domain-specific jargon exactly. "
    "Do not translate foreign phrases. Ignore background noise and filler sounds.",
)

MAX_CONTEXT_CHUNKS = int(os.getenv("MAX_CONTEXT_CHUNKS", "12"))
MAX_TEXT_SCAN = int(os.getenv("MAX_TEXT_SCAN", "300"))
SUMMARY_EVERY_N_CHUNKS = int(os.getenv("SUMMARY_EVERY_N_CHUNKS", "6"))
SUMMARY_SOURCE_WINDOW = int(os.getenv("SUMMARY_SOURCE_WINDOW", "8"))
MIN_AUDIO_MS = int(os.getenv("MIN_AUDIO_MS", "700"))
MAX_SILENCE_DBFS = float(os.getenv("MAX_SILENCE_DBFS", "-42"))
MIN_TRANSCRIPT_CHARS = int(os.getenv("MIN_TRANSCRIPT_CHARS", "2"))
CHUNK_MS = int(os.getenv("CHUNK_MS", "6000"))

NOISE_EXACT_TEXTS = {
    "",
    ".",
    "...",
    "uh",
    "um",
    "hmm",
    "mm",
    "mmm",
    "ah",
    "oh",
    "谢谢",
    "哈喽",
}
