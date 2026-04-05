import os
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any

try:
    from dotenv import load_dotenv
except ImportError:
    raise ImportError("Please install python-dotenv: pip install python-dotenv")

load_dotenv()

# =========================
# GLOBAL CONFIG
# =========================
PROVIDER = "openai"   # "openai" | "gemini" | "claude"

# Folder that contains transcribed .txt files
TRANSCRIBE_FOLDER_PATH = r"./outputs/transcribe"

# Output JSON path
OUTPUT_DIR = r"./outputs/analyze"
OUTPUT_FILENAME_PREFIX = "transcribe_analysis"

# Model names
OPENAI_MODEL = "gpt-4.1-mini"
GEMINI_MODEL = "gemini-2.5-pro"
CLAUDE_MODEL = "claude-3-7-sonnet-latest"

# Processing behavior
SUPPORTED_EXTENSIONS = {".txt"}
MERGE_ALL_FILES_INTO_ONE_REQUEST = True
MAX_CHARS_PER_FILE = 30000
MAX_TOTAL_CHARS = 120000
TEMPERATURE = 0.1

# If True, also runs a lightweight local heuristic pass and stores it in JSON
INCLUDE_HEURISTIC_PRECHECK = True

# =========================
# PROMPT
# =========================
SYSTEM_PROMPT = """You are an information extraction assistant.
Your task is to analyze transcribed text files and identify actionable or important signals.

Return ONLY valid JSON.
Do not include markdown fences.
Do not include explanatory text outside JSON.
"""

USER_PROMPT_TEMPLATE = """Analyze the following transcription text corpus.

Goal:
Detect whether the content contains:
1. special notes that require attention
2. highlighted or emphasized important items
3. to-do items or action items that need to be completed

Extraction instructions:
- Be conservative and avoid inventing facts.
- If an item is uncertain, include it in the relevant list and mark \"confidence\" as \"low\".
- If nothing is found for a category, return an empty list.
- Treat phrases like "important", "note", "remember", "don't forget", "highlight", "must", "need to", "should", deadlines, follow-ups, and next steps as potential signals.
- Consolidate duplicates when multiple files mention the same thing.
- Preserve concise source evidence snippets.

Return JSON with EXACTLY this top-level schema:
{{
  "summary": {{
    "has_special_notes": true,
    "has_highlights": true,
    "has_todos": true,
    "overall_priority": "low | medium | high"
  }},
  "special_notes": [
    {{
      "note": "string",
      "reason": "string",
      "confidence": "low | medium | high",
      "sources": [
        {{
          "file": "string",
          "snippet": "string"
        }}
      ]
    }}
  ],
  "highlights": [
    {{
      "item": "string",
      "why_highlighted": "string",
      "confidence": "low | medium | high",
      "sources": [
        {{
          "file": "string",
          "snippet": "string"
        }}
      ]
    }}
  ],
  "todos": [
    {{
      "task": "string",
      "owner": "string or null",
      "deadline": "string or null",
      "priority": "low | medium | high",
      "confidence": "low | medium | high",
      "sources": [
        {{
          "file": "string",
          "snippet": "string"
        }}
      ]
    }}
  ]
}}

Corpus:
{corpus}
"""

# =========================
# HEURISTIC PRECHECK
# =========================
SPECIAL_PATTERNS = [
    r"\bimportant\b",
    r"\bspecial note\b",
    r"\bnote that\b",
    r"\bremember\b",
    r"\bdon't forget\b",
    r"\bpay attention\b",
    r"\bhighlight\b",
    r"\bwarning\b",
    r"\bcritical\b",
]

TODO_PATTERNS = [
    r"\bto do\b",
    r"\btodo\b",
    r"\baction item\b",
    r"\bneed to\b",
    r"\bshould\b",
    r"\bmust\b",
    r"\bfinish\b",
    r"\bcomplete\b",
    r"\bfollow up\b",
    r"\bnext step\b",
    r"\bby tomorrow\b",
    r"\bdeadline\b",
]

HIGHLIGHT_PATTERNS = [
    r"\bmain point\b",
    r"\bkey point\b",
    r"\bkey takeaway\b",
    r"\bmost important\b",
    r"\bemphasis\b",
    r"\bhighlight\b",
    r"\bworth noting\b",
    r"\bnotably\b",
]


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def read_text_files(folder_path: str) -> List[Dict[str, str]]:
    folder = Path(folder_path)
    if not folder.exists():
        raise FileNotFoundError(f"Folder not found: {folder.resolve()}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Path is not a folder: {folder.resolve()}")

    files_data = []
    for file_path in sorted(folder.rglob("*")):
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                content = content[:MAX_CHARS_PER_FILE]
                files_data.append({
                    "file": str(file_path),
                    "content": content,
                })
            except Exception as e:
                print(f"[WARN] Failed to read {file_path}: {e}")
    return files_data


def build_corpus(files_data: List[Dict[str, str]]) -> str:
    parts = []
    total = 0
    for item in files_data:
        chunk = f"\n===== FILE: {item['file']} =====\n{item['content']}\n"
        if total + len(chunk) > MAX_TOTAL_CHARS:
            remaining = MAX_TOTAL_CHARS - total
            if remaining > 0:
                parts.append(chunk[:remaining])
            break
        parts.append(chunk)
        total += len(chunk)
    return "\n".join(parts)


def sentence_split(text: str) -> List[str]:
    rough = re.split(r"(?<=[.!?\n])\s+", text)
    return [normalize_whitespace(s) for s in rough if normalize_whitespace(s)]


def find_matches(sentences: List[str], patterns: List[str], label: str, file_name: str) -> List[Dict[str, Any]]:
    results = []
    for sent in sentences:
        for pattern in patterns:
            if re.search(pattern, sent, flags=re.IGNORECASE):
                results.append({
                    "type": label,
                    "file": file_name,
                    "snippet": sent[:300],
                })
                break
    return results


def heuristic_precheck(files_data: List[Dict[str, str]]) -> Dict[str, Any]:
    notes, highlights, todos = [], [], []
    for item in files_data:
        sentences = sentence_split(item["content"])
        notes.extend(find_matches(sentences, SPECIAL_PATTERNS, "special_note", item["file"]))
        highlights.extend(find_matches(sentences, HIGHLIGHT_PATTERNS, "highlight", item["file"]))
        todos.extend(find_matches(sentences, TODO_PATTERNS, "todo", item["file"]))

    return {
        "has_special_notes": len(notes) > 0,
        "has_highlights": len(highlights) > 0,
        "has_todos": len(todos) > 0,
        "special_note_hits": notes[:20],
        "highlight_hits": highlights[:20],
        "todo_hits": todos[:20],
    }

# =========================
# MODEL CALLS
# =========================

def call_openai(system_prompt: str, user_prompt: str) -> str:
    try:
        from openai import OpenAI
    except ImportError:
        raise ImportError("Please install openai: pip install openai")

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY in .env")

    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=OPENAI_MODEL,
        temperature=TEMPERATURE,
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    return response.output_text.strip()


def call_gemini(system_prompt: str, user_prompt: str) -> str:
    try:
        import google.generativeai as genai
    except ImportError:
        raise ImportError("Please install google-generativeai: pip install google-generativeai")

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("Missing GEMINI_API_KEY or GOOGLE_API_KEY in .env")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(
        model_name=GEMINI_MODEL,
        system_instruction=system_prompt,
    )
    response = model.generate_content(
        user_prompt,
        generation_config={
            "temperature": TEMPERATURE,
            "response_mime_type": "application/json",
        },
    )
    return (response.text or "").strip()


def call_claude(system_prompt: str, user_prompt: str) -> str:
    try:
        import anthropic
    except ImportError:
        raise ImportError("Please install anthropic: pip install anthropic")

    api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("CLAUDE_API_KEY")
    if not api_key:
        raise ValueError("Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY in .env")

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4000,
        temperature=TEMPERATURE,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    parts = []
    for block in response.content:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
    return "\n".join(parts).strip()


def call_model(provider: str, system_prompt: str, user_prompt: str) -> str:
    provider = provider.lower().strip()
    if provider == "openai":
        return call_openai(system_prompt, user_prompt)
    if provider == "gemini":
        return call_gemini(system_prompt, user_prompt)
    if provider == "claude":
        return call_claude(system_prompt, user_prompt)
    raise ValueError(f"Unsupported provider: {provider}")

# =========================
# JSON UTILITIES
# =========================

def extract_json(text: str) -> Dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        candidate = match.group(0)
        return json.loads(candidate)

    raise ValueError("Model output was not valid JSON.")


def ensure_schema(data: Dict[str, Any]) -> Dict[str, Any]:
    data.setdefault("summary", {})
    data["summary"].setdefault("has_special_notes", bool(data.get("special_notes")))
    data["summary"].setdefault("has_highlights", bool(data.get("highlights")))
    data["summary"].setdefault("has_todos", bool(data.get("todos")))
    data["summary"].setdefault("overall_priority", "low")

    data.setdefault("special_notes", [])
    data.setdefault("highlights", [])
    data.setdefault("todos", [])
    return data


def save_json(output_dir: str, filename_prefix: str, payload: Dict[str, Any]) -> str:
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = Path(output_dir) / f"{filename_prefix}_{PROVIDER}_{timestamp}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return str(path)

# =========================
# MAIN
# =========================

def main() -> None:
    files_data = read_text_files(TRANSCRIBE_FOLDER_PATH)
    if not files_data:
        raise FileNotFoundError(
            f"No supported text files found in: {Path(TRANSCRIBE_FOLDER_PATH).resolve()}"
        )

    corpus = build_corpus(files_data)
    user_prompt = USER_PROMPT_TEMPLATE.format(corpus=corpus)

    heuristic = heuristic_precheck(files_data) if INCLUDE_HEURISTIC_PRECHECK else None

    raw_output = call_model(PROVIDER, SYSTEM_PROMPT, user_prompt)
    structured = extract_json(raw_output)
    structured = ensure_schema(structured)

    final_payload = {
        "meta": {
            "provider": PROVIDER,
            "model": {
                "openai": OPENAI_MODEL,
                "gemini": GEMINI_MODEL,
                "claude": CLAUDE_MODEL,
            }.get(PROVIDER, None),
            "source_folder": str(Path(TRANSCRIBE_FOLDER_PATH).resolve()),
            "files_analyzed": [item["file"] for item in files_data],
            "file_count": len(files_data),
            "generated_at": datetime.now().isoformat(),
        },
        "result": structured,
    }

    if heuristic is not None:
        final_payload["heuristic_precheck"] = heuristic

    output_path = save_json(OUTPUT_DIR, OUTPUT_FILENAME_PREFIX, final_payload)
    print(f"[OK] JSON saved to: {output_path}")


if __name__ == "__main__":
    main()
