---
name: screen-studio
description: >
  Local screen + webcam recording studio: record via the browser UI, then
  transcribe, AI-clean (remove umms/ahs, long gaps, stutters, repeated
  sentences/retakes, false starts) and render a tightened video — all locally.
  PROACTIVELY activate for: "start screen studio", "record my screen",
  "clean up my screen recording", "remove the umms from my recording",
  "tighten my last recording", "transcribe my screen recording",
  "render the clean version". Works on session folders under
  recordings/.
---

# Local Editor (screen studio)

All code lives in this repo's root (call it `$STUDIO` below).
Python: `$STUDIO/.venv/bin/python3` (has faster-whisper).
Everything runs locally — no cloud services. If `.venv` doesn't exist yet,
follow the setup steps in `CLAUDE.md` first.

## Session folder anatomy (`$STUDIO/recordings/<session>/`)

| file | what |
|---|---|
| `screen.webm` | raw screen recording (never modified) |
| `webcam.webm` | raw webcam + mic recording (never modified) |
| `layout.json` | webcam overlay position/size/shape as arranged in the recorder |
| `meta.json` | start-time sync offset, screen size |
| `composite.mp4` | screen with webcam overlaid (editor plays this) |
| `transcript.json` | word-level transcript + cut marks (the edit state) |
| `clean.mp4` | final tightened render |

## Commands

**Start the studio (recorder + transcript dashboard):**
```bash
node "$STUDIO/server.js"   # → http://localhost:4321  (run in background)
```
Recorder at `/`, transcript editing dashboard at `/editor.html`.

**Find the latest session:** newest directory in `$STUDIO/recordings/`.

**Full pipeline on a session (composite → transcribe → auto-clean → render):**
```bash
PY="$STUDIO/.venv/bin/python3"; S="$STUDIO/recordings/<session>"
"$PY" "$STUDIO/scripts/composite.py"  "$S"
"$PY" "$STUDIO/scripts/transcribe.py" "$S" --model small  # default; large-v3-turbo = best, ~1.6GB download
# transcribe primes Whisper to keep umms verbatim, and inserts "(um?)" markers
# (detected:true) for audible gap sounds Whisper refused to write — enhance.py
# auto-cuts the short ones. It backs up any existing transcript.json first.
"$PY" "$STUDIO/scripts/enhance.py"    "$S"                # heuristic pass
"$PY" "$STUDIO/scripts/render.py"     "$S"                # → clean.mp4
```
Each step is idempotent and skippable if its output already exists (but
re-run render after any transcript change).

## Semantic clean-up pass (this is YOUR job, Claude)

`enhance.py` only catches mechanical problems. After it runs, do the deeper
pass yourself:

1. Read `transcript.json`. Words look like
   `{"w":"Hello","start":1.2,"end":1.5,"removed":false,"reason":null,"keepGapAfter":false}`.
2. Reconstruct the spoken text from non-removed words and look for:
   - **retakes** the heuristic missed (same idea re-recorded with different
     wording — cut the *earlier, weaker* take, keep the later one)
   - **abandoned thoughts / rambling tangents** that never land
   - **redundant restatements** ("so basically, in other words…")
   - filler *phrases*: "you know", "sort of", "kind of like", "I mean" when
     they carry no meaning (judge from context, don't blanket-remove)
3. Mark cuts by setting `removed: true` and `reason: "semantic"` on those
   words. **Never delete words from the array, never change timings, never
   un-remove existing cuts** (they may be manual edits from the dashboard).
4. Write the file back, then run `render.py`.
5. Tell the user what you cut and the before/after duration (render.py prints
   both). If a judgement call is borderline, leave it in and mention it —
   they can strike it in the dashboard (editor.html) themselves.

Long pauses need no marking: render collapses silences > `settings.maxGapSec`
(default 1.0s) automatically. Tighten pacing by lowering it (e.g. 0.6).

## Background music (all local, CC-licensed)

Library at `$STUDIO/music/` (fetch the chill starter pack with
`music.py starter`). `music.py` searches the Incompetech catalog (1400+ Kevin
MacLeod tracks, CC-BY 4.0 — attribution auto-recorded); `addmusic.py` lays a
track under the video, sidechain-ducked beneath the voice, and writes the
credit line to the session's `credits.txt`:

```bash
"$PY" "$STUDIO/scripts/music.py" starter                  # one-time starter pack
"$PY" "$STUDIO/scripts/music.py" search calming relaxed   # find tracks
"$PY" "$STUDIO/scripts/music.py" get "Deliberate Thought" # download into library
"$PY" "$STUDIO/scripts/music.py" list
"$PY" "$STUDIO/scripts/addmusic.py" "$S" --track Wallpaper.mp3 --gain -21
#   → clean-music.mp4 (or composite-music.mp4); --gain -24 subtle / -17 present
```
Remind the user to paste `credits.txt` into the video description (CC-BY
tracks require it; Pixabay/user tracks imported via `music.py add` may not).

## Whisper models

`small` is the default (auto-downloads on first transcription). Use
`large-v3-turbo` for maximum accuracy (catches more umms + missed words):
`transcribe.py <session> --model large-v3-turbo` (~1.6GB download, slower on
CPU, worth it for recordings that matter).

## Rules

- NEVER modify or delete `screen.webm` / `webcam.webm` — the raw individual
  files must be kept.
- `transcript.json` is the single source of truth for edits; the dashboard
  and the scripts both read/write it, so re-render after editing either way.
- Final videos land next to the session folder's other files.
