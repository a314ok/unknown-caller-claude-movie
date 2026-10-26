# Sound-effect assets

| file | source | licence |
|------|--------|---------|
| `scream.wav` | 2nd of four screams in "Female high-pitched scream SFX" (`screams.ogg`) by **WuxiaScrub**, https://opengameart.org/content/female-high-pitched-scream-sfx (posted 2021-10-10) | **CC0 1.0** (public domain dedication, no attribution required; credited here anyway) |

`_src/screams.ogg` is the untouched download. Everything else you hear besides the voices (ring, line hum, breath, heartbeat,
clicks, static) is synthesised live in `src/audio/engine.ts`.

To swap the scream: drop another mono/stereo WAV in as `scream.wav` and run `python tts/cli.py process --lines l040`.
