"""Draft voices: fast offline stand-ins so the whole film can be watched before OmniVoice has rendered every line.

    python tts/cli.py draft [--lines ids]       # SAPI render for every line that has no OmniVoice take yet

* Only lines WITHOUT an OmniVoice take are drafted; `process` always prefers the OmniVoice take.
* Drafts go through the same DSP chain (pitch/formant/grit/EQ per mood) and forced alignment; the manifest marks them
  "engine": "sapi-draft" and the app says so. Replace them with `cli.py gen` (+ `process`) on a machine that can run
  OmniVoice (GPU), or `gen --force` to redo everything.
"""
from __future__ import annotations

import json
import re
import subprocess

from common import ROOT, load_scenario, resolve_line, select_lines, short_hash, speak_text
from generate import load_index

DRAFT_DIR = ROOT / "audio" / "draft"
DRAFT_INDEX = DRAFT_DIR / "index.json"


def load_draft_index() -> dict:
    return json.loads(DRAFT_INDEX.read_text(encoding="utf-8")) if DRAFT_INDEX.exists() else {}


def sapi_text(line: dict) -> str:
    t = speak_text(line)
    t = re.sub(r"\[laughter\]", " ha ha ha ha. ", t)
    t = re.sub(r"\[[^\]]*\]", " ", t)
    t = t.replace("Aah-zee-chok", "Ah zee chock").replace("Azichok", "Ah zee chock")
    return re.sub(r"\s+", " ", t).strip()


def sapi_rate(speed: float) -> int:
    return max(-10, min(10, round((speed - 1.0) * 12)))


def draft(ids: str | None = None):
    scn = load_scenario()
    raw = load_index()
    existing = load_draft_index()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    jobs = []
    for line in select_lines(scn, ids):
        if line.get("kind") == "sfx" or line["id"] in raw:
            continue
        r = resolve_line(scn, line)
        text, rate = sapi_text(line), sapi_rate(r["tts"]["speed"])
        h = short_hash([text, rate, "sapi"])
        out = DRAFT_DIR / f"{line['id']}__{h}.wav"
        existing[line["id"]] = {"file": out.name, "hash": h, "engine": "sapi-draft"}
        if not out.exists():
            jobs.append({"id": line["id"], "text": text, "rate": rate, "out": str(out)})
    DRAFT_INDEX.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    if not jobs:
        print("[draft] nothing to do")
        return
    jf = DRAFT_DIR / "_jobs.json"
    jf.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
    print(f"[draft] rendering {len(jobs)} draft line(s) with Windows SAPI")
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "tts" / "draft_sapi.ps1"), "-JobsFile", str(jf)], check=True)
    jf.unlink(missing_ok=True)
