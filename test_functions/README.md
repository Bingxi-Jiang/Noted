# Audio + Transcript Test Scripts

This folder contains four separate Python scripts:

1. `test_record_audio.py`
   - records system audio + microphone audio at the same time
   - starts immediately when launched
   - stop by typing `stop` in the terminal
   - saves files under `outputs/audio`

2. `test_transcribe_audio.py`
   - reads audio from `outputs/audio` (or a single configured file)
   - transcribes with OpenAI
   - saves results under `outputs/transcripts`

3. `test_chatboard.py`
   - reads one transcript file or a whole transcript directory
   - runs transcript-based Q&A with OpenAI, Gemini, or Anthropic
   - saves results under `outputs/chat`

4. `test_analyze_transcripts.py`
   - reads one transcript file or a whole transcript directory
   - extracts `special_notes` and `todos`
   - saves structured JSON under `outputs/analyze`

## Install

```bash
pip install -r requirements.txt
```

## Environment

Copy `.env.example` to `.env` and fill in the keys you want to use.

## Run order

```bash
python test_record_audio.py
python test_transcribe_audio.py
python test_chatboard.py
python test_analyze_transcripts.py
```

## Important notes

- For `test_record_audio.py`, system-audio capture depends on OS support.
- On macOS you may need a virtual loopback device such as BlackHole.
- Claude / Anthropic is included for transcript Q&A and transcript analysis.
- The transcription script currently supports OpenAI and Gemini only.
