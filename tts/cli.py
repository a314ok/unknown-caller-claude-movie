"""Voice pipeline entry point.

  python tts/cli.py gen      [--lines ids] [--force] [--take N] [--num-step N] [--ref auto|short|full]
  python tts/cli.py draft    [--lines ids]   # offline SAPI stand-in voices for lines without an OmniVoice take (Windows)
  python tts/cli.py process  [--lines ids] [--no-align]
  python tts/cli.py all      [--lines ids]
  python tts/cli.py probe    # voice-A design candidates: anchor + 2 test lines each, pitch / ASR stats (audio/probe, build/probe.json)
  python tts/cli.py qa       [--lines ids] [--processed]   # Whisper round trip + pitch stats per raw take / processed line
  python tts/cli.py mix      # render the voice-only final track from timeline.json (QA / montage)
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["gen", "draft", "process", "all", "probe", "mix", "qa"])
    ap.add_argument("--lines")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--take", type=int, default=None, help="re-roll index; overrides a line's pinned \"take\" (default: the pinned take, else 0)")
    ap.add_argument("--num-step", type=int)
    ap.add_argument("--no-align", action="store_true")
    ap.add_argument("--ref", choices=["auto", "short", "full"], default="auto", help="reference prompt: full (10.6 s) on CUDA, short (4 s) on CPU")
    ap.add_argument("--asr", default="openai/whisper-large-v3-turbo", help="Whisper model for `qa`")
    ap.add_argument("--processed", action="store_true", help="`qa`: measure public/audio/lines instead of the raw takes")
    a = ap.parse_args()

    if a.cmd in ("gen", "all"):
        from generate import generate
        generate(a.lines, a.force, a.num_step, a.take, a.ref)
    if a.cmd == "draft":
        from draft import draft
        draft(a.lines)
    if a.cmd in ("process", "all"):
        from process import process
        process(a.lines, align=not a.no_align)
    if a.cmd == "probe":
        from probe import probe
        probe()
    if a.cmd == "qa":
        from qa import qa
        qa(a.lines, a.asr, a.processed)
    if a.cmd == "mix":
        from mix import mix
        mix()


if __name__ == "__main__":
    main()
