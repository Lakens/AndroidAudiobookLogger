#!/usr/bin/env python3
"""
convert.py  —  Convert a PDF to an audiobook

Outputs three files in --output-dir (default: ./output):
  {stem}.mp3           audio file
  {stem}_timing.json   word-boundary timing (Edge TTS only; used by process_timestamps.py)
  {stem}.md            markdown note with a ## Timestamps section ready for annotation

Usage:
  python convert.py paper.pdf
  python convert.py paper.pdf --output-dir ./audiobooks
  python convert.py paper.pdf --voice en-GB-RyanNeural
  python convert.py paper.pdf --voice en-US-AriaNeural --rate +20%
  python convert.py paper.pdf --extraction pypdf
  python convert.py paper.pdf --tts coqui

List available Edge TTS voices:
  python -m edge_tts --list-voices
"""

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

try:
    import requests
except ImportError:
    requests = None

try:
    import PyPDF2
except ImportError:
    PyPDF2 = None


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def clean_text_for_tts(text: str, max_chars: int = 5_000_000) -> str:
    """Strip markdown and scientific notation symbols unsuitable for TTS."""
    # Remove HTML tags first: <span id="page-0-0">, <sup>, </sup>, </span>, etc.
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'-\s*\n\s*', '', text)
    text = re.sub(r'\n{2,}', ' . ', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*{1,3}', '', text)
    text = re.sub(r'_{1,2}([^_]+)_{1,2}', r'\1', text)
    text = re.sub(r'\^([^\s^]+)\^?', '', text)
    text = re.sub(r'`[^`]*`', '', text)
    # Remove footnote marker links before general link processing:
    # [1](#page-0-1), [⁎](#page-0-0) → remove entirely
    text = re.sub(r'\[[\s\d⁎☆†‡§¶*⁺]+\]\(#[^)]+\)', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    text = re.sub(r'!\[[^\]]*\]\([^\)]+\)', '', text)
    # Unescape markdown backslash-escapes left in link labels: \( → (, \) → ), \[ → [, \] → ]
    text = text.replace('\\(', '(').replace('\\)', ')').replace('\\[', '[').replace('\\]', ']')
    text = re.sub(r'\[([^\]]+)\]', r'\1', text)
    text = re.sub(r'\{([^}]+)\}', r'\1', text)
    # Remove standalone footnote symbols (☆, ⁎) that TTS reads as "asterisk" etc.
    text = re.sub(r'(?<!\w)[☆⁎†‡§](?!\w)', '', text)
    text = re.sub(r'\$\$[^$]*?\$\$', '', text, flags=re.DOTALL)
    text = re.sub(r'\$[^$\n]+?\$', '', text)
    text = re.sub(r'\$', '', text)
    text = re.sub(r'\bpp\.\s*(\d)', r'pages \1', text)
    text = re.sub(r'\bp\.\s*(\d)', r'page \1', text)
    text = re.sub(r'\b([A-Z]{2,})(?:\s+[A-Z]{2,})*\b', lambda m: m.group(0).title(), text)
    text = re.sub(r'(?<!\w)[~^|\\](?!\w)', ' ', text)
    text = ' '.join(text.split())
    if len(text) > max_chars:
        print(f"WARNING: Text truncated from {len(text):,} to {max_chars:,} characters")
        text = text[:max_chars]
    return text


def chunk_text_for_tts(text: str, chunk_size: int = 50_000) -> list:
    """Split text into chunks at sentence boundaries."""
    if len(text) <= chunk_size:
        return [text]
    chunks = []
    while text:
        if len(text) <= chunk_size:
            chunks.append(text)
            break
        segment = text[:chunk_size]
        best_idx = -1
        best_sep = ' '
        for sep in ('. ', '? ', '! ', '\n'):
            idx = segment.rfind(sep)
            if idx > chunk_size // 2 and idx > best_idx:
                best_idx = idx
                best_sep = sep
        if best_idx == -1:
            best_idx = chunk_size - 1
            best_sep = ' '
        split_at = best_idx + len(best_sep)
        chunks.append(text[:split_at].strip())
        text = text[split_at:].strip()
    return chunks


# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------

class PDFExtractor:
    PUBLIC_GROBID_SERVERS = [
        "https://grobid.petal.org",
        "https://orkg.org/grobid",
        "http://localhost:8070",
    ]

    def __init__(self, grobid_server: str = None, extraction: str = "auto"):
        if grobid_server == "local":
            self.grobid_servers = ["http://localhost:8070"]
        elif grobid_server and grobid_server != "skip":
            self.grobid_servers = [grobid_server]
        else:
            self.grobid_servers = self.PUBLIC_GROBID_SERVERS
        self.extraction = extraction

    def extract_with_glm_ocr(self, pdf_path: str) -> Optional[Tuple[str, str]]:
        try:
            import ollama
            import fitz
            import base64

            models = ollama.list()
            model_names = [m.model for m in models.models]
            if not any("glm-ocr" in m for m in model_names):
                print("WARNING: glm-ocr not found in Ollama. Run: ollama pull glm-ocr")
                return None

            print("  Running GLM-OCR via Ollama (page-by-page)...")
            doc = fitz.open(pdf_path)
            page_texts = []
            for i, page in enumerate(doc):
                mat = fitz.Matrix(150 / 72, 150 / 72)
                pix = page.get_pixmap(matrix=mat)
                img_b64 = base64.b64encode(pix.tobytes("jpeg")).decode("utf-8")
                response = ollama.generate(model="glm-ocr", prompt="Text Recognition: ",
                                           images=[img_b64], stream=False)
                page_text = response["response"].strip()
                if page_text:
                    page_texts.append(page_text)
                if (i + 1) % 10 == 0 or (i + 1) == len(doc):
                    print(f"  GLM-OCR: {i + 1}/{len(doc)} pages done")
            doc.close()
            text = "\n\n".join(page_texts)
            if text.strip():
                print(f"  OK: Extracted with GLM-OCR ({len(text):,} chars)")
                return text, "GLM-OCR (Ollama)"
            return None
        except ImportError as e:
            print(f"  WARNING: GLM-OCR missing dependency: {e}")
            return None
        except Exception as e:
            print(f"  WARNING: GLM-OCR failed: {str(e)[:80]}")
            return None

    def extract_with_marker(self, pdf_path: str) -> Optional[Tuple[str, str]]:
        try:
            from marker.converters.pdf import PdfConverter
            from marker.models import create_model_dict
            from marker.output import text_from_rendered
            from marker.config.parser import ConfigParser
            import torch

            print("  Running marker (local ML extraction)...")
            device = "cuda" if torch.cuda.is_available() else "cpu"
            config = ConfigParser({"output_format": "markdown", "device": device})
            models = create_model_dict(device=device)
            converter = PdfConverter(config=config.generate_config_dict(), artifact_dict=models)
            rendered = converter(pdf_path)
            text, _, _ = text_from_rendered(rendered)
            if text and text.strip():
                print(f"  OK: Extracted with marker ({len(text):,} chars)")
                return text, "marker"
            return None
        except ImportError:
            print("  WARNING: marker not installed. Run: pip install marker-pdf")
            return None
        except Exception as e:
            print(f"  WARNING: marker failed: {str(e)[:80]}")
            return None

    def extract_with_grobid(self, pdf_path: str) -> Optional[Tuple[str, str]]:
        if not requests:
            return None
        pdf_size_mb = Path(pdf_path).stat().st_size / 1024 / 1024
        timeout = min(max(60, int(pdf_size_mb * 10)), 300)
        for server in self.grobid_servers:
            print(f"  Trying Grobid: {server} (timeout {timeout}s)...")
            try:
                with open(pdf_path, 'rb') as f:
                    response = requests.post(
                        f"{server}/api/processFulltextDocument",
                        files={'input': f}, timeout=timeout)
                if response.status_code == 200:
                    text, structure = self._parse_grobid_xml(response.text)
                    if text:
                        method = f"Grobid ({server.split('/')[-1]}) - {structure}"
                        print(f"  OK: Extracted with {method}")
                        return text, method
                    print(f"  WARNING: Grobid returned empty text from {server}")
                else:
                    print(f"  WARNING: Grobid HTTP {response.status_code} from {server}")
            except requests.exceptions.Timeout:
                print(f"  TIMEOUT: Grobid timed out at {server}")
            except requests.exceptions.ConnectionError:
                print(f"  WARNING: Grobid unavailable at {server}")
            except Exception as e:
                print(f"  WARNING: Grobid error at {server}: {str(e)[:50]}")
        return None

    def _parse_grobid_xml(self, xml_text: str) -> Tuple[str, str]:
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(xml_text)
            ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
            parts = []
            sections = []
            abstract = root.find('.//tei:abstract', ns)
            if abstract is not None:
                abs_text = self._elem_text(abstract)
                if abs_text.strip():
                    parts.append("## Abstract\n\n" + abs_text)
                    sections.append("abstract")
            body = root.find('.//tei:body', ns)
            if body is not None:
                body_text = self._body_text(body, ns)
                if body_text.strip():
                    parts.append(body_text)
                    sections.append("body")
            if not parts:
                fallback = ' '.join(
                    e.text.strip() for e in root.iter()
                    if e.text and e.text.strip()
                )
                return fallback, "fallback"
            return '\n\n'.join(parts), ', '.join(sections)
        except Exception as e:
            print(f"  WARNING: Grobid XML parse failed: {e}")
            return None, "error"

    def _elem_text(self, elem) -> str:
        parts = []
        if elem.text and elem.text.strip():
            parts.append(elem.text.strip())
        for child in elem.iter():
            if child != elem:
                if child.text and child.text.strip():
                    parts.append(child.text.strip())
                if child.tail and child.tail.strip():
                    parts.append(child.tail.strip())
        return ' '.join(parts)

    def _body_text(self, body_elem, ns) -> str:
        parts = []
        for div in body_elem.findall('.//tei:div', ns):
            head = div.find('tei:head', ns)
            if head is not None:
                title = self._elem_text(head).strip()
                if title:
                    parts.append(f"## {title}\n")
            for para in div.findall('.//tei:p', ns):
                para_text = self._elem_text(para).strip()
                if para_text:
                    parts.append(para_text)
        if not parts:
            for para in body_elem.findall('.//tei:p', ns):
                para_text = self._elem_text(para).strip()
                if para_text:
                    parts.append(para_text)
        return '\n\n'.join(parts)

    def extract_with_pypdf(self, pdf_path: str) -> Optional[Tuple[str, str]]:
        if not PyPDF2:
            print("  WARNING: PyPDF2 not installed. Run: pip install PyPDF2")
            return None
        try:
            with open(pdf_path, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                text = ''.join(page.extract_text() + '\n' for page in reader.pages)
            if text.strip():
                return text, "PyPDF2"
            return None
        except Exception as e:
            print(f"  WARNING: PyPDF2 failed: {e}")
            return None

    def extract_text(self, pdf_path: str) -> Tuple[str, str]:
        """Extract text from PDF. Returns (text, method_used)."""
        print(f"Extracting text from: {Path(pdf_path).name}")
        if self.extraction == "glm-ocr":
            methods = [self.extract_with_glm_ocr]
        elif self.extraction == "marker":
            methods = [self.extract_with_marker]
        elif self.extraction == "grobid":
            methods = [self.extract_with_grobid]
        elif self.extraction == "pypdf":
            methods = [self.extract_with_pypdf]
        else:
            # auto: try fast local methods first, fall back to network/OCR
            methods = [self.extract_with_pypdf, self.extract_with_grobid,
                       self.extract_with_marker, self.extract_with_glm_ocr]

        for method_fn in methods:
            result = method_fn(pdf_path)
            if result:
                return result

        raise ValueError(
            f"Could not extract text from {pdf_path}.\n"
            "Try --extraction marker or --extraction glm-ocr for scanned PDFs."
        )


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

def synthesize_edge_tts(text: str, output_path: str,
                        voice: str = "en-US-AriaNeural",
                        rate: str = "+0%",
                        timing_path: str = None) -> bool:
    try:
        from edge_tts import Communicate
    except ImportError:
        print("FAILED: edge-tts not installed. Run: pip install edge-tts")
        return False

    chunks = chunk_text_for_tts(text)
    print(f"Generating audio with Edge TTS...")
    print(f"  Voice : {voice}  Rate: {rate}")
    print(f"  Text  : {len(text):,} characters in {len(chunks)} chunk(s)")

    all_boundaries = []
    chunk_paths = []
    time_offset = 0.0
    tmp_dir = tempfile.mkdtemp()

    async def _tts_chunk(chunk_text, chunk_path):
        boundaries = []
        communicate = Communicate(text=chunk_text, voice=voice, rate=rate)
        with open(chunk_path, "wb") as f:
            async for item in communicate.stream():
                if item["type"] == "audio":
                    f.write(item["data"])
                elif item["type"] in ("WordBoundary", "SentenceBoundary"):
                    boundaries.append({
                        "word":      item["text"],
                        "start_sec": item["offset"] / 10_000_000,
                    })
        return boundaries

    try:
        for i, chunk in enumerate(chunks):
            if len(chunks) > 1:
                print(f"  Chunk {i + 1}/{len(chunks)} ({len(chunk):,} chars)...")
            chunk_path = os.path.join(tmp_dir, f"chunk_{i:04d}.mp3")
            for attempt in range(3):
                try:
                    boundaries = asyncio.run(_tts_chunk(chunk, chunk_path))
                    break
                except Exception as exc:
                    if attempt < 2 and "NoAudioReceived" in type(exc).__name__:
                        wait = (attempt + 1) * 5
                        print(f"  WARNING: No audio (attempt {attempt+1}/3), retrying in {wait}s...")
                        time.sleep(wait)
                    else:
                        raise
            for b in boundaries:
                all_boundaries.append({
                    "word":      b["word"],
                    "start_sec": b["start_sec"] + time_offset,
                })
            chunk_paths.append(chunk_path)
            if boundaries:
                time_offset = all_boundaries[-1]["start_sec"] + 0.5
            if i < len(chunks) - 1:
                time.sleep(2)

        output_file = Path(output_path)
        with open(output_file, "wb") as out_f:
            for cp in chunk_paths:
                p = Path(cp)
                if p.exists():
                    out_f.write(p.read_bytes())
                    p.unlink()
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

        if not output_file.exists() or output_file.stat().st_size == 0:
            print("FAILED: Audio file was not created")
            return False

        size_mb = output_file.stat().st_size / 1024 / 1024
        print(f"OK: Audio saved → {output_file.name}  ({size_mb:.1f} MB)")

        if timing_path and all_boundaries:
            Path(timing_path).write_text(
                json.dumps(all_boundaries, indent=2), encoding="utf-8"
            )
            print(f"OK: Timing saved → {Path(timing_path).name}  ({len(all_boundaries):,} words)")

        return True

    except Exception as e:
        print(f"FAILED: Edge TTS error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return False


def synthesize_coqui(text: str, output_path: str) -> bool:
    try:
        from TTS.api import TTS
        print("Generating audio with Coqui TTS...")
        tts = TTS(model_name="tts_models/en/ljspeech/glow-tts", progress_bar=True, gpu=False)
        tts.tts_to_file(text=text, file_path=output_path)
        p = Path(output_path)
        if p.exists():
            print(f"OK: Audio saved → {p.name}  ({p.stat().st_size/1024/1024:.1f} MB)")
            return True
        print("FAILED: Audio file was not created")
        return False
    except ImportError:
        print("FAILED: Coqui TTS not installed. Run: pip install TTS")
        return False
    except Exception as e:
        print(f"FAILED: Coqui TTS error: {type(e).__name__}: {e}")
        return False


# ---------------------------------------------------------------------------
# Note generator (plain markdown — no Obsidian DataviewJS)
# ---------------------------------------------------------------------------

def create_note(stem: str, pdf_name: str, audio_filename: str, timing_filename: str,
                extracted_text: str, extraction_method: str, tts_method: str,
                output_dir: Path) -> Path:
    today = datetime.now().strftime("%Y-%m-%d")
    word_count = len(extracted_text.split())
    note_path = output_dir / f"{stem}.md"
    title_yaml = stem.replace('"', "'")

    content = f"""---
title: "{title_yaml}"
source_pdf: "{pdf_name}"
audio_file: "{audio_filename}"
timing_file: "{timing_filename}"
extraction_method: "{extraction_method}"
tts_method: "{tts_method}"
word_count: {word_count}
character_count: {len(extracted_text)}
date_added: {today}
---

# {stem}

| | |
|---|---|
| **Source** | {pdf_name} |
| **Words** | {word_count:,} |
| **Extracted via** | {extraction_method} |
| **Audio via** | {tts_method} |
| **Date** | {today} |

---

## Notes

<!-- Add your notes here as you listen -->

---

## Key Points

-

---

## Timestamps

---

## Full Text

{extracted_text}
"""
    note_path.write_text(content, encoding="utf-8")
    print(f"OK: Note saved  → {note_path.name}")
    return note_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Convert a PDF to an audiobook (MP3 + timing + markdown note)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python convert.py paper.pdf
  python convert.py paper.pdf --output-dir ./audiobooks
  python convert.py paper.pdf --voice en-GB-RyanNeural --rate +10%
  python convert.py paper.pdf --extraction pypdf
  python convert.py paper.pdf --tts coqui

list available Edge TTS voices:
  python -m edge_tts --list-voices
        """,
    )
    parser.add_argument("pdf", help="Path to the PDF file to convert")
    parser.add_argument("--output-dir", default="./output",
                        help="Directory for output files (default: ./output)")
    parser.add_argument("--voice", default="en-US-AriaNeural",
                        help="Edge TTS voice name (default: en-US-AriaNeural)")
    parser.add_argument("--rate", default="+0%",
                        help="Speaking rate adjustment, e.g. +20%% or -10%% (default: +0%%)")
    parser.add_argument("--tts", choices=["edge-tts", "coqui"], default="edge-tts",
                        help="TTS engine (default: edge-tts)")
    parser.add_argument("--extraction",
                        choices=["auto", "pypdf", "grobid", "marker", "glm-ocr"],
                        default="auto",
                        help="Extraction method. auto tries pypdf→grobid→marker→glm-ocr")
    parser.add_argument("--grobid", default=None,
                        help="Custom Grobid server URL, or 'local' for localhost:8070")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f"ERROR: PDF not found: {pdf_path}")
        return 1

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    stem = pdf_path.stem

    # 1. Extract
    print(f"\n[1/3] Extracting text...")
    extractor = PDFExtractor(grobid_server=args.grobid, extraction=args.extraction)
    try:
        extracted_text, extraction_method = extractor.extract_text(str(pdf_path))
    except Exception as e:
        print(f"ERROR: {e}")
        return 1
    print(f"      {len(extracted_text):,} characters extracted via {extraction_method}")

    # 2. Clean + synthesize
    print(f"\n[2/3] Converting to speech...")
    tts_text = clean_text_for_tts(extracted_text)
    print(f"      {len(tts_text):,} characters after cleaning")

    audio_filename  = f"{stem}.mp3"
    timing_filename = f"{stem}_timing.json"
    audio_path  = output_dir / audio_filename
    timing_path = output_dir / timing_filename

    if args.tts == "edge-tts":
        ok = synthesize_edge_tts(
            tts_text, str(audio_path),
            voice=args.voice, rate=args.rate,
            timing_path=str(timing_path),
        )
    else:
        ok = synthesize_coqui(tts_text, str(audio_path))

    if not ok:
        return 1

    # 3. Create note
    print(f"\n[3/3] Creating note...")
    create_note(
        stem=stem,
        pdf_name=pdf_path.name,
        audio_filename=audio_filename,
        timing_filename=timing_filename if args.tts == "edge-tts" else "",
        extracted_text=extracted_text,
        extraction_method=extraction_method,
        tts_method=args.tts,
        output_dir=output_dir,
    )

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.0f}s  →  {output_dir}/")
    print(f"  {audio_filename}")
    if args.tts == "edge-tts":
        print(f"  {timing_filename}")
    print(f"  {stem}.md")
    print(f"\nCopy {audio_filename} to your phone's audio folder,")
    print(f"then open the AudiobookNotetaker app to listen and mark timestamps.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
