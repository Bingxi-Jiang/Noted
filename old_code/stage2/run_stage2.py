from voice_rag_stage2.app import app  # noqa: F401
from voice_rag_stage2.config import AUDIO_DIR, DATA_DIR, DB_PATH, TRANSCRIBE_LANGUAGE, TRANSCRIBE_LANGUAGE_MODE
from voice_rag_stage2.db import ensure_storage_dirs

if __name__ == "__main__":
    import uvicorn

    ensure_storage_dirs()
    print(f"[storage] data_dir={DATA_DIR}")
    print(f"[storage] db_path={DB_PATH}")
    print(f"[storage] audio_dir={AUDIO_DIR}")
    print(f"[transcribe] language_mode={TRANSCRIBE_LANGUAGE_MODE}:{TRANSCRIBE_LANGUAGE}")
    uvicorn.run("voice_rag_stage2.app:app", host="0.0.0.0", port=8000, reload=True)
