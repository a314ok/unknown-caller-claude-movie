"""DSP used to shape OmniVoice output into performances.

OmniVoice natively controls: voice identity (clone / design), speed or exact duration,
non-verbal tags ([laughter] ...), and sampling temperature. It has NO native emotion
control, so tone is shaped here: Praat "Change gender" (pitch median / pitch range /
formant ratio), grit, EQ, compression, vibrato and bit-crush, telephone band-limit.
"""
from __future__ import annotations

import numpy as np
import parselmouth
from parselmouth.praat import call
from scipy import signal

SR = 24000


# ---------------------------------------------------------------- pitch / formants
def median_f0(x: np.ndarray, sr: int = SR) -> float:
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch_ac(pitch_floor=60, pitch_ceiling=450)
    f = pitch.selected_array["frequency"]
    f = f[f > 0]
    return float(np.median(f)) if len(f) else 120.0


def change_gender(x: np.ndarray, sr: int, formant: float, median: float, pitch_range: float) -> np.ndarray:
    """Praat PSOLA-based pitch median / range / formant-ratio change. median==0 keeps pitch."""
    own = median_f0(x, sr)
    target = own if median <= 0 else median
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
    lo = max(50.0, min(own, target) * 0.55)
    hi = min(600.0, max(own, target) * 2.4)
    out = call(snd, "Change gender", lo, hi, float(formant), float(target), float(pitch_range), 1.0)
    y = out.values[0].astype(np.float32)
    return y


# ---------------------------------------------------------------- filters
def _biquad(kind: str, f0: float, gain_db: float, q: float, sr: int):
    a_lin = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    if kind == "lowshelf":
        sq = 2 * np.sqrt(a_lin) * alpha
        b0 = a_lin * ((a_lin + 1) - (a_lin - 1) * cw + sq)
        b1 = 2 * a_lin * ((a_lin - 1) - (a_lin + 1) * cw)
        b2 = a_lin * ((a_lin + 1) - (a_lin - 1) * cw - sq)
        a0 = (a_lin + 1) + (a_lin - 1) * cw + sq
        a1 = -2 * ((a_lin - 1) + (a_lin + 1) * cw)
        a2 = (a_lin + 1) + (a_lin - 1) * cw - sq
    elif kind == "peak":
        b0 = 1 + alpha * a_lin
        b1 = -2 * cw
        b2 = 1 - alpha * a_lin
        a0 = 1 + alpha / a_lin
        a1 = -2 * cw
        a2 = 1 - alpha / a_lin
    else:
        raise ValueError(kind)
    return np.array([b0, b1, b2]) / a0, np.array([1, a1 / a0, a2 / a0])


def eq(x, sr, low_shelf_db=0.0, presence_db=0.0):
    if abs(low_shelf_db) > 0.01:
        b, a = _biquad("lowshelf", 180, low_shelf_db, 0.7, sr)
        x = signal.lfilter(b, a, x)
    if abs(presence_db) > 0.01:
        b, a = _biquad("peak", 3200, presence_db, 0.9, sr)
        x = signal.lfilter(b, a, x)
    return x.astype(np.float32)


def band(x, sr, lo, hi, order=4):
    sos = signal.butter(order, [lo, hi], btype="band", fs=sr, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def highpass(x, sr, f, order=2):
    sos = signal.butter(order, f, btype="high", fs=sr, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def lowpass(x, sr, f, order=2):
    sos = signal.butter(order, f, btype="low", fs=sr, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def telephone(x, sr, drive=1.6):
    y = band(x, sr, 320, 3400, 4)
    y = np.tanh(y * drive) / np.tanh(drive)
    return y.astype(np.float32)


# ---------------------------------------------------------------- character
def envelope(x, sr, ms=12.0):
    n = max(1, int(sr * ms / 1000))
    k = np.ones(n, dtype=np.float32) / n
    return np.sqrt(np.convolve(x * x, k, mode="same") + 1e-12)


def grit(x, sr, amount: float, seed: int = 7):
    """Hoarse voice: parallel soft-clip drive + low-rate amplitude roughness + voiced hiss."""
    if amount <= 0:
        return x
    rng = np.random.default_rng(seed)
    hp = highpass(x, sr, 140)
    drive = np.tanh(hp * (1.0 + 7.0 * amount)) / np.tanh(1.0 + 7.0 * amount)
    n = len(x)
    rough = lowpass(rng.standard_normal(n).astype(np.float32), sr, 85)
    rough /= (np.std(rough) + 1e-9)
    y = x * (1.0 + 0.22 * amount * rough)
    y = y * (1 - 0.35 * amount) + drive * (0.35 * amount) * np.std(x) / (np.std(drive) + 1e-9)
    hiss = band(rng.standard_normal(n).astype(np.float32), sr, 2200, 7000)
    y = y + hiss * envelope(x, sr, 18) * (0.22 * amount)
    return y.astype(np.float32)


def compress(x, sr, amount: float):
    if amount <= 0:
        return x
    ratio = 1.0 + 3.5 * amount
    thr_db = -26.0 + 4.0 * amount
    hop = 64
    n = len(x) // hop
    if n < 2:
        return x
    frames = x[: n * hop].reshape(n, hop)
    lvl = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    gain_db = np.zeros(n)
    atk, rel = 1 - np.exp(-hop / (0.006 * sr)), 1 - np.exp(-hop / (0.12 * sr))
    cur = 0.0
    for i in range(n):
        over = max(0.0, lvl[i] - thr_db)
        target = -over * (1 - 1 / ratio)
        coef = atk if target < cur else rel
        cur += (target - cur) * coef
        gain_db[i] = cur
    gain = np.interp(np.arange(len(x)), (np.arange(n) + 0.5) * hop, 10 ** (gain_db / 20))
    makeup = 10 ** ((abs(thr_db) * (1 - 1 / ratio) * 0.45) / 20)
    return (x * gain * makeup).astype(np.float32)


def vibrato(x, sr, depth_ms=0.9, rate=5.5, jitter=0.0, seed=3):
    """Time-varying delay -> pitch wobble (for the parody voice)."""
    n = len(x)
    t = np.arange(n) / sr
    rng = np.random.default_rng(seed)
    wob = np.sin(2 * np.pi * rate * t)
    if jitter > 0:
        wob += jitter * lowpass(rng.standard_normal(n).astype(np.float32), sr, 12) * 6
    idx = np.arange(n) + wob * depth_ms * sr / 1000
    return np.interp(idx, np.arange(n), x).astype(np.float32)


def bitcrush(x, sr, amount: float):
    if amount <= 0:
        return x
    hold = max(1, int(1 + amount * 3))
    bits = 12 - amount * 5
    q = 2 ** (bits - 1)
    crushed = np.round(x * q) / q
    crushed = np.repeat(crushed[::hold], hold)[: len(x)]
    return (x * (1 - amount * 0.6) + crushed * amount * 0.6).astype(np.float32)


# ---------------------------------------------------------------- level / trim
def voiced_rms_db(x, sr):
    env = envelope(x, sr, 20)
    gate = env > max(env.max() * 0.05, 1e-4)
    if gate.sum() < sr * 0.05:
        return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)
    return 20 * np.log10(np.sqrt(np.mean(x[gate] ** 2)) + 1e-9)


def normalize(x, sr, target_db=-21.0, gain_db=0.0):
    x = x * 10 ** ((target_db - voiced_rms_db(x, sr) + gain_db) / 20)
    # soft limiter
    return (np.tanh(x * 0.9 / 0.93) * 0.93).astype(np.float32)


def trim(x, sr, lead_ms=70, tail_ms=140, thresh_db=-42.0):
    env = envelope(x, sr, 8)
    peak = env.max()
    if peak <= 0:
        return x, 0, 0
    idx = np.where(env > peak * 10 ** (thresh_db / 20))[0]
    if len(idx) == 0:
        return x, 0, 0
    a = max(0, idx[0] - int(sr * lead_ms / 1000))
    b = min(len(x), idx[-1] + int(sr * tail_ms / 1000))
    y = x[a:b].copy()
    fade = int(sr * 0.012)
    if len(y) > 2 * fade:
        y[:fade] *= np.linspace(0, 1, fade)
        y[-fade:] *= np.linspace(1, 0, fade)
    return y, a, len(x) - b


# ---------------------------------------------------------------- full chain
def perform(x: np.ndarray, sr: int, p: dict, seed: int = 7) -> np.ndarray:
    """Apply a DSP preset (dict from scenario.json dspPresets) to a raw TTS take."""
    y = x.astype(np.float32)
    if p.get("pitchMedian", 0) or p.get("formant", 1.0) != 1.0 or p.get("pitchRange", 1.0) != 1.0:
        y = change_gender(y, sr, p.get("formant", 1.0), p.get("pitchMedian", 0), p.get("pitchRange", 1.0))
    if p.get("wobble"):
        y = vibrato(y, sr, depth_ms=0.5 + 1.6 * p["wobble"], rate=5.0 + 4 * p["wobble"], jitter=p["wobble"], seed=seed)
    y = grit(y, sr, p.get("grit", 0.0), seed)
    y = eq(y, sr, p.get("lowShelfDb", 0.0), p.get("presenceDb", 0.0))
    y = compress(y, sr, p.get("compress", 0.0))
    if p.get("crush"):
        y = bitcrush(y, sr, p["crush"])
    if p.get("phone"):
        y = telephone(y, sr, 1.3)
    return y
