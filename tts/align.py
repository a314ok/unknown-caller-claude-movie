"""CTC forced alignment of the known English text against the generated audio (word timings).

Uses torchaudio's WAV2VEC2_ASR_BASE_960H bundle + torchaudio.functional.forced_align. If the
alignment fails (laughter, screams, odd tokens) it falls back to an energy-weighted
proportional split so every line still gets word-level timings.
"""
from __future__ import annotations

import re

import numpy as np

_bundle = _model = _labels = None


def _load():
    global _bundle, _model, _labels
    if _model is None:
        import torchaudio
        _bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        _model = _bundle.get_model().eval()
        _labels = _bundle.get_labels()  # ('-', '|', 'E', 'T', ...)
    return _bundle, _model, _labels


def words_of(text: str) -> list[str]:
    text = re.sub(r"\[[^\]]*\]", " ", text)          # drop [laughter] style tags
    text = text.replace("-", " ").replace("’", "'")
    return [w for w in re.findall(r"[A-Za-z']+", text) if re.search(r"[A-Za-z]", w)]


def _fallback(words, audio, sr):
    env = np.abs(audio)
    k = int(sr * 0.02)
    env = np.convolve(env, np.ones(k) / k, mode="same")
    idx = np.where(env > env.max() * 0.03)[0]
    a, b = (idx[0], idx[-1]) if len(idx) else (0, len(audio) - 1)
    weights = np.array([max(1, len(w)) + 1.5 for w in words], dtype=float)
    edges = np.concatenate([[0], np.cumsum(weights)]) / weights.sum()
    t = (a + edges * (b - a)) / sr
    return [{"w": w, "t0": float(t[i]), "t1": float(t[i + 1])} for i, w in enumerate(words)], "proportional"


def align(text: str, audio: np.ndarray, sr: int):
    """Return ([{w,t0,t1}], method)."""
    import torch
    import torchaudio
    words = words_of(text)
    if not words:
        return [], "none"
    try:
        bundle, model, labels = _load()
        wav = torch.from_numpy(audio.astype(np.float32))[None]
        if sr != bundle.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
        with torch.inference_mode():
            emission, _ = model(wav)
            emission = torch.log_softmax(emission, dim=-1)
        dictionary = {c: i for i, c in enumerate(labels)}
        tokens, spans = [], []
        for wi, w in enumerate(words):
            for ch in w.upper():
                if ch in dictionary:
                    tokens.append(dictionary[ch])
                    spans.append(wi)
            if wi != len(words) - 1:
                tokens.append(dictionary["|"])
                spans.append(-1)
        targets = torch.tensor([tokens], dtype=torch.int32)
        if emission.shape[1] < len(tokens):
            raise RuntimeError("audio too short for transcript")
        aligned, scores = torchaudio.functional.forced_align(emission, targets, blank=0)
        aligned, scores = aligned[0], scores[0].exp()
        merged = torchaudio.functional.merge_tokens(aligned, scores)   # one span per target token
        # merge_tokens drops blanks; spans correspond 1:1 with `tokens`
        if len(merged) != len(tokens):
            raise RuntimeError("token/span mismatch")
        ratio = wav.shape[1] / emission.shape[1] / bundle.sample_rate
        t0 = [None] * len(words)
        t1 = [None] * len(words)
        for span, wi in zip(merged, spans):
            if wi < 0:
                continue
            s, e = span.start * ratio, span.end * ratio
            t0[wi] = s if t0[wi] is None else min(t0[wi], s)
            t1[wi] = e if t1[wi] is None else max(t1[wi], e)
        if any(v is None for v in t0):
            raise RuntimeError("unaligned word")
        conf = float(np.mean([s.score for s in merged]))
        out = [{"w": w, "t0": float(a), "t1": float(b)} for w, a, b in zip(words, t0, t1)]
        return out, f"ctc({conf:.2f})"
    except Exception as exc:  # noqa: BLE001 - alignment is best-effort by design
        out, method = _fallback(words, audio, sr)
        return out, f"{method} [{type(exc).__name__}: {exc}]"
