"""Decode the reference recording to a mono 24 kHz WAV, find the cleanest speech
window (3-12 s) and transcribe it with Whisper so OmniVoice gets a matching ref_text.

Usage: python tts/prepare_ref.py [--asr openai/whisper-small]
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent
VOICES = ROOT / "voices" / "voices.json"


def load_mono(path: Path, sr: int):
    data, rate = sf.read(str(path), always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    if rate != sr:
        g = np.gcd(rate, sr)
        mono = resample_poly(mono, sr // g, rate // g).astype(np.float32)
    return mono


def best_window(x: np.ndarray, sr: int, lo=4.0, hi=12.0):
    """Pick a window that starts/ends in silence gaps and has the highest speech ratio."""
    frame = int(0.03 * sr)
    n = len(x) // frame
    rms = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    thr = max(np.percentile(rms, 30) * 1.8, 0.004)
    voiced = rms > thr
    # candidate boundaries = silence frames
    sil = np.where(~voiced)[0]
    best, best_score = (0, min(len(x), int(hi * sr))), -1
    for i in sil:
        for j in sil[sil > i]:
            d = (j - i) * frame / sr
            if d < lo:
                continue
            if d > hi:
                break
            score = voiced[i:j].mean() * min(d, 9.0)
            if score > best_score:
                best_score, best = score, (i * frame, j * frame)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asr", default="openai/whisper-small")
    ap.add_argument("--language", default=None, help="force whisper language, e.g. uk")
    args = ap.parse_args()

    cfg = json.loads(VOICES.read_text(encoding="utf-8"))
    for key, ref in cfg["refs"].items():
        src = ROOT / ref["file"]
        x = load_mono(src, 24000)
        print(f"[{key}] {src.name}: {len(x)/24000:.1f}s, peak {np.abs(x).max():.3f}")
        a, b = best_window(x, 24000) if len(x) / 24000 > 12.5 else (0, len(x))
        clip = x[a:b]
        peak = np.abs(clip).max()
        if peak > 0:
            clip = clip * (0.89 / peak)
        out = ROOT / "voices" / "refs" / f"{key}_clip.wav"
        sf.write(str(out), clip, 24000, subtype="PCM_16")
        print(f"  clip {a/24000:.2f}-{b/24000:.2f}s -> {out.name}")

        from transformers import pipeline
        asr = pipeline("automatic-speech-recognition", model=args.asr, device="cpu")
        kw = {"generate_kwargs": {"language": args.language, "task": "transcribe"}} if args.language else {}
        text = asr({"array": clip, "sampling_rate": 24000}, **kw)["text"].strip()
        print(f"  transcript: {text}")
        ref["clip"] = f"voices/refs/{key}_clip.wav"
        ref["text"] = text
        ref["clipSeconds"] = round(len(clip) / 24000, 2)
    VOICES.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
