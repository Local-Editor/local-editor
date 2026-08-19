# Local Editor — setup & orientation

A fully-local screen/webcam recorder + transcript-driven video editor.
Node serves the UI (zero npm dependencies); Python scripts do the heavy
lifting (ffmpeg composites/renders, faster-whisper transcription).

## First-time setup (do this for the user if anything is missing)

Prerequisites: **Node 18+**, **Python 3.9+**, **ffmpeg** (with ffprobe).

```bash
# 1. ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg
#            · Windows: winget install ffmpeg)
ffmpeg -version

# 2. Python venv with the transcription deps
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip

# 3. Start it
npm start                                        # → http://localhost:4321
```

Optional: fetch the CC-BY background-music starter pack (needed before the
editor's music dropdown has anything in it):

```bash
.venv/bin/python3 scripts/music.py starter
```

Notes:
- The Whisper model (~500MB for `small`) auto-downloads on the first
  transcription — warn the user the first run is slow.
- Encoding uses macOS VideoToolbox when available and falls back to libx264
  everywhere else; nothing to configure.
- The server binds to 127.0.0.1 only. `PORT` and `HOST` env vars override.
- Recordings live in `recordings/<session>/` (gitignored — personal data).

## Working in this codebase

- `server.js` — single-file HTTP server; API routes + static serving. No
  framework, no npm deps: keep it that way.
- `public/` — recorder (`index.html`+`recorder.js`), editor
  (`editor.html`+`editor.js`), renders gallery (`renders.html`). No build step.
- `scripts/` — Python pipeline: `composite.py` → `transcribe.py` →
  `enhance.py` → `render.py` (+ `reframe.py`, `addmusic.py`, `music.py`,
  `subsession.py`, `subtitles.py`, `migrate_edits.py`, shared helpers in
  `common.py`).
- `recordings/<session>/transcript.json` is the single source of truth for an
  edit. Raw `screen.webm`/`webcam.webm` are never modified by anything.
- `keep_segments()` in `scripts/common.py` mirrors `keepSegments()` in
  `public/editor.js` — if you change one, change the other.
- Subtitles are inserts of `kind: "subtitle"` on their own timeline. The
  editor's 💬 button builds them from the transcript; `scripts/subtitles.py`
  draws them with Pillow (ffmpeg is never asked to render text — plenty of
  builds ship without libass/libfreetype) and `render.py` overlays the result.
  The look/size/margin numbers are duplicated in `.cap-overlay` in
  `public/style.css` so the editor preview matches the render — a third
  mirrored pair, same rule as above.
- Each caption carries `words: [{w, s, e}]` in timeline time, which drives the
  spoken-word highlight (one rendered frame per word). That list MUST stay in
  step with the caption's `text`: both sides check the counts match and fall
  back to drawing the caption unhighlighted rather than lighting the wrong
  word. Retyping a caption re-spaces the list (`respaceCueWords`).

The `.claude/skills/screen-studio` skill in this repo automates the whole
record → transcribe → clean → render pipeline; use it for editing tasks.
