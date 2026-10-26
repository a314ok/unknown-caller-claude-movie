"""DSP stage: raw OmniVoice takes -> performed, trimmed, level-matched assets + manifest.json.

    python tts/cli.py process [--lines l005] [--no-align]

Output (served by Vite from public/audio):
  lines/<id>.wav            the performed line
  lines/<id>_L<n>.wav       extra layers for multi-voice moments (delay/pan/gain live in the manifest)
  manifest.json             real durations, speech offsets, forced-aligned word timings
"""
from __future__ import annotations

import json
import time

import numpy as np
import soundfile as sf

import dsp
from common import (LINES_DIR, MANIFEST, OUT_DIR, RAW_DIR, SFX_DIR, SR, load_scenario, load_voices,
                    resolve_line, select_lines, short_hash, speak_text)
from draft import DRAFT_DIR, load_draft_index
from generate import load_index


def read_raw(name: str, folder=None) -> np.ndarray:
    x, sr = sf.read(str((folder or RAW_DIR) / name), dtype="float32")
    assert sr == SR, f"{name}: expected {SR} Hz, got {sr}"
    return x if x.ndim == 1 else x.mean(axis=1)


def db(v: float) -> float:
    return 10 ** (v / 20)


def process_line(scn, voices, line, raw_name, draft=False):
    r = resolve_line(scn, line)
    dspp = r["dsp"]
    x = read_raw(raw_name, DRAFT_DIR if draft else None)
    if draft:
        # the SAPI stand-in voice is female: first convert it to the speaker's base register
        base = voices["profiles"][line["speaker"]].get("draftBase")
        if base:
            x = dsp.change_gender(x, SR, base["formant"], base["pitchMedian"], base.get("pitchRange", 1.0))
    seed = int("".join(ch for ch in line["id"] if ch.isdigit()) or 1)
    y = dsp.perform(x, SR, dspp, seed)
    y, a, tail = dsp.trim(y, SR)
    ref_db = dsp.voiced_rms_db(y, SR)
    gain = 10 ** ((-21.0 + dspp.get("gainDb", 0.0) - ref_db) / 20)
    y = (np.tanh(y * gain * 0.9 / 0.93) * 0.93).astype(np.float32)
    layers = []
    for n, lay in enumerate(line.get("layers", []), 1):
        lp = dict(dspp)
        lp.update({"pitchMedian": lay["pitchMedian"], "formant": lay["formant"],
                   "pitchRange": lay.get("pitchRange", dspp["pitchRange"]), "grit": dspp["grit"] * 0.8})
        z = dsp.perform(x, SR, lp, seed + n)
        z = z[a:len(z) - tail] if tail else z[a:]
        z = z[: len(y)] if len(z) >= len(y) else np.pad(z, (0, len(y) - len(z)))
        z = z * gain * db(lay.get("gainDb", 0.0))
        z = (np.tanh(z * 0.9) / 0.9 * 0.93).astype(np.float32)
        name = f"{line['id']}_L{n}.wav"
        sf.write(str(LINES_DIR / name), z, SR, subtype="PCM_16")
        layers.append({"file": f"audio/lines/{name}", "delay": lay["delay"], "pan": lay["pan"], "gainDb": 0.0})
    return y, layers


def process_sfx(line):
    src = SFX_DIR / f"{line['sfx']}.wav"
    if not src.exists():
        raise SystemExit(f"missing sound effect asset {src} (see assets/sfx/README.md)")
    x, sr = sf.read(str(src), dtype="float32")
    x = x if x.ndim == 1 else x.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    x, _, _ = dsp.trim(x, SR, lead_ms=30, tail_ms=200)
    x = dsp.normalize(x, SR, target_db=-17.0, gain_db=0.0)
    return x


def process(ids: str | None = None, align: bool = True):
    import align as aligner
    scn, voices = load_scenario(), load_voices()
    idx = load_index()
    LINES_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"sampleRate": SR, "lines": {}}
    selected = select_lines(scn, ids)
    for line in selected:
        t0 = time.time()
        lid = line["id"]
        engine = "sfx" if line.get("kind") == "sfx" else None
        if line.get("kind") == "sfx":
            y, layers = process_sfx(line), []
            sig = short_hash(["sfx", line["sfx"], (SFX_DIR / f"{line['sfx']}.wav").stat().st_mtime_ns])
        else:
            didx = load_draft_index()
            if lid in idx:
                src, engine, is_draft = idx[lid], "omnivoice", False
            elif lid in didx:
                src, engine, is_draft = didx[lid], "sapi-draft", True
            else:
                print(f"[process] {lid}: no take yet, skipping (run `gen`, or `draft` for a stand-in)")
                continue
            base = voices["profiles"][line["speaker"]].get("draftBase") if is_draft else None
            sig = short_hash([src["hash"], engine, base, resolve_line(scn, line)["dsp"], line.get("layers", []), 3])
            old = manifest["lines"].get(lid)
            if old and old.get("sig") == sig and (LINES_DIR / f"{lid}.wav").exists() and (old.get("words") or not align):
                continue
            y, layers = process_line(scn, voices, line, src["file"], is_draft)
        sf.write(str(LINES_DIR / f"{lid}.wav"), y, SR, subtype="PCM_16")
        words, method = ([], "n/a")
        if align and line.get("kind") != "sfx":
            words, method = aligner.align(speak_text(line), y, SR)
        manifest["lines"][lid] = {
            "file": f"audio/lines/{lid}.wav",
            "duration": round(len(y) / SR, 4),
            "layers": layers,
            "words": [{"w": w["w"], "t0": round(w["t0"], 3), "t1": round(w["t1"], 3)} for w in words],
            "alignment": method,
            "engine": engine,
            "sig": sig,
        }
        print(f"[process] {lid} {len(y) / SR:5.2f}s align={method} ({time.time() - t0:.1f}s)", flush=True)
    # drop manifest entries for ids no longer in the scenario
    valid = {l["id"] for l in scn["lines"]}
    manifest["lines"] = {k: v for k, v in manifest["lines"].items() if k in valid}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    missing = [l["id"] for l in scn["lines"] if l["id"] not in manifest["lines"]]
    print(f"[process] manifest: {len(manifest['lines'])}/{len(scn['lines'])} lines" + (f", missing {missing}" if missing else ""))
    return manifest
