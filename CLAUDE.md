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

Optional: **rclone**, only for the Google Drive archive (Edit/Renders tabs).
Don't install it unprompted — it's off by default and nothing else uses it.
If the user asks for the archive, check `rclone listremotes` first; `rclone
config` is interactive (browser OAuth), so hand that step to the user rather
than trying to drive it:

```bash
brew install rclone      # apt install rclone · winget install Rclone.Rclone
rclone config            # user does this — add a Drive remote named "gdrive"
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
  `subsession.py`, `subtitles.py`, `migrate_edits.py`, `archive.py`, shared
  helpers in `common.py`).
- `scripts/archive.py` moves media to Google Drive via rclone and back, either a
  whole session (Edit tab) or single files (`--files`, used by the Renders
  page). Four rules it must keep: **verify before deleting** (`rclone check`
  passes, then the local files go), **write `meta.json['archive']` before
  unlinking** (a crash mid-delete must still know where the media went),
  **merge, never replace, `archive.files`** (archiving a session after one
  render was archived alone must not forget that render — it would orphan the
  Drive copy), and **only media moves** — the sidecars stay so the session is
  still listed and its edit survives. `archive.files` is a per-file map
  `{name: {size, at}}`; a session is *fully* archived only when that map is
  non-empty AND no media is left on disk (`archive.whole` in `/api/sessions`),
  which is what gates the editor's offline banner. Partly-archived sessions must
  keep playing and rendering. rclone needs `--stats-log-level NOTICE` or the
  progress line never appears (stats log at INFO, default level is NOTICE) —
  don't reach for `-v`, the INFO flood has starved a transfer here before.
  Settings live in `archive-config.json` (gitignored); the auto-sweep runs from
  `server.js` on a 30-min timer and is off until switched on. Two cutoffs, two
  scopes: `olderThanDays` drives the Edit tab's automatic whole-recording sweep
  (**all** media, raw `screen.webm`/`webcam.webm` included), while
  `rendersOlderThanDays` drives the Renders page's manual bulk button, which
  only ever touches `renderKind()` outputs and leaves raw footage alone. The
  bulk button groups eligible files **by session** before calling `/api/archive`
  — one job runs per session, so two renders in one recording must go in a
  single `--files` pass or the second request is rejected.
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
