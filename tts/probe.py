"""Voice-A casting probe: compares voice-DESIGN variants objectively (nobody listens while building).

    python tts/cli.py probe

For every (instruct, seed) candidate it does exactly what the pipeline does: design an anchor take, turn it into a
clone prompt, then render two test lines from that prompt (one playful, one cold). For each take it prints F0 median,
F0 spread (semitone std / 5-95 % range: higher = less monotone) and a Whisper round trip, and writes
audio/probe/*.wav + build/probe.json. Pick the candidate with good ASR and the widest natural pitch movement, then put
its instruct/seed into voices/voices.json.
"""
from __future__ import annotations

import json
import time

import soundfile as sf
import torch

from common import ROOT, SR, load_voices
from generate import ANCHOR_TEXT, Engine
from qa import measure

CANDIDATES = [
    ("male, middle-aged, very low pitch, british accent", [1701, 4242]),
    ("male, middle-aged, low pitch, british accent", [1701, 4242]),
    ("male, low pitch, british accent", [1701, 4242]),
]
TESTS = [
    ("playful", "Long time no hear, Ey-Zee! I do hope you haven't missed me... too terribly?", 1.0, 0.35),
    ("cold", "So where is that lad who could find common ground with anyone... and understand everyone? Hm? Is he gone already? Shame.", 0.9, 0.0),
]


def probe(asr_model: str = "openai/whisper-large-v3-turbo"):
    voices = load_voices()
    eng = Engine(voices)
    eng.load()
    out = ROOT / "audio" / "probe"
    out.mkdir(parents=True, exist_ok=True)
    from omnivoice import VoiceClonePrompt  # noqa: F401  (import check before the long loop)
    results = {}
    for instruct, seeds in CANDIDATES:
        for seed in seeds:
            tag = f"{instruct.replace(', ', '_').replace(' ', '-')}__{seed}"
            torch.manual_seed(seed)
            t0 = time.time()
            anchor = eng.model.generate(text=ANCHOR_TEXT, instruct=instruct, language="en", num_step=voices["numStep"])[0]
            sf.write(str(out / f"{tag}__anchor.wav"), anchor, SR, subtype="PCM_16")
            prompt = eng.model.create_voice_clone_prompt(ref_audio=str(out / f"{tag}__anchor.wav"), ref_text=ANCHOR_TEXT)
            row = {"anchor": measure(anchor, ANCHOR_TEXT, asr_model)}
            for name, text, speed, temp in TESTS:
                torch.manual_seed(seed + 1)
                y = eng.model.generate(text=text, language="en", voice_clone_prompt=prompt, speed=speed,
                                       num_step=voices["numStep"], class_temperature=temp)[0]
                sf.write(str(out / f"{tag}__{name}.wav"), y, SR, subtype="PCM_16")
                row[name] = measure(y, text, asr_model)
            results[tag] = row
            print(f"[probe] {instruct} seed={seed} ({time.time() - t0:.0f}s)", flush=True)
            for k, m in row.items():
                print(f"    {k:8s} f0={m['f0']:6.1f}Hz sd={m['stSd']:4.2f}st range={m['stRange']:5.2f}st "
                      f"wer={m['wer']:.2f} {m['seconds']:4.1f}s | {m['asr']}", flush=True)
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "probe.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    return results
