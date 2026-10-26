"""Objective QA for generated takes (nobody listens while building, so we measure).

    python tts/cli.py qa [--lines l001,l026] [--asr openai/whisper-large-v3-turbo]

For every raw OmniVoice take in the cache it prints and writes build/qa.json:
  * Whisper ASR round trip and word error rate against the `speak` text (tags removed)
  * F0 median, F0 spread (semitone std, 5-95 % range) = how monotone the read is
  * duration, speech rate (words / s) and clipping
and flags takes worth re-rolling (`gen --lines <id> --force --take N`).
"""
from __future__ import annotations

import json
import re

import numpy as np
import soundfile as sf

from common import RAW_DIR, ROOT, SR, load_scenario, select_lines, speak_text

QA_FILE = ROOT / "build" / "qa.json"
_asr = {}

# Whisper writes what it hears; these spellings all count as the caller's "AZ" ("ay-zee").
AZ_FORMS = {"az", "ey zee", "eyzee", "a z", "ayzee", "ay zee", "azee", "a zee", "aizee", "a-z", "ayz", "ae zee", "eh zee", "azi", "aze"}


def f0_track(x: np.ndarray, sr: int = SR, floor=55, ceil=400) -> np.ndarray:
    import parselmouth
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
    f = snd.to_pitch_ac(time_step=0.01, pitch_floor=floor, pitch_ceiling=ceil).selected_array["frequency"]
    return f[f > 0]


def pitch_stats(x: np.ndarray, sr: int = SR) -> dict:
    f = f0_track(x, sr)
    if len(f) < 10:
        return {"f0": 0.0, "stSd": 0.0, "stRange": 0.0, "voiced": 0.0}
    st = 12 * np.log2(f / np.median(f))
    lo, hi = np.percentile(st, [5, 95])
    return {"f0": round(float(np.median(f)), 1), "stSd": round(float(np.std(st)), 2),
            "stRange": round(float(hi - lo), 2), "voiced": round(len(f) * 0.01 / (len(x) / sr), 2)}


def asr(audio: np.ndarray, sr: int = SR, model: str = "openai/whisper-large-v3-turbo") -> str:
    if model not in _asr:
        from transformers import pipeline
        _asr[model] = pipeline("automatic-speech-recognition", model=model, device="cpu")
    if sr != 16000:
        from scipy.signal import resample_poly
        audio = resample_poly(audio, 2, 3).astype(np.float32) if sr == 24000 else audio
    out = _asr[model]({"array": audio.astype(np.float32), "sampling_rate": 16000},
                      generate_kwargs={"language": "en", "task": "transcribe"})
    return out["text"].strip()


def norm_words(text: str) -> list[str]:
    t = re.sub(r"\[[^\]]*\]", " ", text.lower())
    t = t.replace("’", "'").replace("-", " ")
    t = re.sub(r"\b(ha ?)+\b", " ", t)        # laughter is not checked word by word
    t = re.sub(r"[^a-z' ]", " ", t)
    t = re.sub(r"\b[ae]y zee\b|\ba z\b|\b[ae]yzee\b|\baz\b", " az ", t)
    return [w.strip("'") for w in t.split() if w.strip("'")]


def wer(ref: str, hyp: str) -> float:
    r, h = norm_words(ref), norm_words(hyp)
    if not r:
        return 0.0
    d = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        prev, d[0] = d.copy(), i
        for j in range(1, len(h) + 1):
            d[j] = min(prev[j] + 1, d[j - 1] + 1, prev[j - 1] + (r[i - 1] != h[j - 1]))
    return round(float(d[len(h)]) / len(r), 3)


def says_az(hyp: str) -> bool:
    t = re.sub(r"[^a-z ]", " ", hyp.lower().replace("-", " ").replace(".", ""))
    t = " " + re.sub(r"\s+", " ", t) + " "
    return any(f" {f} " in t for f in AZ_FORMS)


def measure(x: np.ndarray, text: str, asr_model: str) -> dict:
    hyp = asr(x, SR, asr_model)
    n_words = max(1, len(norm_words(text)))
    dur = len(x) / SR
    return {"asr": hyp, "wer": wer(text, hyp), "seconds": round(dur, 2), "wps": round(n_words / max(dur, 1e-3), 2),
            "clip": round(float(np.mean(np.abs(x) > 0.99)), 4), **pitch_stats(x)}


def flags(line: dict, m: dict) -> list[str]:
    out = []
    laugh = "[laughter]" in speak_text(line) or re.search(r"\bha\b", line["en"].lower())
    if m["wer"] > (0.6 if laugh else 0.25):
        out.append(f"asr-mismatch({m['wer']})")
    if m["clip"] > 0.001:
        out.append("clipped")
    if not laugh and (m["wps"] > 4.6 or m["wps"] < 1.0):
        out.append(f"odd-rate({m['wps']} w/s)")
    if re.search(r"\bAZ\b", line["en"]) and not says_az(m["asr"]):
        out.append("no-ay-zee?")
    return out


def qa(ids: str | None = None, asr_model: str = "openai/whisper-large-v3-turbo"):
    from generate import load_index
    scn, idx = load_scenario(), load_index()
    report = json.loads(QA_FILE.read_text(encoding="utf-8")) if QA_FILE.exists() else {}
    for line in select_lines(scn, ids):
        if line.get("kind") == "sfx" or line["id"] not in idx:
            continue
        ent = idx[line["id"]]
        x, _ = sf.read(str(RAW_DIR / ent["file"]), dtype="float32")
        m = measure(x, speak_text(line), asr_model)
        m.update({"file": ent["file"], "numStep": ent.get("numStep"), "flags": flags(line, m)})
        report[line["id"]] = m
        print(f"[qa] {line['id']} {line['speaker']} {m['seconds']:5.2f}s wer={m['wer']:.2f} f0={m['f0']:5.1f} "
              f"sd={m['stSd']:.1f}st {m['wps']:.1f}w/s {' '.join(m['flags']) or 'ok'} | {m['asr']}", flush=True)
    QA_FILE.parent.mkdir(parents=True, exist_ok=True)
    QA_FILE.write_text(json.dumps(dict(sorted(report.items())), indent=1, ensure_ascii=False), encoding="utf-8")
    bad = [k for k, v in report.items() if v["flags"]]
    print(f"[qa] {len(report)} takes, flagged: {bad or 'none'}")
    return report
