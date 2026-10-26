# THE UNKNOWN CALLER

A psychological horror told in one phone call. The stranger speaks English (OmniVoice, cloned from your own
reference recording and shaped with DSP), the screen shows Ukrainian subtitles, and everything happens inside one
PixiJS "oil pastel on black paper" frame that slowly falls apart. Playable in the browser and exportable as a finished
WebM with a real audio track (1920×1080 or 1080×1920, 30 fps).

```
black → phone rings → UNKNOWN CALLER → [ANSWER] → click, line noise → the conversation → the line goes dead
```

## Quick start (Windows, Bun)

```powershell
bun install
bun run dev            # http://127.0.0.1:5173
```

The repository ships the processed voice files in `public/audio/`, so the **whole film plays immediately** (see *Status*
for which lines are final OmniVoice and which are draft stand-ins).
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
| Playback in the browser | the full film (≈ 5:45 of call + black + rings) plays with picture, sound, subtitles and animation |
| WebM export | implemented and verified end-to-end in headless Edge (VP9+Opus, 1920×1080 or 1080×1920, 30 fps, duration patched, non-black frames, audible audio) |
| **OmniVoice lines** | 6 key lines were rendered with the real model on CPU at **num_step=16** (a 4 s reference prompt): `l001 l002 l026 l028 l029 l058` |
| **Draft lines** | the other 51 spoken lines are **stand-ins** (offline Windows SAPI voice → same DSP → forced alignment), tagged `"engine": "sapi-draft"` in `manifest.json` and announced in the app. They exist only so the film can be watched on a machine where OmniVoice is impractical |
| Final quality | **not final.** Run the OmniVoice pipeline on the RTX 2060 (below) to replace every draft line with `num_step=32` takes |
| Not verified by ear | nobody listened to the output while building it: voice character, emotion and mix balance were checked with measurements (pitch, loudness, alignment confidence), not with ears |

Why drafts: the build machine had no NVIDIA GPU and its CPU sat at ~400 MHz; one OmniVoice step took ≈ 50 s, i.e. ~15–30 min per
7 s of speech (RTF 90–250 at 16 steps). A full 32-step render there would take days. On the RTX 2060 it takes minutes.

### Finish it on your GPU PC (the intended path)

```powershell
git clone https://github.com/a314ok/unknown-caller-claude-movie.git ; cd unknown-caller-claude-movie
bun install
uv venv --python 3.12 $env:LOCALAPPDATA\uc-venv
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
uv pip install --python $env:LOCALAPPDATA\uc-venv\Scripts\python.exe -r tts\requirements.txt
# put your reference recording at voices\refs\azik_ref.ogg (not in git, see voices/refs/README.md), then:
$py = "$env:LOCALAPPDATA\uc-venv\Scripts\python.exe"
& $py tts\prepare_ref.py --asr openai/whisper-large-v3-turbo   # clip + transcript (check the transcript!)
& $py tts\cli.py gen --force            # every line, num_step=32, full 10.6 s reference (auto on CUDA)
& $py tts\cli.py process                # DSP, alignment, manifest
bun run dev                              # watch it, then EXPORT WEBM
```

If you skip `prepare_ref.py` and the reference file, `gen` cannot clone and will fail; the committed `voices.json` already holds
the transcripts used for the 6 CPU takes.

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
  frames). Frames are pushed on the **audio clock** 30×/s, so picture, subtitles and sound cannot drift apart.
* Subtitles are Pixi text inside the frame, so they are part of every exported frame.
* MediaRecorder output has no duration/cue data; `webm-duration-fix` patches it so players can seek.
* Keep the tab visible and the machine awake during the ~5-minute recording (browsers throttle hidden tabs).
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
**CPU is very slow** (see *Status* below); on the RTX 2060 the whole script takes minutes.

| command | purpose |
|---|---|
| `cli.py gen [--lines l005,l026] [--force] [--take N] [--num-step 16]` | OmniVoice only. Raw takes are cached in `audio/raw/<id>__<hash>.wav`; the hash covers text, voice identity and every generation parameter, so only edited lines are re-rendered |
| `cli.py process [--lines …] [--no-align]` | DSP performance, trimming, level matching, multi-voice layers, CTC forced alignment → `public/audio/lines/*.wav` + `manifest.json` |
| `cli.py draft [--lines …]` | offline Windows-SAPI stand-in for every line that has no OmniVoice take (watchable preview, clearly tagged). `process` always prefers an OmniVoice take over a draft |
| `cli.py all` | `gen` + `process` |
| `cli.py probe` | renders one test sentence with different voice-identity strategies and prints pitch / ASR statistics |
| `cli.py mix` | renders the voice-only master track from the timeline (QA/montage) |
| `bun run timeline` | structured timeline → `build/timeline.json` and `.csv` |

**Re-generate a single line**: edit its text/`tts` in `scenario/scenario.json`, or re-roll with a different seed, then
`cli.py gen --lines l005 --force --take 2` and `cli.py process --lines l005`. Nothing else is touched.

### What OmniVoice does natively — and what is DSP

Verified against the installed package (`omnivoice/models/omnivoice.py`) and its docs:

| native to OmniVoice | used here |
|---|---|
| voice cloning from `ref_audio` + `ref_text` (reusable `VoiceClonePrompt`) | all three Azik-based voices (A, B, parody) |
| voice design via `instruct` (gender, age, pitch, accent, `whisper`) | caller accent hint; voice **W** is designed, then anchored |
| `speed` / `duration` | per-line speed, incl. the 1.08 → 1.48 acceleration in the wheel passage |
| non-verbal tags `[laughter]`, `[sigh]`, `[question-*]`, `[surprise-*]`, `[dissatisfaction-hnn]` | `[laughter]` on the laugh lines |
| sampling: `class_temperature`, `position_temperature`, `guidance_scale` | per-mood expressiveness |
| **no emotion control** | emotion is made with: punctuation/pauses in `speak`, speed curves, temperature, and the DSP below |

DSP (`tts/dsp.py`): Praat *Change gender* (pitch median, pitch range = how theatrical, formant ratio = baritone size),
hoarse "grit", low-shelf/presence EQ, compression, vibrato + bit-crush for the parody voice, telephone band-limit,
per-line loudness matching, plus runtime dynamics (crescendo/decrescendo per mood) and phone-vs-close-mic balance
in the Web Audio mix. The multi-voice line renders five layers of the same take with different pitch/formant, delay
and pan, plus a small dark room.

### Voices

`voices/voices.json` defines the profiles. **A** (the caller), **B** (Azik) and **M** (the parody Azik) are cloned from
`voices/refs/azik_ref.ogg` — your own recording. A is pitched down and roughened by DSP; B is untouched; M is pitched up,
wobbled and crushed. **W** (the woman) uses voice design and is anchored through a clone prompt so she stays the same
person. To use other legally obtained references, add a file under `voices/refs/`, register it in `refs`, point a profile
at it and run `python tts/prepare_ref.py` (picks a clean 4-12 s window and transcribes it with Whisper), then `cli.py gen --force`.

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

```powershell
bun test tests                 # timeline, cues, drawings, scenario coverage
& $py -m pytest tests/py -q    # DSP, alignment helpers, cache keys, scenario resolution
bun run typecheck
```

## Notes on the Ukrainian → English dub

* Idioms are translated by sense: "крутитись як білка в колесі" → *spinning like a hamster in that bloody wheel*,
  "іде коту під хвіст" → *down the drain*, "ва-банк" → *all-in*.
* Profanity and the caller's cruelty are preserved. The caller says *Azichok* (spelled phonetically for the model).
* `l043` ("Спочатку тебе, а потім ти всіх") is elliptical in the source; it is rendered as *First it's them running from you…
  then you running from everyone* — change it in `scenario.json` if you meant something else.
* The source line "не міняючи своєї!" is left unfinished on purpose (`l048`), as in the script.
