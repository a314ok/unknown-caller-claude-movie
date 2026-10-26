import json, sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tts"))

import dsp  # noqa: E402
import align  # noqa: E402
import common  # noqa: E402
import generate  # noqa: E402

SR = 24000


def vowel(f0=140.0, seconds=1.5, sr=SR):
    """Glottal-ish pulse train through two formants: enough 'voice' for pitch tracking."""
    from scipy import signal
    t = np.arange(int(sr * seconds)) / sr
    phase = np.cumsum(np.full_like(t, f0) / sr)
    src = np.where((phase % 1.0) < 0.02, 1.0, 0.0) - 0.02
    src = signal.lfilter([1], [1, -0.97], src)
    y = src
    for fc, bw in [(700, 90), (1200, 110), (2600, 160)]:
        r = np.exp(-np.pi * bw / sr)
        a = [1, -2 * r * np.cos(2 * np.pi * fc / sr), r * r]
        y = signal.lfilter([1 - r], a, y)
    y /= np.abs(y).max()
    return (y * 0.5).astype(np.float32)


def test_median_f0_tracks_synthetic_voice():
    assert dsp.median_f0(vowel(140)) == pytest.approx(140, rel=0.06)


def test_change_gender_moves_pitch_to_target():
    x = vowel(150)
    y = dsp.change_gender(x, SR, formant=0.87, median=100, pitch_range=1.0)
    assert dsp.median_f0(y) == pytest.approx(100, rel=0.1)
    assert abs(len(y) - len(x)) < SR * 0.05


def test_median_zero_keeps_pitch():
    x = vowel(130)
    y = dsp.change_gender(x, SR, formant=1.0, median=0, pitch_range=1.0)
    assert dsp.median_f0(y) == pytest.approx(130, rel=0.1)


def test_presets_all_run_and_stay_finite_and_bounded():
    scn = common.load_scenario()
    x = vowel(150, 1.2)
    for name, preset in scn["dspPresets"].items():
        y = dsp.perform(x, SR, preset, seed=3)
        y = dsp.normalize(y, SR, gain_db=preset.get("gainDb", 0))
        assert np.isfinite(y).all(), name
        assert np.abs(y).max() <= 0.95, name
        assert len(y) > SR * 0.5, name


def test_cold_is_lower_and_flatter_than_theatrical():
    scn = common.load_scenario()
    x = vowel(150, 1.5)
    cold = dsp.median_f0(dsp.perform(x, SR, scn["dspPresets"]["cold"]))
    theatrical = dsp.median_f0(dsp.perform(x, SR, scn["dspPresets"]["theatrical"]))
    assert cold < theatrical


def test_trim_removes_silence_but_keeps_voice():
    x = np.concatenate([np.zeros(SR), vowel(140, 1.0), np.zeros(SR)])
    y, lead, tail = dsp.trim(x, SR)
    assert len(y) < len(x) * 0.6
    assert lead > SR * 0.5 and tail > SR * 0.5
    assert np.abs(y).max() > 0.1


def test_normalize_hits_target_level():
    y = dsp.normalize(vowel(140, 1.0) * 0.1, SR, target_db=-21.0)
    assert dsp.voiced_rms_db(y, SR) == pytest.approx(-21.0, abs=2.0)


def test_alignment_word_extraction_strips_tags_and_hyphens():
    assert align.words_of("[laughter] Ha, ha! A-plus student's") == ["Ha", "ha", "A", "plus", "student's"]


def test_alignment_fallback_is_monotonic_and_covers_speech():
    x = np.concatenate([np.zeros(SR // 4), vowel(140, 2.0), np.zeros(SR // 4)])
    words, method = align._fallback(["one", "two", "three", "four"], x, SR)
    assert method == "proportional"
    for a, b in zip(words, words[1:]):
        assert a["t1"] <= b["t0"] + 1e-6
    assert words[0]["t0"] >= 0.2 and words[-1]["t1"] <= 2.5


def test_scenario_resolves_every_line():
    scn = common.load_scenario()
    voices = common.load_voices()
    for line in scn["lines"]:
        r = common.resolve_line(scn, line)
        assert r["tts"]["speed"] > 0.5
        if line.get("kind") != "sfx":
            assert line["speaker"] in voices["profiles"], line["id"]
            assert common.speak_text(line).strip()


def test_take_key_changes_only_when_inputs_change():
    scn, voices = common.load_scenario(), common.load_voices()
    line = scn["lines"][0]
    k1 = generate.take_key(voices, scn, line, 32)
    k2 = generate.take_key(voices, scn, line, 32)
    assert common.short_hash(k1) == common.short_hash(k2)
    assert common.short_hash(generate.take_key(voices, scn, line, 16)) != common.short_hash(k1)
    other = json.loads(json.dumps(line))
    other["speak"] = "different words"
    assert common.short_hash(generate.take_key(voices, scn, other, 32)) != common.short_hash(k1)


def test_scream_asset_present_and_licensed():
    assert (ROOT / "assets" / "sfx" / "scream.wav").exists()
    assert "CC0" in (ROOT / "assets" / "sfx" / "README.md").read_text(encoding="utf-8")


def test_qa_wer_ignores_punctuation_tags_and_az_spelling():
    import qa
    assert qa.wer("[laughter] Nobody gives a fuck about you... Ey-Zee.", "Nobody gives a fuck about you, AZ.") == 0.0
    assert qa.wer("Who... is this?", "Who is that?") == pytest.approx(1 / 3, abs=0.01)
    assert qa.says_az("Long time no hear, AZ. I do hope") and not qa.says_az("Long time no hear, Izzy.")


def test_qa_pitch_stats_on_synthetic_voice():
    import qa
    st = qa.pitch_stats(vowel(120, 1.5))
    assert st["f0"] == pytest.approx(120, rel=0.06) and st["stSd"] < 0.5
