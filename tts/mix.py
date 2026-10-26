"""Montage: render the voice-only master track from build/timeline.json (run `bun run timeline` first).

The browser builds the real mix live (atmosphere, phone EQ, dynamics); this offline render is the QA / montage
artefact: every line placed at its timeline position, ghost layers panned and delayed, with a loudness report.
Output: build/voice_track.wav (stereo, 24 kHz)
"""
from __future__ import annotations

import json

import numpy as np
import soundfile as sf

from common import ROOT, SR


def mix():
    tl = json.loads((ROOT / "build" / "timeline.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "public" / "audio" / "manifest.json").read_text(encoding="utf-8"))
    total = int((tl["callSeconds"] + 1) * SR)
    out = np.zeros((total, 2), dtype=np.float32)
    for row in tl["rows"]:
        entry = manifest["lines"][row["id"]]
        x, sr = sf.read(str(ROOT / "public" / entry["file"]), dtype="float32")
        assert sr == SR
        a = int(row["start"] * SR)
        out[a:a + len(x), :] += x[:, None] * 0.7071
        for lay in entry["layers"]:
            z, _ = sf.read(str(ROOT / "public" / lay["file"]), dtype="float32")
            pan = lay["pan"]
            gl, gr = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            b = a + int(lay["delay"] * SR)
            out[b:b + len(z), 0] += z * gl
            out[b:b + len(z), 1] += z * gr
    peak = float(np.abs(out).max())
    if peak > 0.98:
        out *= 0.98 / peak
    dst = ROOT / "build" / "voice_track.wav"
    sf.write(str(dst), out, SR, subtype="PCM_16")
    rms = 20 * np.log10(np.sqrt((out ** 2).mean()) + 1e-9)
    print(f"[mix] {dst} {total / SR:.1f}s, peak {20 * np.log10(peak + 1e-9):.1f} dBFS, rms {rms:.1f} dBFS")
