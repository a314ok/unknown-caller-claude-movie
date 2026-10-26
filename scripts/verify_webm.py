"""Inspect an exported WebM: streams, duration, loudness of the audio track, and black-frame check.

    python scripts/verify_webm.py test-output/export.webm [--frames 6]

Needs `imageio-ffmpeg` (bundled ffmpeg binary), numpy, soundfile-free. Prints PASS/FAIL per check and writes
sample PNG frames next to the file so the picture can be eyeballed.
"""
import argparse, re, subprocess, sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np

FF = imageio_ffmpeg.get_ffmpeg_exe()


def run(*args):
    p = subprocess.run([FF, "-hide_banner", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--frames", type=int, default=6)
    a = ap.parse_args()
    f = Path(a.file)
    ok = True
    info = run("-i", str(f))
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
    seconds = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0
    vid = re.search(r"Stream #\S+: Video: (\w+).*?, (\d+)x(\d+)", info)
    aud = re.search(r"Stream #\S+: Audio: (\w+).*?, (\d+) Hz, (\w+)", info)
    print(f"file      : {f.name} ({f.stat().st_size/1048576:.1f} MB)")
    print(f"duration  : {seconds:.2f} s")
    print(f"video     : {vid.groups() if vid else None}")
    print(f"audio     : {aud.groups() if aud else None}")
    ok &= bool(vid) and bool(aud) and seconds > 1
    print("PASS has video+audio streams" if (vid and aud) else "FAIL missing stream")

    vol = run("-i", str(f), "-vn", "-af", "volumedetect", "-f", "null", "-")
    mean = re.search(r"mean_volume: (-?[\d.]+) dB", vol)
    mx = re.search(r"max_volume: (-?[\d.]+) dB", vol)
    print(f"loudness  : mean {mean.group(1) if mean else '?'} dB, max {mx.group(1) if mx else '?'} dB")
    audible = bool(mx) and float(mx.group(1)) > -40
    print("PASS audio track is not silent" if audible else "FAIL audio is silent")
    ok &= audible

    # sample frames evenly and measure how much picture there is
    w, h = (int(vid.group(2)), int(vid.group(3))) if vid else (0, 0)
    stats = []
    for i in range(a.frames):
        t = seconds * (i + 0.5) / a.frames
        out = f.with_name(f"{f.stem}_frame{i}.png")
        run("-ss", f"{t:.2f}", "-i", str(f), "-frames:v", "1", "-y", str(out))
        raw = subprocess.run([FF, "-hide_banner", "-ss", f"{t:.2f}", "-i", str(f), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        if len(raw) == w * h and w:
            g = np.frombuffer(raw, np.uint8)
            stats.append((t, float(g.mean()), float((g > 60).mean())))
    for t, m, lit in stats:
        print(f"  t={t:6.1f}s mean luma {m:5.1f}  lit px {lit*100:5.2f}%")
    non_black = sum(1 for _, m, lit in stats if lit > 0.002)
    print(f"{'PASS' if non_black >= max(1, a.frames // 2) else 'FAIL'} non-black frames: {non_black}/{len(stats)}")
    ok &= non_black >= max(1, a.frames // 2)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
