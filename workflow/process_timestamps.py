#!/usr/bin/env python3
"""
process_timestamps.py  —  Insert marked timestamps into markdown notes

Reads timestamp_log.json (written by the AudiobookNotetaker Android app),
finds the matching note for each entry, extracts the surrounding transcript
text from the _timing.json sidecar produced by convert.py, and inserts a
formatted line into the ## Timestamps section of the note.

Each log entry is marked processed: true once inserted so re-running is safe.

Usage:
  python process_timestamps.py --log timestamp_log.json --notes-dir ./output
  python process_timestamps.py --log timestamp_log.json --notes-dir ./notes --audio-dir ./audio
  python process_timestamps.py --log timestamp_log.json --notes-dir ./output --llm-clean

  --llm-clean requires:  pip install groq   and   GROQ_API_KEY env var

Options:
  --log        Path to timestamp_log.json (default: ./timestamp_log.json)
  --notes-dir  Directory containing the .md note files produced by convert.py
  --audio-dir  Directory containing _timing.json files (default: same as --notes-dir)
  --llm-clean  Pass transcript text through a Groq LLM to fix speech-recognition errors
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# SRT / VTT parsing
# ---------------------------------------------------------------------------

def _ts_to_sec(ts: str) -> float:
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0


def parse_srt(path: str) -> list:
    """Parse an SRT or VTT file into a list of {start, end, text} dicts."""
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    raw = re.sub(r"WEBVTT.*?\n", "", raw)
    raw = re.sub(r"(NOTE|STYLE)[^\n]*\n.*?\n\n", "", raw, flags=re.DOTALL)
    entries = []
    for block in re.split(r"\n\n+", raw.strip()):
        lines = [l for l in block.strip().splitlines() if l.strip()]
        if not lines:
            continue
        tc_line = next((l for l in lines if re.match(r"\d[\d:.,]+ *-->", l)), None)
        if not tc_line:
            continue
        m = re.match(r"([\d:.,]+)\s*-->\s*([\d:.,]+)", tc_line)
        if not m:
            continue
        start = _ts_to_sec(m.group(1))
        end   = _ts_to_sec(m.group(2))
        text_lines = [
            l for l in lines
            if l != tc_line and not re.fullmatch(r"\d+", l.strip())
        ]
        text = re.sub(r"<[^>]+>", "", " ".join(text_lines)).strip()
        if text:
            entries.append({"start": start, "end": end, "text": text})
    return entries


def timing_to_entries(timing: list) -> list:
    """Convert word-boundary timing list (_timing.json) to SRT-style entries."""
    return [
        {
            "start": float(w.get("start_sec", 0)),
            "end":   float(w.get("start_sec", 0)) + 0.5,
            "text":  w.get("word", ""),
        }
        for w in timing
    ]


def get_window(entries: list, target_sec: float,
               lookback: float = 30.0, forward: float = 240.0,
               max_chars: int = 1200) -> str:
    """Return transcript text from (target - lookback) to (target + forward)."""
    texts = [
        e["text"] for e in entries
        if e["start"] >= target_sec - lookback and e["start"] <= target_sec + forward
    ]
    result = " ".join(texts)
    if max_chars and len(result) > max_chars:
        result = result[:max_chars - 1].rsplit(" ", 1)[0] + "\u2026"
    return result


# ---------------------------------------------------------------------------
# Frontmatter reader
# ---------------------------------------------------------------------------

def read_frontmatter(path: str) -> dict:
    try:
        content = Path(path).read_text(encoding="utf-8")
    except OSError:
        return {}
    if not content.startswith("---"):
        return {}
    end = content.find("\n---", 3)
    if end == -1:
        return {}
    fm = {}
    for line in content[3:end].splitlines():
        if ":" in line and not line.strip().startswith("-"):
            parts = line.split(":", 1)
            fm[parts[0].strip()] = parts[1].strip().strip("\"'") if len(parts) == 2 else ""
    return fm


# ---------------------------------------------------------------------------
# Transcript loader (with cache)
# ---------------------------------------------------------------------------

_transcript_cache: dict = {}


def load_transcript(note_path: str, audio_dir: str) -> list | None:
    """Load transcript entries for a note from _timing.json or SRT/VTT."""
    if note_path in _transcript_cache:
        return _transcript_cache[note_path]

    fm = read_frontmatter(note_path)
    entries = None

    # Prefer _timing.json (produced by convert.py with Edge TTS)
    timing_file = fm.get("timing_file", "")
    if timing_file:
        timing_path = os.path.join(audio_dir, timing_file)
        if os.path.isfile(timing_path):
            try:
                timing = json.loads(Path(timing_path).read_text(encoding="utf-8"))
                entries = timing_to_entries(timing)
                print(f"  Transcript: {timing_file} ({len(entries):,} words)")
            except Exception as e:
                print(f"  WARNING: Could not load {timing_file}: {e}")

    # Fall back to SRT/VTT if present in audio_dir
    if entries is None:
        note_stem = Path(note_path).stem
        for ext in (".srt", ".vtt"):
            srt_path = os.path.join(audio_dir, note_stem + ext)
            if os.path.isfile(srt_path):
                try:
                    entries = parse_srt(srt_path)
                    print(f"  Transcript: {note_stem + ext} ({len(entries):,} entries)")
                    break
                except Exception as e:
                    print(f"  WARNING: Could not parse {srt_path}: {e}")

    _transcript_cache[note_path] = entries
    return entries


# ---------------------------------------------------------------------------
# LLM cleanup (optional, via Groq)
# ---------------------------------------------------------------------------

_groq_client = None

_SYSTEM_PROMPT = """\
You are correcting auto-generated speech-to-text transcription errors.
Rules:
1. Do NOT add any words that were not in the original.
2. Do NOT remove any words.
3. Only change a word if it is clearly a speech-recognition error.
4. Fix punctuation and capitalisation where clearly wrong.
5. Return ONLY the corrected text — no explanation, no commentary.
"""


def llm_clean(raw_text: str, max_chars: int = 1000) -> str:
    global _groq_client
    if _groq_client is None:
        try:
            from groq import Groq
        except ImportError:
            print("ERROR: 'groq' not installed. Run: pip install groq", file=sys.stderr)
            sys.exit(1)
        api_key = os.environ.get("GROQ_API_KEY", "")
        if not api_key:
            print("ERROR: GROQ_API_KEY environment variable not set.", file=sys.stderr)
            sys.exit(1)
        _groq_client = Groq(api_key=api_key)

    try:
        response = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=1024,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": raw_text},
            ],
        )
        cleaned = response.choices[0].message.content.strip()
        if max_chars and len(cleaned) > max_chars:
            cleaned = cleaned[:max_chars - 1].rsplit(" ", 1)[0] + "\u2026"
        return cleaned
    except Exception as e:
        print(f"  WARNING: LLM cleanup failed ({e}), using raw transcript.")
        return raw_text


# ---------------------------------------------------------------------------
# Insert timestamp into note
# ---------------------------------------------------------------------------

def insert_timestamp(note_path: str, ts: str, seconds: int,
                     transcript_entries, use_llm: bool) -> bool:
    """Insert one timestamp line into the ## Timestamps section. Returns True on success."""
    try:
        content = Path(note_path).read_text(encoding="utf-8")
    except OSError as e:
        print(f"  ERROR reading note: {e}")
        return False

    if transcript_entries is not None:
        raw = get_window(transcript_entries, float(seconds),
                         max_chars=0 if use_llm else 1200)
        if raw:
            text = llm_clean(raw) if use_llm else raw
            entry_line = f'- \u23f1 `{ts}` \u2014 "{text}"'
        else:
            entry_line = f"- \u23f1 `{ts}` \u2014 *(no transcript available)*"
    else:
        entry_line = f"- \u23f1 `{ts}` \u2014 *(no transcript available)*"

    lines = content.split("\n")
    sec_idx = next(
        (i for i, l in enumerate(lines) if l.strip() == "## Timestamps"), -1
    )

    if sec_idx == -1:
        lines += ["", "## Timestamps", "", entry_line]
    else:
        insert_at = len(lines)
        for i in range(sec_idx + 1, len(lines)):
            if lines[i].startswith("## ") or lines[i] == "---":
                insert_at = i
                break
        last = sec_idx
        for i in range(sec_idx + 1, insert_at):
            if lines[i].strip():
                last = i
        lines.insert(last + 1, entry_line)

    try:
        Path(note_path).write_text("\n".join(lines), encoding="utf-8")
        return True
    except OSError as e:
        print(f"  ERROR writing note: {e}")
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Insert marked timestamps into markdown notes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python process_timestamps.py --log timestamp_log.json --notes-dir ./output
  python process_timestamps.py --log timestamp_log.json --notes-dir ./notes --audio-dir ./audio
  python process_timestamps.py --log timestamp_log.json --notes-dir ./output --llm-clean
        """,
    )
    parser.add_argument("--log", default="timestamp_log.json",
                        help="Path to timestamp_log.json (default: ./timestamp_log.json)")
    parser.add_argument("--notes-dir", required=True,
                        help="Directory containing the .md note files")
    parser.add_argument("--audio-dir", default=None,
                        help="Directory containing _timing.json files (default: same as --notes-dir)")
    parser.add_argument("--llm-clean", action="store_true",
                        help="Use Groq LLM to fix speech-recognition errors in transcript text")
    args = parser.parse_args()

    log_path  = Path(args.log)
    notes_dir = Path(args.notes_dir)
    audio_dir = Path(args.audio_dir) if args.audio_dir else notes_dir

    if not log_path.exists():
        print(f"ERROR: Log file not found: {log_path}")
        return 1
    if not notes_dir.exists():
        print(f"ERROR: Notes directory not found: {notes_dir}")
        return 1

    try:
        entries = json.loads(log_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: Could not read log: {e}")
        return 1

    pending = [e for e in entries if not e.get("processed")]
    if not pending:
        print("No unprocessed timestamps — nothing to do.")
        return 0

    print(f"Processing {len(pending)} timestamp(s)...")
    if args.llm_clean:
        print("LLM cleanup enabled (Groq / llama-3.3-70b-versatile)")

    inserted = 0
    for entry in pending:
        note_title = entry.get("note_title", "").strip()
        ts         = entry.get("timestamp", "??:??")
        seconds    = int(entry.get("seconds", 0))

        if not note_title:
            print(f"  SKIP — entry has no note_title: {entry}")
            entry["processed"] = True
            continue

        note_path = notes_dir / f"{note_title}.md"
        if not note_path.exists():
            print(f"  SKIP — note not found: {note_title}.md  (looked in {notes_dir})")
            entry["processed"] = True
            continue

        print(f"  [{ts}] {note_title}")
        transcript = load_transcript(str(note_path), str(audio_dir))
        ok = insert_timestamp(str(note_path), ts, seconds, transcript, args.llm_clean)

        if ok:
            inserted += 1
        entry["processed"] = True

    log_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone. {inserted}/{len(pending)} timestamp(s) inserted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
