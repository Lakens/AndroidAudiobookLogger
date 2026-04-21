# Audiobook workflow

Two standalone Python scripts that form the before and after of the listening step.

```
PDF ──► convert.py ──► MP3 + note  ──► [listen on phone, mark timestamps]  ──► process_timestamps.py ──► note with timestamps
```

---

## Installation

```bash
pip install edge-tts PyPDF2 requests
```

That is enough for the common case (text-based PDFs, Edge TTS). Optional extras are listed at the bottom.

---

## Step 1 — Convert a PDF to an audiobook

```bash
python convert.py paper.pdf
```

This creates three files in `./output/`:

| File | Purpose |
|------|---------|
| `paper.mp3` | Audio file — copy this to your phone |
| `paper_timing.json` | Word-boundary timestamps (used in step 3) |
| `paper.md` | Markdown note with a `## Timestamps` section |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--output-dir DIR` | `./output` | Where to write the three output files |
| `--voice NAME` | `en-US-AriaNeural` | Edge TTS voice name |
| `--rate +N%` | `+0%` | Speaking rate, e.g. `+20%` for 20% faster |
| `--extraction METHOD` | `auto` | `auto` \| `pypdf` \| `grobid` \| `marker` \| `glm-ocr` |
| `--tts ENGINE` | `edge-tts` | `edge-tts` \| `coqui` |

### Choosing a voice

List all available Edge TTS voices:

```bash
python -m edge_tts --list-voices
```

Some useful voices:

| Voice | Accent |
|-------|--------|
| `en-US-AriaNeural` | US English, female (default) |
| `en-US-GuyNeural` | US English, male |
| `en-GB-SoniaNeural` | British English, female |
| `en-GB-RyanNeural` | British English, male |
| `en-AU-NatashaNeural` | Australian English, female |

### Choosing an extraction method

| Method | Best for | Requires |
|--------|----------|----------|
| `auto` | Most PDFs (tries all in order) | — |
| `pypdf` | Clean digital PDFs | `pip install PyPDF2` |
| `grobid` | Academic papers | internet access (uses public servers) |
| `marker` | Complex layouts, tables | `pip install marker-pdf` + PyTorch |
| `glm-ocr` | Scanned PDFs | Ollama running locally with `glm-ocr` model |

The default `auto` order is `pypdf → grobid → marker → glm-ocr`. For scanned documents, use `--extraction glm-ocr` or `--extraction marker` directly to skip the fast methods.

### Examples

```bash
# Convert with a British male voice at slightly faster speed
python convert.py paper.pdf --voice en-GB-RyanNeural --rate +15%

# Force fast extraction only (skip Grobid/marker/OCR)
python convert.py paper.pdf --extraction pypdf

# Put output in a named folder
python convert.py "The Lean Startup.pdf" --output-dir ./audiobooks/lean-startup
```

---

## Step 2 — Listen and mark timestamps

1. Copy `paper.mp3` to your phone (the folder configured in the AudiobookNotetaker app).
2. Open the **AudiobookNotetaker** app and go to the **Library** tab.
3. Tap the title to start playing.
4. Tap **⏱ Mark Timestamp** (or press ⏮ on the lock screen, or triple-tap your headphone button) whenever you want to annotate a moment.

Timestamps are saved to `timestamp_log.json` on your phone's storage. Copy this file to your PC when you are done (or let it sync via OneDrive/Dropbox).

---

## Step 3 — Insert timestamps into the note

```bash
python process_timestamps.py --log timestamp_log.json --notes-dir ./output
```

For each unprocessed entry in the log, this script:

1. Finds `{note_title}.md` in `--notes-dir`.
2. Loads `{note_title}_timing.json` from `--audio-dir` (defaults to `--notes-dir`).
3. Extracts the ~270-second text window around the marked time.
4. Inserts a formatted line into the `## Timestamps` section:
   ```
   ⏱ `01:23:45` — "...the key finding was that spaced repetition increased retention by..."
   ```
5. Sets `processed: true` in the log so re-running is safe.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--log PATH` | `./timestamp_log.json` | Path to the log file from the app |
| `--notes-dir DIR` | *(required)* | Directory containing `.md` note files |
| `--audio-dir DIR` | same as `--notes-dir` | Directory containing `_timing.json` files |
| `--llm-clean` | off | Use Groq LLM to fix speech-recognition errors |

### Separate notes and audio directories

If you keep notes and audio files in different places:

```bash
python process_timestamps.py \
  --log timestamp_log.json \
  --notes-dir ./notes \
  --audio-dir ./audio
```

### LLM cleanup

The `--llm-clean` flag sends each transcript window to a Groq-hosted language model to fix speech-recognition errors (wrong homophones, mishearings) before inserting into the note. It does not add or remove words — only corrects obvious errors.

Requires:
```bash
pip install groq
export GROQ_API_KEY=your_key_here   # or set in Windows environment variables
```

Then:
```bash
python process_timestamps.py --log timestamp_log.json --notes-dir ./output --llm-clean
```

---

## Full example

```bash
# 1. Convert
python convert.py "Thinking Fast and Slow.pdf" --output-dir ./audiobooks

# 2. Copy the MP3 to your phone, listen, mark timestamps
# (sync timestamp_log.json back to PC)

# 3. Insert into note
python process_timestamps.py \
  --log timestamp_log.json \
  --notes-dir ./audiobooks
```

The result is `./audiobooks/Thinking Fast and Slow.md` with a populated `## Timestamps` section.

---

## How the timing works

When converting with Edge TTS, the TTS engine emits a `WordBoundary` event for each word containing its exact start time in the audio. These are saved to `_timing.json`:

```json
[
  {"word": "The",  "start_sec": 0.0},
  {"word": "main", "start_sec": 0.35},
  ...
]
```

When you mark a timestamp at, say, 1h 23m 45s, `process_timestamps.py` finds all words in the window from 1h 23m 15s to 1h 27m 45s and concatenates them to form the context quote. This is why the quotes accurately reflect what you were hearing at the moment you tapped the button.

This only works with Edge TTS. If you use `--tts coqui`, no timing file is produced and timestamps will show `(no transcript available)` unless you provide an external SRT file with the same stem name in `--audio-dir`.

---

## Optional dependencies

```bash
# For academic papers via Grobid (uses free public servers by default)
pip install requests

# For complex or multi-column PDFs
pip install marker-pdf   # also requires: pip install torch

# For scanned PDFs via local OCR
pip install ollama pymupdf
ollama pull glm-ocr

# For local TTS without internet
pip install TTS   # Coqui TTS (no timing data)

# For LLM-assisted transcript cleanup
pip install groq
```
