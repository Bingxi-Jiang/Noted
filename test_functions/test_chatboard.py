import os
import json
import time
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple

try:
    import requests
except ImportError as e:
    raise SystemExit("This script requires the 'requests' package. Install it with: pip install requests") from e

# ============================================================
# GLOBAL CONFIG
# ============================================================

# Which provider to use: "openai", "gemini", "claude"
PROVIDER = "openai"

# Prompt source:
# - "template": use TEMPLATE_PROMPT below
# - "user": ask you to type a prompt in terminal when the script runs
PROMPT_MODE = "user"

# Path to the folder that contains your txt knowledge base
# Example: "/Users/yourname/project/outputstranscribe/session_01"
TXT_FOLDER_PATH = "outputs/transcribe"

# Output directory for results
OUTPUT_DIR = "outputs/chat"

# API model names (change freely)
OPENAI_MODEL = "gpt-4.1-mini"
GEMINI_MODEL = "gemini-2.5-pro"
CLAUDE_MODEL = "claude-sonnet-4-20250514"

# Optional behavior
RECURSIVE_READ = True            # read txt files recursively
MAX_CONTEXT_CHARS = 120000       # cap total KB chars sent to model
TEMPERATURE = 0.2
MAX_OUTPUT_TOKENS = 2000
TIMEOUT_SECONDS = 180

# Generic template prompt for testing txt-based QA quality
TEMPLATE_PROMPT = (
    "Read the provided text database carefully and answer the user's request only "
    "using information grounded in that database. If the answer is not supported by "
    "the database, say so clearly instead of guessing. Then give a concise answer, "
    "followed by a short evidence section quoting or referencing the most relevant parts.\n\n"
    "User request: Paraphrase the main ideas from the database and summarize the most important points."
)

# ============================================================
# .env LOADING
# ============================================================

def load_dotenv_file(env_path: str = ".env") -> None:
    """Minimal .env loader so the script does not depend on python-dotenv."""
    path = Path(env_path)
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if value and ((value[0] == value[-1]) and value[0] in {"\"", "'"}):
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value


# ============================================================
# TXT DATABASE READING
# ============================================================

def list_txt_files(folder_path: str, recursive: bool = True) -> List[Path]:
    folder = Path(folder_path)
    if not folder.exists():
        raise FileNotFoundError(f"TXT folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"TXT folder path is not a directory: {folder}")

    pattern = "**/*.txt" if recursive else "*.txt"
    files = sorted(folder.glob(pattern))
    if not files:
        raise FileNotFoundError(f"No .txt files found under: {folder}")
    return files


def read_txt_database(folder_path: str, recursive: bool = True, max_chars: int = 120000) -> Tuple[str, List[Dict[str, object]]]:
    txt_files = list_txt_files(folder_path, recursive=recursive)

    sections: List[str] = []
    manifest: List[Dict[str, object]] = []
    total_chars = 0

    for i, file_path in enumerate(txt_files, start=1):
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            content = f"[ERROR READING FILE: {exc}]"

        header = f"\n===== FILE {i}: {file_path.name} =====\n"
        section = header + content.strip() + "\n"

        if total_chars + len(section) > max_chars:
            remaining = max_chars - total_chars
            if remaining > len(header) + 50:
                section = section[:remaining] + "\n[TRUNCATED DUE TO MAX_CONTEXT_CHARS]\n"
                sections.append(section)
                manifest.append({
                    "index": i,
                    "file_name": file_path.name,
                    "full_path": str(file_path.resolve()),
                    "chars_included": len(section),
                    "truncated": True,
                })
            break

        sections.append(section)
        manifest.append({
            "index": i,
            "file_name": file_path.name,
            "full_path": str(file_path.resolve()),
            "chars_included": len(section),
            "truncated": False,
        })
        total_chars += len(section)

    database_text = "\n".join(sections).strip()
    return database_text, manifest


# ============================================================
# PROMPT BUILDING
# ============================================================

def get_user_prompt(prompt_mode: str) -> str:
    mode = prompt_mode.strip().lower()
    if mode == "template":
        return TEMPLATE_PROMPT
    if mode == "user":
        user_prompt = input("Enter your prompt for the chatbot:\n> ").strip()
        if not user_prompt:
            raise ValueError("You selected PROMPT_MODE='user' but entered an empty prompt.")
        return user_prompt
    raise ValueError("PROMPT_MODE must be either 'template' or 'user'.")


def build_messages(database_text: str, user_prompt: str):
    system_prompt = (
        "You are evaluating how well a chatbot answers questions from a text-file database. "
        "Use only the database content below as your knowledge source. "
        "Do not fabricate facts. If the answer is not supported by the database, say that clearly."
    )

    user_message = (
        "TEXT DATABASE:\n"
        f"{database_text}\n\n"
        "USER REQUEST:\n"
        f"{user_prompt}"
    )
    return system_prompt, user_message


# ============================================================
# PROVIDER CALLS
# ============================================================

def call_openai(system_prompt: str, user_message: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError("Missing OPENAI_API_KEY in .env or environment.")

    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENAI_MODEL,
        "temperature": TEMPERATURE,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
    }

    response = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"].strip()


def call_gemini(system_prompt: str, user_message: str) -> str:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise EnvironmentError("Missing GEMINI_API_KEY or GOOGLE_API_KEY in .env or environment.")

    model = GEMINI_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}
    payload = {
        "system_instruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": user_message}],
            }
        ],
        "generationConfig": {
            "temperature": TEMPERATURE,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
        },
    }

    response = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()

    candidates = data.get("candidates", [])
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {json.dumps(data, ensure_ascii=False)[:1000]}")

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts).strip()
    if not text:
        raise RuntimeError(f"Gemini returned empty text: {json.dumps(data, ensure_ascii=False)[:1000]}")
    return text


def call_claude(system_prompt: str, user_message: str) -> str:
    api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("CLAUDE_API_KEY")
    if not api_key:
        raise EnvironmentError("Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY in .env or environment.")

    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": CLAUDE_MODEL,
        "system": system_prompt,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "temperature": TEMPERATURE,
        "messages": [
            {
                "role": "user",
                "content": user_message,
            }
        ],
    }

    response = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()

    content = data.get("content", [])
    text = "".join(block.get("text", "") for block in content if block.get("type") == "text").strip()
    if not text:
        raise RuntimeError(f"Claude returned empty text: {json.dumps(data, ensure_ascii=False)[:1000]}")
    return text


def run_provider(provider: str, system_prompt: str, user_message: str) -> str:
    provider = provider.strip().lower()
    if provider == "openai":
        return call_openai(system_prompt, user_message)
    if provider == "gemini":
        return call_gemini(system_prompt, user_message)
    if provider == "claude":
        return call_claude(system_prompt, user_message)
    raise ValueError("PROVIDER must be one of: 'openai', 'gemini', 'claude'.")


# ============================================================
# OUTPUT WRITING
# ============================================================

def ensure_output_dir(output_dir: str) -> Path:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def write_outputs(
    output_dir: str,
    provider: str,
    prompt_mode: str,
    txt_folder_path: str,
    user_prompt: str,
    manifest: List[Dict[str, object]],
    response_text: str,
) -> Tuple[Path, Path]:
    out_dir = ensure_output_dir(output_dir)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = f"{provider}_{prompt_mode}_{timestamp}"

    txt_path = out_dir / f"{stem}.txt"
    json_path = out_dir / f"{stem}.json"

    txt_body = (
        f"Provider: {provider}\n"
        f"Prompt mode: {prompt_mode}\n"
        f"TXT folder path: {txt_folder_path}\n"
        f"Generated at: {datetime.now().isoformat()}\n"
        f"Files used: {len(manifest)}\n\n"
        f"USER PROMPT:\n{user_prompt}\n\n"
        f"MODEL RESPONSE:\n{response_text}\n"
    )
    txt_path.write_text(txt_body, encoding="utf-8")

    payload = {
        "provider": provider,
        "prompt_mode": prompt_mode,
        "txt_folder_path": txt_folder_path,
        "generated_at": datetime.now().isoformat(),
        "user_prompt": user_prompt,
        "files_used": manifest,
        "model_response": response_text,
        "config": {
            "OPENAI_MODEL": OPENAI_MODEL,
            "GEMINI_MODEL": GEMINI_MODEL,
            "CLAUDE_MODEL": CLAUDE_MODEL,
            "RECURSIVE_READ": RECURSIVE_READ,
            "MAX_CONTEXT_CHARS": MAX_CONTEXT_CHARS,
            "TEMPERATURE": TEMPERATURE,
            "MAX_OUTPUT_TOKENS": MAX_OUTPUT_TOKENS,
        },
    }
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return txt_path, json_path


# ============================================================
# MAIN
# ============================================================

def main() -> None:
    load_dotenv_file(".env")

    start = time.time()
    user_prompt = get_user_prompt(PROMPT_MODE)
    database_text, manifest = read_txt_database(
        folder_path=TXT_FOLDER_PATH,
        recursive=RECURSIVE_READ,
        max_chars=MAX_CONTEXT_CHARS,
    )
    system_prompt, user_message = build_messages(database_text, user_prompt)

    response_text = run_provider(PROVIDER, system_prompt, user_message)
    txt_path, json_path = write_outputs(
        output_dir=OUTPUT_DIR,
        provider=PROVIDER,
        prompt_mode=PROMPT_MODE,
        txt_folder_path=TXT_FOLDER_PATH,
        user_prompt=user_prompt,
        manifest=manifest,
        response_text=response_text,
    )

    elapsed = time.time() - start
    print("=" * 80)
    print("Chat evaluation completed.")
    print(f"Provider: {PROVIDER}")
    print(f"Prompt mode: {PROMPT_MODE}")
    print(f"TXT files used: {len(manifest)}")
    print(f"Output TXT:  {txt_path}")
    print(f"Output JSON: {json_path}")
    print(f"Elapsed: {elapsed:.2f}s")
    print("=" * 80)
    print("MODEL RESPONSE:\n")
    print(response_text)


if __name__ == "__main__":
    main()
