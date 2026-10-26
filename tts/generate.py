"""OmniVoice generation stage: scenario lines -> cached raw WAV takes.

    python tts/cli.py gen                    # every line missing from the cache
    python tts/cli.py gen --lines l005,l026  # only these lines
    python tts/cli.py gen --lines l005 --force --take 2   # re-roll one line with a new seed
    python tts/cli.py gen --num-step 16      # fast draft pass (final render uses 32)

Raw takes live in audio/raw/<id>__<hash>.wav. The hash covers text, voice identity, and every
generation parameter, so editing any of them regenerates only the affected lines.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from common import (PROMPT_DIR, RAW_DIR, ROOT, SR, load_scenario, load_voices, resolve_line,
                    select_lines, short_hash, speak_text)

INDEX = RAW_DIR / "index.json"
ANCHOR_TEXT = "I was only passing through, but the evening air felt strangely warm, and I stayed a little longer."
REF_MODE = {"mode": "auto"}   # auto: full reference on CUDA, short one on CPU; or "short" / "full"


def select_ref(ref: dict) -> dict:
    """Pick the reference prompt variant. `clip`/`text` is the short (CPU-friendly) one, `full` the long one."""
    mode = REF_MODE["mode"]
    if mode == "auto":
        import torch
        mode = "full" if torch.cuda.is_available() else "short"
    if mode == "full" and ref.get("full"):
        return {"clip": ref["full"]["clip"], "text": ref["full"]["text"], "file": ref["file"]}
    return {"clip": ref.get("clip") or ref["file"], "text": ref.get("text"), "file": ref["file"]}


def load_index() -> dict:
    return json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else {}


def save_index(idx: dict):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(idx, indent=2, ensure_ascii=False), encoding="utf-8")


def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda:0", torch.float16
    return "cpu", torch.float32


class Engine:
    """Lazy wrapper around OmniVoice with reusable clone prompts."""

    def __init__(self, voices: dict):
        self.voices = voices
        self.model = None
        self.prompts: dict[str, object] = {}

    def load(self):
        if self.model is not None:
            return
        import torch
        from omnivoice import OmniVoice
        device, dtype = pick_device()
        print(f"[omnivoice] loading {self.voices['model']} on {device} ({dtype})", flush=True)
        t0 = time.time()
        self.model = OmniVoice.from_pretrained(self.voices["model"], device_map=device, dtype=dtype)
        print(f"[omnivoice] ready in {time.time() - t0:.0f}s, sampling rate {self.model.sampling_rate}", flush=True)
        assert self.model.sampling_rate == SR, "pipeline assumes 24 kHz"

    # --- voice identity ---------------------------------------------------
    def clone_prompt(self, key: str, ref_audio: str, ref_text: str | None):
        from omnivoice import VoiceClonePrompt
        PROMPT_DIR.mkdir(parents=True, exist_ok=True)
        cache = PROMPT_DIR / f"{key}__{short_hash([ref_audio, ref_text, Path(ROOT / ref_audio).stat().st_mtime_ns])}.pt"
        if key in self.prompts:
            return self.prompts[key]
        if cache.exists():
            prompt = VoiceClonePrompt.load(str(cache))
        else:
            self.load()
            prompt = self.model.create_voice_clone_prompt(ref_audio=str(ROOT / ref_audio), ref_text=ref_text)
            prompt.save(str(cache))
        self.prompts[key] = prompt
        return prompt

    def profile_prompt(self, pid: str):
        """Every profile resolves to a VoiceClonePrompt, so a voice stays identical across lines."""
        prof = self.voices["profiles"][pid]
        if prof["mode"] == "clone":
            ref = select_ref(self.voices["refs"][prof["ref"]])
            return self.clone_prompt(f"ref_{prof['ref']}", ref["clip"], ref["text"])
        if prof["mode"] == "design":
            # Designed voices are anchored once (design -> wav -> clone prompt) to keep identity fixed.
            # an optional per-profile `anchorText` sets the delivery the clone prompt carries into every line
            text = prof.get("anchorText", ANCHOR_TEXT)
            anchor = RAW_DIR / f"anchor_{pid}__{short_hash([prof['instruct'], prof['seed']] + ([text] if text != ANCHOR_TEXT else []))}.wav"
            if not anchor.exists():
                import torch
                self.load()
                torch.manual_seed(prof["seed"])
                audio = self.model.generate(text=text, instruct=prof["instruct"], language=prof.get("language", "en"),
                                            num_step=self.voices["numStep"])[0]
                RAW_DIR.mkdir(parents=True, exist_ok=True)
                sf.write(str(anchor), audio, SR, subtype="PCM_16")
            return self.clone_prompt(f"anchor_{pid}", str(anchor.relative_to(ROOT)), text)
        raise ValueError(prof["mode"])

    # --- synthesis --------------------------------------------------------
    def synth(self, pid: str, text: str, p: dict, num_step: int, seed: int):
        import torch
        self.load()
        prof = self.voices["profiles"][pid]
        prompt = self.profile_prompt(pid)
        torch.manual_seed(seed)
        kw = dict(
            text=text,
            language=prof.get("language", "en"),
            voice_clone_prompt=prompt,
            speed=p["speed"],
            num_step=num_step,
            guidance_scale=p["guidanceScale"],
            class_temperature=p["classTemperature"],
            position_temperature=p["positionTemperature"],
        )
        instruct = p.get("instruct") or (prof.get("instruct") if prof["mode"] == "clone" else None)
        if instruct:
            kw["instruct"] = instruct
        return self.model.generate(**kw)[0]


def take_key(voices: dict, scn: dict, line: dict, num_step: int) -> dict:
    r = resolve_line(scn, line)
    prof = voices["profiles"][line["speaker"]] if line.get("kind") != "sfx" else {}
    ref = select_ref(voices["refs"][prof["ref"]]) if prof and prof.get("ref") else {}
    return {
        "text": speak_text(line),
        "profile": prof,
        "ref": {k: ref.get(k) for k in ("clip", "text", "file")},
        "tts": r["tts"],
        "numStep": num_step,
        "model": voices["model"],
    }


def seed_for(voices: dict, line: dict, tts: dict, take: int) -> int:
    base = voices["profiles"][line["speaker"]]["seed"]
    n = int("".join(ch for ch in line["id"] if ch.isdigit()) or 0)
    return base + n * 13 + tts.get("seedOffset", 0) + take * 1009


def generate(ids: str | None = None, force: bool = False, num_step: int | None = None, take: int = 0, ref: str = "auto"):
    REF_MODE["mode"] = ref
    scn, voices = load_scenario(), load_voices()
    num_step = num_step or voices["numStep"]
    idx = load_index()
    engine = Engine(voices)
    todo = []
    for line in select_lines(scn, ids):
        if line.get("kind") == "sfx":
            continue
        key = take_key(voices, scn, line, num_step)
        line_take = take or line.get("take", 0)   # a chosen re-roll is pinned in scenario.json as "take": N
        h = short_hash({**key, "take": line_take})
        path = RAW_DIR / f"{line['id']}__{h}.wav"
        if path.exists() and not force:
            idx[line["id"]] = {"file": path.name, "hash": h, "numStep": num_step}
            continue
        todo.append((line, key, h, path, line_take))
    save_index(idx)
    print(f"[gen] {len(todo)} line(s) to synthesize (num_step={num_step})", flush=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for n, (line, key, h, path, line_take) in enumerate(todo, 1):
        t0 = time.time()
        seed = seed_for(voices, line, key["tts"], line_take)
        audio = engine.synth(line["speaker"], key["text"], key["tts"], num_step, seed)
        sf.write(str(path), audio, SR, subtype="PCM_16")
        dur = len(audio) / SR
        idx[line["id"]] = {"file": path.name, "hash": h, "numStep": num_step, "seed": seed, "seconds": round(dur, 2)}
        save_index(idx)
        print(f"[gen] {n}/{len(todo)} {line['id']} {line['speaker']} {dur:5.1f}s audio in {time.time() - t0:5.1f}s "
              f"(RTF {(time.time() - t0) / max(dur, 1e-3):.2f})", flush=True)
    return idx
