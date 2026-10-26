"""Voice-A casting probe: renders the same sentence with different identity strategies and
prints pitch statistics + an ASR round-trip so variants can be compared objectively."""
from __future__ import annotations

import time

import numpy as np
import soundfile as sf
import torch

import dsp
from common import ROOT, SR, load_voices
from generate import Engine

TEXT = "Long time no hear, Aah-zee-chok! I do hope you haven't missed me... too terribly?"


def probe():
    voices = load_voices()
    eng = Engine(voices)
    out = ROOT / "audio" / "probe"
    out.mkdir(parents=True, exist_ok=True)
    prompt = eng.profile_prompt("B")
    variants = {
        "clone": dict(voice_clone_prompt=prompt),
        "clone_instruct": dict(voice_clone_prompt=prompt, instruct="male, low pitch, british accent"),
        "design": dict(instruct="male, middle-aged, very low pitch, british accent"),
    }
    eng.load()
    results = {}
    for name, kw in variants.items():
        torch.manual_seed(1701)
        t0 = time.time()
        audio = eng.model.generate(text=TEXT, language="en", num_step=voices["numStep"], speed=1.0,
                                   class_temperature=0.35, **kw)[0]
        dt = time.time() - t0
        sf.write(str(out / f"{name}.wav"), audio, SR, subtype="PCM_16")
        f0 = dsp.median_f0(audio)
        shaped = dsp.perform(audio, SR, {"pitchMedian": 112, "pitchRange": 1.35, "formant": 0.87, "grit": 0.28,
                                         "lowShelfDb": 3.5, "presenceDb": 2.0, "compress": 0.5})
        sf.write(str(out / f"{name}__caller.wav"), dsp.normalize(shaped, SR), SR, subtype="PCM_16")
        results[name] = (f0, len(audio) / SR, dt)
        print(f"[probe] {name:15s} f0={f0:6.1f}Hz  {len(audio)/SR:4.1f}s audio, {dt:5.1f}s wall (RTF {dt/(len(audio)/SR):.2f})", flush=True)

    # ASR round trip (intelligibility proxy)
    from transformers import pipeline
    asr = pipeline("automatic-speech-recognition", model="openai/whisper-small.en", device="cpu")
    for name in variants:
        a, _ = sf.read(str(out / f"{name}__caller.wav"), dtype="float32")
        txt = asr({"array": a, "sampling_rate": SR})["text"].strip()
        print(f"[probe] ASR {name:15s}: {txt}", flush=True)
