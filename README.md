# THE UNKNOWN CALLER

A psychological horror told in one phone call. The stranger speaks English (OmniVoice **voice design** — no real
person's voice is cloned — shaped with DSP), the screen shows Ukrainian subtitles, and everything happens inside one
PixiJS "oil pastel on black paper" frame that slowly falls apart. Playable in the browser and exportable as a finished
WebM with a real audio track (1920×1080 / 1280×720, or portrait, 30 fps).

```
black → phone rings → UNKNOWN CALLER → [ANSWER] → click, line noise → the conversation → the line goes dead
```

## Quick start (Windows, Bun)

```powershell
bun install
bun run dev            # http://127.0.0.1:5173
```

The repository ships the processed voice files in `public/audio/`, so the **whole film plays immediately** (every spoken line is a
32-step OmniVoice take, see *Status*).
Click **PRESS TO BEGIN** (browsers need a click before audio), wait for the rings, press **ANSWER**.

| control | what it does |
|---|---|
| PAUSE / RESUME (`Space`) | freezes picture *and* sound (the AudioContext is suspended) |
| RESTART (`R`) | back to the black screen and the first ring |
| VOL | speaker volume only — the recording never depends on it |
| TIMELINE | every line with time, speaker, mood, EN text, UA subtitle, audio file, effects; click a row to jump there |
| FORMAT | 16:9 (1920×1080) or 9:16 (1080×1920), for preview and export |
| EXPORT WEBM | records the whole film in real time and downloads it |

The controls are DOM elements outside the canvas, so they can never end up in the video.

## Status — read this first

| item | state |
|---|---|
| Script | all 58 beats of the source script are present (`scenario/scenario.json`), English dub + Ukrainian subtitles |
| **Voices** | **all 57 spoken lines are real OmniVoice** (`k2-fsa/OmniVoice`) at **num_step=32**, fp32, every one tagged `"engine": "omnivoice"` in `public/audio/manifest.json`. No draft/SAPI line remains (line `l040` is the CC0 scream SFX) |
| Voice identities | all four voices are **designed** from `instruct` text, nobody's recording is used or cloned: A = `male, low pitch, british accent` (seed 4242), B / M = `male, young adult, low pitch` (seed 2203), W = `female, young adult, moderate pitch, american accent` (seed 77). Each is anchored once (design → wav → clone prompt) so it stays one person |
| Playback in the browser | the full film (≈ 4:01 of call, 4:10 with black + rings) plays with picture, sound, subtitles and animation. It is shorter than the old ≈ 5:45 because OmniVoice reads the script in 206 s where the SAPI drafts took ~300 s |
| WebM export | verified end-to-end in headless Chromium on Linux: full film, 1280×720 VP9 + Opus, 30 fps (7455 frames / 250.4 s), `realtimeRatio` 1.00, duration patched, non-black frames, audible audio, line onsets in the file match the timeline to ±5 ms (no drift) |
| Rendered film | `renders/the-unknown-caller-720p.webm` (2-pass VP9 re-encode of that export, < 90 MB for GitHub) |
| Checked by measurement | Whisper (`large-v3-turbo`) round trip of every raw and every processed line (`python tts/cli.py qa`, WER ≤ 0.09 except laughter; "AZ" is heard in `l001` and `l026`), F0 median / spread per mood, CTC alignment confidence (all lines `ctc`, lowest 0.50 on the laugh `l029`) |
| **Not verified by ear** | nobody listened while building this: voice character, emotion, the laughs and the mix balance were judged by measurements only. Please listen before calling it final |
| 1080p | the cloud CPU rendered 1080p in real time but its software VP9 encoder dropped frames (≈ 22 fps in the file), so the shipped export is 720p. A GPU machine should export 1080p (`EXPORT WEBM`, 1080p) at full 30 fps |

### Re-render the voices (GPU or CPU)

```powershell
git clone https://github.com/a314ok/unknown-caller-claude-movie.git ; cd unknown-caller-claude-movie
bun install
uv venv --python 3.12 $env:LOCALAPPDATA\uc-venv
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe -r tts\requirements.txt
$py = "$env:LOCALAPPDATA\uc-venv\Scripts\python.exe"
& $py tts\cli.py gen                    # designed voices: anchors + every line, num_step=32 (cached by hash)
& $py tts\cli.py qa                     # Whisper round trip + pitch stats -> build/qa.json, flags takes to re-roll
& $py tts\cli.py process                # DSP, alignment, manifest
bun run dev                              # watch it, then EXPORT WEBM
```

Measured speed: 4-core Sapphire Rapids cloud VM, no GPU, fp32: the whole script at 32 steps took 32.5 min (RTF ≈ 9.4, ≈ 7 for
long lines, worse for short ones because of the fixed per-call cost). On a GPU it takes minutes.

## Exporting the WebM

`EXPORT WEBM` auto-answers after two rings and records everything: black → rings → call → black.

```
Pixi canvas ─drawImage→ 2D canvas ─captureStream(0)+requestFrame @30fps┐
                                                                        ├─ MediaStream → MediaRecorder → .webm
Web Audio mix ─→ MediaStreamAudioDestinationNode ───────────────────────┘
```

* MIME order tried: `video/webm;codecs=vp9,opus` → `vp8,opus` → `av1,opus` → `h264,opus` → `video/webm`. With none supported
  you get an on-screen error instead of a broken file.
* The WebGL canvas is copied into a 2D canvas before capture (capturing a WebGL drawing buffer directly can yield black
  frames). Picture and subtitles are drawn from the **audio clock**, so they cannot drift from the sound; the 30 fps frame
  cadence itself is paced on a wall-clock schedule (where `AudioContext.currentTime` advances in coarse steps, e.g. 21 ms
  quanta in headless Linux Chromium, gating on it alone delivered only ~23 fps).
* `realtimeRatio` ≈ 1.0 does not prove every frame reached the file: a software VP9 encoder that cannot keep up drops frames
  silently. Count them (`ffprobe -count_frames …`); on a 4-core CPU without GPU 1080p VP9 landed ≈ 22 fps, 720p a full 30.
* Subtitles are Pixi text inside the frame, so they are part of every exported frame.
* MediaRecorder output has no duration/cue data; `webm-duration-fix` patches it so players can seek.
* Keep the tab visible and the machine awake during the ~4-minute recording (browsers throttle hidden tabs).
* **Real-time check:** the exporter measures wall-clock seconds per second of film. If the machine could not keep up
  (ratio > 1.05) the app tells you the file may be out of sync — choose **EXPORT 720p** or close other apps.
  (The audio graph only instantiates nodes a few seconds ahead of time; creating thousands up front once made the audio
  clock run 5× slow on a weak CPU.)
* A master safety limiter keeps scream / multi-voice peaks from clipping the recording.
* Verify a file: `python scripts/verify_webm.py path/to/file.webm` (streams, loudness of the audio track, black-frame check).

## Voice generation (OmniVoice)

Voices are generated offline with the official model [`k2-fsa/OmniVoice`](https://github.com/k2-fsa/OmniVoice)
(`num_step=32`), then shaped by DSP, aligned and written to `public/audio/`.

```powershell
uv venv --python 3.12 $env:LOCALAPPDATA\uc-venv          # short path on purpose: Windows MAX_PATH breaks torch DLLs in deep folders
# NVIDIA (RTX 2060 12 GB):  CUDA wheels
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
# CPU only:                 uv pip install --python ... torch==2.8.0 torchaudio==2.8.0
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe -r tts\requirements.txt

$py = "$env:LOCALAPPDATA\uc-venv\Scripts\python.exe"
& $py tts\cli.py all                      # generate → DSP → forced alignment → manifest
```

The device is picked automatically (`cuda:0` + fp16 when available, otherwise CPU + fp32).
A modern CPU is usable (≈ 33 min for the whole script at 32 steps on 4 cores, see *Status*); a GPU takes minutes.

| command | purpose |
|---|---|
| `cli.py gen [--lines l005,l026] [--force] [--take N] [--num-step 16]` | OmniVoice only. Raw takes are cached in `audio/raw/<id>__<hash>.wav`; the hash covers text, voice identity and every generation parameter, so only edited lines are re-rendered |
| `cli.py process [--lines …] [--no-align]` | DSP performance, trimming, level matching, multi-voice layers, CTC forced alignment → `public/audio/lines/*.wav` + `manifest.json` |
| `cli.py draft [--lines …]` | offline Windows-SAPI stand-in for every line that has no OmniVoice take (watchable preview, clearly tagged). `process` always prefers an OmniVoice take over a draft |
| `cli.py all` | `gen` + `process` |
| `cli.py probe` | caller casting: for several `instruct`/seed candidates renders anchor + a playful and a cold test line, prints F0 median / spread and a Whisper round trip (`build/probe.json`) |
| `cli.py qa [--lines …]` | Whisper round trip (WER vs `speak`), F0 median / semitone spread, speech rate and clipping for every cached raw take; flags takes to re-roll (`build/qa.json`) |
| `cli.py mix` | renders the voice-only master track from the timeline (QA/montage) |
| `bun run timeline` | structured timeline → `build/timeline.json` and `.csv` |

**Re-generate a single line**: edit its text/`tts` in `scenario/scenario.json`, or re-roll with a different seed, then
`cli.py gen --lines l005 --force --take 2` and `cli.py process --lines l005`. Nothing else is touched. Pin a chosen re-roll
with `"take": 2` on the line in `scenario.json` (as `l047` does), so a later plain `gen` keeps it.

### What OmniVoice does natively — and what is DSP

Verified against the installed package (`omnivoice/models/omnivoice.py`) and its docs:

| native to OmniVoice | used here |
|---|---|
| voice design via `instruct` (gender, age, pitch, accent, `whisper`) | all four voices (A, B, M, W) |
| reusable `VoiceClonePrompt` | anchoring only: each designed voice is rendered once and every line is generated from that prompt, so the identity never changes. No real recording is cloned |
| `speed` / `duration` | per-line speed, incl. the 1.08 → 1.20 → 1.30 → 1.48 acceleration in the wheel passage |
| `whisper` style | tried on the final line: together with a clone prompt it had no measurable effect (same voiced fraction and F0 as the plain take), so the ending uses the plain take + the close-mic `intimate` DSP |
| non-verbal tags `[laughter]`, `[sigh]`, `[question-*]`, `[surprise-*]`, `[dissatisfaction-hnn]` | `[laughter]` on the laugh lines |
| sampling: `class_temperature`, `position_temperature`, `guidance_scale` | per-mood expressiveness |
| **no emotion control** | emotion is made with: punctuation/pauses in `speak`, speed curves, temperature, and the DSP below |

DSP (`tts/dsp.py`): Praat *Change gender* (pitch median, pitch range = how theatrical, formant ratio = baritone size),
hoarse "grit", low-shelf/presence EQ, compression, vibrato + bit-crush for the parody voice, telephone band-limit,
per-line loudness matching, plus runtime dynamics (crescendo/decrescendo per mood) and phone-vs-close-mic balance
in the Web Audio mix. The multi-voice line renders five layers of the same take with different pitch/formant, delay
and pan, plus a small dark room.

### Voices

`voices/voices.json` defines the profiles. **No real person's voice is used or cloned**: A (caller), B (Azik), M (parody Azik)
and W (her) are all *voice-designed* from `instruct` text and anchored once so they stay the same person. (The `mode: clone`
+ `refs` code path still exists for a legally obtained recording but is not used.)

How they were cast (measured, `cli.py probe`): for A, three instructs × two seeds were compared on a playful and a cold line.
`male, low pitch, british accent` / seed 4242 had clean ASR and the widest natural pitch movement (≈ 3.3–3.5 semitones
standard deviation, 9.5–10.6 st range, F0 ≈ 85–99 Hz), i.e. the least monotone baritone; the "middle-aged, very low pitch"
variants were flatter. B's original `moderate pitch` design came out at ≈ 220 Hz; `male, young adult, low pitch` (anchor
≈ 139 Hz) reads as a young man with no pitch DSP. M is the same identity as B, pitched up, wobbled and crushed by DSP.
The caller presets in `dspPresets` are deliberately light (formant 0.93–0.97, pitch medians 82–118 Hz) because the designed
voice is already low; tone between moods comes mostly from OmniVoice's own reading (punctuation, speed, temperature).

### The scream

`assets/sfx/scream.wav` is cut from *Female high-pitched scream SFX* by WuxiaScrub (OpenGameArt), **CC0**. See
`assets/sfx/README.md`. Every other non-voice sound is synthesised live in `src/audio/engine.ts`.

## Project layout

```
scenario/scenario.json     the whole film as data: lines (EN/UA/mood/pauses/effects), moods, DSP presets, scenes, intro/outro
voices/                    voice profiles + reference recordings
tts/                       OmniVoice generation, DSP, forced alignment, manifest, tests
public/audio/              generated, processed voice assets + manifest.json (served to the browser)
src/core/                  timeline builder, subtitle cue builder (pure, unit-tested)
src/audio/engine.ts        Web Audio mix, atmosphere, ring/connect/dead-line sounds
src/render/                PixiJS: scene, crayon brush, drawings, paper filter (GLSL), subtitles
src/app/                   player (clock + phases), DOM UI, styles
src/export/recorder.ts     WebM recorder
scripts/                   timeline export, WebM verifier
lab.html, sheet.html       dev aids: scene lab and a contact sheet of every drawing
tests/                     bun tests (core) and pytest (voice pipeline)
```

Timecodes are never hard-coded: `buildTimeline()` lays lines out from the **real audio durations** plus the authored
pauses (`timing.gapBefore`). Edit a pause or re-generate a line and everything after it moves.

### Subtitles

Ukrainian only, always in the lower third, max two rows, balanced wrapping at word boundaries. A line normally becomes one
cue timed to the real speech span; long lines are split on clause boundaries and each piece is timed by mapping its
position onto the **forced-aligned English words** (not by character count). Cues fade out after a short linger so they
vanish in long silences.

## Tests

End-to-end (real headless Edge/Chrome; on Linux the Playwright Chromium, or set `CHROME_PATH`; needs `bun run dev` running): plays,
answers, records, saves, reports.

```powershell
node scripts/e2e.mjs --from 0 --limit 20 --name smoke.webm        # 20 s smoke export -> test-output/smoke.webm
node scripts/e2e.mjs --limit 420 --name film.webm                 # the whole film in real time (add --quality 720p on a CPU-only box)
node scripts/e2e.mjs --quality 720p --format portrait --limit 20 --name p.webm
python scripts/verify_webm.py test-output/film.webm               # streams, loudness, black-frame check
node scripts/shots.mjs 14.5 156.5 225.2 336                       # screenshots of the film at call times (seek)
```


```powershell
bun test tests                 # timeline, cues, drawings, scenario coverage
& $py -m pytest tests/py -q    # DSP, alignment helpers, cache keys, scenario resolution
bun run typecheck
```

## Notes on the Ukrainian → English dub

* Idioms are translated by sense: "крутитись як білка в колесі" → *spinning like a hamster in that bloody wheel*,
  "іде коту під хвіст" → *down the drain*, "ва-банк" → *all-in*.
* Profanity and the caller's cruelty are preserved. The caller addresses the listener as **AZ** (spoken "ay-zee"; `speak` is spelled `Ey-Zee` for the model, because OmniVoice read `Ay Zee` as "eye-zee" / "Iz" in a Whisper round trip; the Ukrainian subtitle reads «Ей-Зі»).
* `l043` ("Спочатку тебе, а потім ти всіх") is elliptical in the source; it is rendered as *First it's them running from you…
  then you running from everyone* — change it in `scenario.json` if you meant something else.
* The source line "не міняючи своєї!" is left unfinished on purpose (`l048`), as in the script.
