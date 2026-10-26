# Reference recordings (not in git)

The reference voice is a personal recording and is deliberately **not committed** (this repository is public).
Put your own, legally obtained recording here before generating voices:

```
voices/refs/azik_ref.ogg      # any length; wav/ogg/mp3 readable by soundfile
```

Then create the prompts (decode, pick the cleanest 4-12 s window, transcribe with Whisper):

```powershell
& $py tts\prepare_ref.py --asr openai/whisper-large-v3-turbo     # writes voices/refs/azik_clip.wav + transcript into voices.json
```

`voices.json` -> `refs.azik` keeps two prompts: `clip`/`text` (short, 4 s, for slow CPU drafts) and `full` (10.6 s, used
automatically on CUDA or with `--ref full`). Check/edit the transcripts: a correct `text` makes the clone noticeably better.
The 4 s prompt is the first 4.0 s of the full clip (`ffmpeg -t 4` or `soundfile` slice) with its matching transcript.
