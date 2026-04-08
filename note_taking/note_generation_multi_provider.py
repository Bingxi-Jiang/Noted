from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv


# =========================
# HARD-CODED CONFIG (MVP)
# =========================
CONFIG = {
    "provider": "gemini",  # options: openai, gemini, claude
    "input_txt_path": "source.txt",
    "output_dir": "outputs",
    "save_prompt_debug": True,
    "generation": {
        "style": "actionable",      # concise, formal, academic, actionable, friendly
        "depth": "brief",            # brief, standard, deep
        "format": "plain_text",       # markdown, plain_text, json
        "language": "en",           # en, zh, bilingual
        "include_quotes": True,
        "include_action_items": True,
        "include_key_terms": True,
        "include_open_questions": True,
        "target_audience": "student builder",
        "custom_instruction": (
            "Keep the notes practical and clean. Highlight concrete next steps, "
            "important concepts, and anything that should be turned into follow-up work."
        ),
    },
    "models": {
        # Current official docs recommend newer APIs / SDKs for all three providers.
        # Keep these configurable because model availability can vary by account.
        "openai": "gpt-5.1",
        "gemini": "gemini-2.5-flash",
        "claude": "claude-sonnet-4-5",
    },
    "limits": {
        "max_input_chars": 120_000,
        "openai_max_output_tokens": 2200,
        "gemini_max_output_tokens": 2200,
        "claude_max_output_tokens": 2200,
    },
}


STYLE_GUIDES = {
    "concise": "Use compressed wording, low redundancy, and compact bullets.",
    "formal": "Use professional and polished language with clear sectioning.",
    "academic": "Use conceptually precise language, definitions, and logical grouping.",
    "actionable": "Prioritize tasks, decisions, implementation implications, and next steps.",
    "friendly": "Use clear, approachable wording that is easy to skim.",
}

DEPTH_GUIDES = {
    "brief": "Return only the highest-signal points. Avoid over-elaboration.",
    "standard": "Give balanced coverage of the main ideas, supporting details, and outcomes.",
    "deep": "Be comprehensive. Capture nuanced details, caveats, structure, and implications.",
}

FORMAT_GUIDES = {
    "markdown": (
        "Return clean Markdown with headings, bullets, and sub-bullets where helpful."
    ),
    "plain_text": "Return plain text only. Do not use Markdown syntax.",
    "json": (
        "Return valid JSON only with this schema: "
        "{"
        "\"title\": str, "
        "\"summary\": str, "
        "\"key_points\": [str], "
        "\"action_items\": [str], "
        "\"open_questions\": [str], "
        "\"key_terms\": [{\"term\": str, \"definition\": str}]"
        "}"
    ),
}

LANGUAGE_GUIDES = {
    "en": "Write the output in English.",
    "zh": "Write the output in Simplified Chinese.",
    "bilingual": "Write each main section in English first, then Simplified Chinese.",
}


@dataclass
class NoteOptions:
    style: str
    depth: str
    format: str
    language: str
    include_quotes: bool = False
    include_action_items: bool = True
    include_key_terms: bool = True
    include_open_questions: bool = True
    target_audience: str = "general"
    custom_instruction: str = ""


class ConfigError(Exception):
    pass


class BaseProvider:
    def generate(self, system_prompt: str, user_prompt: str) -> str:
        raise NotImplementedError


class OpenAIProvider(BaseProvider):
    def __init__(self, api_key: str, model: str, max_output_tokens: int):
        from openai import OpenAI

        self.client = OpenAI(api_key=api_key)
        self.model = model
        self.max_output_tokens = max_output_tokens

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.responses.create(
            model=self.model,
            input=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_output_tokens=self.max_output_tokens,
        )
        text = getattr(response, "output_text", None)
        if text:
            return text.strip()
        # defensive fallback in case SDK shape changes or output_text is absent
        try:
            return json.dumps(response.model_dump(), ensure_ascii=False, indent=2)
        except Exception:
            return str(response)


class GeminiProvider(BaseProvider):
    def __init__(self, api_key: str, model: str, max_output_tokens: int):
        from google import genai
        from google.genai import types

        self.client = genai.Client(api_key=api_key)
        self.types = types
        self.model = model
        self.max_output_tokens = max_output_tokens

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.models.generate_content(
            model=self.model,
            contents=user_prompt,
            config=self.types.GenerateContentConfig(
                system_instruction=system_prompt,
                max_output_tokens=self.max_output_tokens,
            ),
        )
        text = getattr(response, "text", None)
        if text:
            return text.strip()
        try:
            return json.dumps(response.to_json_dict(), ensure_ascii=False, indent=2)
        except Exception:
            return str(response)


class ClaudeProvider(BaseProvider):
    def __init__(self, api_key: str, model: str, max_output_tokens: int):
        import anthropic

        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.max_output_tokens = max_output_tokens

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_output_tokens,
            system=system_prompt,
            messages=[
                {"role": "user", "content": user_prompt},
            ],
        )
        parts = []
        for block in getattr(response, "content", []) or []:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        if parts:
            return "\n".join(parts).strip()
        try:
            return json.dumps(response.model_dump(), ensure_ascii=False, indent=2)
        except Exception:
            return str(response)


class NoteGenerator:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        load_dotenv()

    def run(self) -> Path:
        provider_name = self.config["provider"].lower().strip()
        input_path = Path(self.config["input_txt_path"])
        output_dir = Path(self.config["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)

        if not input_path.exists():
            raise FileNotFoundError(f"Input txt not found: {input_path}")

        source_text = input_path.read_text(encoding="utf-8").strip()
        if not source_text:
            raise ValueError("Input txt is empty.")

        source_text = source_text[: self.config["limits"]["max_input_chars"]]
        options = NoteOptions(**self.config["generation"])

        system_prompt = self._build_system_prompt(options)
        user_prompt = self._build_user_prompt(source_text, options)

        provider = self._build_provider(provider_name)
        result = provider.generate(system_prompt=system_prompt, user_prompt=user_prompt)
        cleaned_result = self._postprocess(result, options)

        output_path = output_dir / f"notes_{provider_name}.{self._ext_for_format(options.format)}"
        output_path.write_text(cleaned_result, encoding="utf-8")

        if self.config.get("save_prompt_debug", False):
            (output_dir / f"prompt_debug_{provider_name}.txt").write_text(
                f"=== SYSTEM PROMPT ===\n{system_prompt}\n\n=== USER PROMPT ===\n{user_prompt}",
                encoding="utf-8",
            )

        return output_path

    def _build_provider(self, provider_name: str) -> BaseProvider:
        models = self.config["models"]
        limits = self.config["limits"]

        if provider_name == "openai":
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise ConfigError("Missing OPENAI_API_KEY in .env")
            return OpenAIProvider(
                api_key=api_key,
                model=models["openai"],
                max_output_tokens=limits["openai_max_output_tokens"],
            )

        if provider_name == "gemini":
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise ConfigError("Missing GEMINI_API_KEY in .env")
            return GeminiProvider(
                api_key=api_key,
                model=models["gemini"],
                max_output_tokens=limits["gemini_max_output_tokens"],
            )

        if provider_name == "claude":
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ConfigError("Missing ANTHROPIC_API_KEY in .env")
            return ClaudeProvider(
                api_key=api_key,
                model=models["claude"],
                max_output_tokens=limits["claude_max_output_tokens"],
            )

        raise ConfigError(
            f"Unsupported provider '{provider_name}'. Use one of: openai, gemini, claude"
        )

    def _build_system_prompt(self, options: NoteOptions) -> str:
        style_guide = STYLE_GUIDES.get(options.style, STYLE_GUIDES["actionable"])
        depth_guide = DEPTH_GUIDES.get(options.depth, DEPTH_GUIDES["standard"])
        format_guide = FORMAT_GUIDES.get(options.format, FORMAT_GUIDES["markdown"])
        language_guide = LANGUAGE_GUIDES.get(options.language, LANGUAGE_GUIDES["en"])

        optional_rules = []
        if options.include_quotes:
            optional_rules.append(
                "Include a short 'Notable Quotes / Source Snippets' section with 3-8 short excerpts when evidence is useful."
            )
        if options.include_action_items:
            optional_rules.append(
                "Include an 'Action Items / Next Steps' section when the source implies follow-up work."
            )
        if options.include_key_terms:
            optional_rules.append(
                "Include a 'Key Terms / Concepts' section for important vocabulary, APIs, frameworks, or ideas."
            )
        if options.include_open_questions:
            optional_rules.append(
                "Include an 'Open Questions / Risks' section for ambiguity, missing information, or unresolved decisions."
            )

        return "\n".join(
            [
                "You are a high-precision note generation engine.",
                "Your task is to transform raw source text into useful, customizable notes.",
                "Stay faithful to the source. Do not invent facts that are not supported by the input.",
                style_guide,
                depth_guide,
                format_guide,
                language_guide,
                f"Target audience: {options.target_audience}.",
                *optional_rules,
                (
                    "When the source is messy, infer structure but not facts. "
                    "Compress repetition, preserve important details, and surface implementation-relevant information."
                ),
                f"Additional instruction: {options.custom_instruction or 'None.'}",
            ]
        )

    def _build_user_prompt(self, source_text: str, options: NoteOptions) -> str:
        section_preferences = []

        if options.format == "markdown":
            section_preferences.extend(
                [
                    "Preferred section order:",
                    "1. Title",
                    "2. Executive Summary",
                    "3. Main Notes",
                    "4. Key Terms / Concepts",
                    "5. Action Items / Next Steps",
                    "6. Open Questions / Risks",
                    "7. Notable Quotes / Source Snippets",
                ]
            )

        return "\n".join(
            [
                "Generate notes from the source text below.",
                "Preserve technical terms, named entities, and implementation details when present.",
                "If the source contains multiple themes, cluster them instead of mixing everything together.",
                "If a requested section has no evidence, omit it unless the output format requires it.",
                *section_preferences,
                "\n=== SOURCE TEXT BEGIN ===\n",
                source_text,
                "\n=== SOURCE TEXT END ===",
            ]
        )

    def _postprocess(self, text: str, options: NoteOptions) -> str:
        text = text.strip()
        if options.format == "json":
            # Try to normalize fenced JSON outputs into raw JSON.
            if text.startswith("```"):
                text = text.strip("`")
                if text.lower().startswith("json"):
                    text = text[4:].strip()
            try:
                obj = json.loads(text)
                return json.dumps(obj, ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                # keep original if the model didn't fully comply
                return text
        return text

    @staticmethod
    def _ext_for_format(output_format: str) -> str:
        if output_format == "json":
            return "json"
        if output_format == "plain_text":
            return "txt"
        return "md"


if __name__ == "__main__":
    generator = NoteGenerator(CONFIG)
    output_path = generator.run()
    print(f"Saved notes to: {output_path.resolve()}")
