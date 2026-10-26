"""Shared helpers for the voice pipeline: paths, scenario loading, per-line parameter resolution."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENARIO = ROOT / "scenario" / "scenario.json"
VOICES = ROOT / "voices" / "voices.json"
RAW_DIR = ROOT / "audio" / "raw"          # cached OmniVoice output (never touched by DSP)
PROMPT_DIR = ROOT / "audio" / "prompts"   # cached voice-clone prompts
SFX_DIR = ROOT / "assets" / "sfx"
OUT_DIR = ROOT / "public" / "audio"       # processed assets served to the browser
LINES_DIR = OUT_DIR / "lines"
MANIFEST = OUT_DIR / "manifest.json"
SR = 24000


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_scenario() -> dict:
    return load_json(SCENARIO)


def load_voices() -> dict:
    return load_json(VOICES)


def speak_text(line: dict) -> str:
    return line.get("speak") or line["en"]


def resolve_line(scn: dict, line: dict) -> dict:
    """Merge mood defaults with per-line overrides -> concrete TTS + DSP parameters."""
    mood = scn["moods"][line["mood"]]
    tts = {
        "speed": mood["speed"],
        "classTemperature": mood["classTemperature"],
        "guidanceScale": 2.0,
        "positionTemperature": 5.0,
        "instruct": None,
        "seedOffset": 0,
    }
    tts.update(line.get("tts", {}))
    dsp = dict(scn["dspPresets"][mood["dsp"]])
    dsp.update(line.get("dsp", {}))
    return {"tts": tts, "dsp": dsp, "dspName": mood["dsp"]}


def short_hash(obj) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:10]


def select_lines(scn: dict, ids: str | None):
    lines = scn["lines"]
    if not ids:
        return lines
    wanted = {s.strip() for s in ids.split(",") if s.strip()}
    unknown = wanted - {l["id"] for l in lines}
    if unknown:
        raise SystemExit(f"unknown line ids: {sorted(unknown)}")
    return [l for l in lines if l["id"] in wanted]
