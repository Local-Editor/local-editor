# 🎬 Local Editor

A complete, fully-local screen/webcam recorder + transcript-driven video editor.
Everything runs on your machine — no cloud, no accounts, no npm dependencies.

## Setup

Prerequisites: **Node 18+**, **Python 3.9+**, **ffmpeg**.

```bash
# ffmpeg — macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg
#          Windows: winget install ffmpeg

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip

npm start                                   # → open http://localhost:4321 in Chrome
```

Or just open this folder in [Claude Code](https://claude.com/claude-code) and
say **"set this up"** — `CLAUDE.md` walks it through everything, and the
bundled `screen-studio` skill automates the whole record → transcribe →
AI-clean → render pipeline from the terminal.

Optional background-music starter pack (CC-BY, from Incompetech):

```bash
.venv/bin/python3 scripts/music.py starter
```

Notes: the Whisper `small` model (~500MB) auto-downloads on your first
transcription. Encoding uses the Mac hardware encoder when available and falls
back to libx264 elsewhere. The server binds to localhost only (`PORT`/`HOST`
env vars override).

Leave the terminal running while you use it. Recordings and renders are saved
under `recordings/<session>/`.

Three pages, top nav: **Record · Edit · Renders**.

---

## 1 · Record  (`/`)

Pick a mode:
- **🎥+🖥 Webcam and screen** — screen with a movable webcam bubble on top.
- **🖥 Screen only** — screen + your mic (voiceover, no camera).
- **🎥 Webcam only** — talking-head, camera fills the frame.

Mic defaults to the **MacBook built-in** (not the iPhone); your last-used mic is
remembered. The webcam bubble is drag-to-move and **resizable from any edge or
corner**. Full-screen captures hide the live preview to avoid the
infinity-mirror; your own recorder tab is excluded from the picker.

Hit Record → 3-2-1 countdown → Stop. Files saved separately (raw `screen.webm`
/ `webcam.webm` are never modified). Then "Composite + transcribe" prepares it
for editing.

## 2 · Edit  (`/editor.html`)

Left = video preview + controls. Right = the **transcript**. Bottom = the
**timeline dock**.

**Transcript editing**
- Click a word to jump there; click it twice to cut it; shift-click a range.
- Double-click to fix a word's text. Orange chips = long pauses.
- Drag across words to **select**, then right-click: cut / restore /
  **new edit session from selection** / **render only this part**.
- **✨ AI clean-up** removes umms/ahs, stutters, repeated takes, false starts.
  Whatever Whisper won't transcribe shows as clickable `(um?)` markers.
- 📋 Copy transcript.

**Timeline (a real multi-track NLE)**
- Playhead moves continuously; click anywhere (footage, gaps, any lane) to seek.
- **✂ scissor** splits footage at the playhead; drag pieces to rearrange
  (gaps render as black; drag before the start to extend the front).
- Right-click: **record an insert here**, **insert a video/audio file**,
  **📼 add from another edit**, add/remove timelines.
- **Inserts are overlays** — they play *on top* of the footage; drag/resize
  them in the preview to frame them anywhere.
- **Drag a block = move · ⇧-drag = select a range to cut · drag a block's
  edge = trim.** 🧲 **Snap** button toggles snapping to clip edges + word
  boundaries (green guide line).
- Select a timeline (turns blue) to scope cuts to it.
- **Webcam bubble is per-piece**: cut the footage, then drag/resize the bubble
  for each piece — it holds for that piece (cyan corner tag marks custom ones).

**Render**
- Format: Original 16:9, or **9:16 / 1:1 Shorts** (webcam-top, screen-top,
  bubble-overlay). Live preview updates when you pick a format.
- Quality: High / Balanced / Small. Uses the Mac's hardware encoder (fast).
- 🎵 Background music from the built-in library (auto-ducked under your voice).
- Progress shows as a % bar; resumes if you reload mid-render.

## 3 · Renders  (`/renders.html`)

Every finished video across all sessions, newest first, with previews +
downloads. ⋮ menu to rename or delete. Double-click a name to rename the
recording (applies everywhere) or a specific render.

---

## Automation (Claude Code)

The `screen-studio` skill runs the whole pipeline from the terminal — e.g.
"clean up my latest screen recording", "tighten it, remove the umms, render".
Claude also does a deeper semantic clean-up pass (rambling, reworded retakes).

Whisper models: `small` is the default; `large-v3-turbo` is installed for
maximum accuracy (catches more umms + missed words).

## Layout on disk

```
server.js            zero-dependency Node server (UI, uploads, ffmpeg jobs)
public/              record + edit + renders UI (no build step)
scripts/             composite · transcribe · enhance · render · reframe ·
                     addmusic · music · subsession · migrate_edits · common
.claude/skills/      the screen-studio skill for Claude Code automation
.venv/               python env (faster-whisper, numpy) — created at setup
music/               CC-BY track library + catalog — fetched by music.py
recordings/          one folder per session (edit state lives in transcript.json)
```

The single source of truth for an edit is `recordings/<session>/transcript.json`
(words + cuts + segments + inserts + per-piece webcam + cutRanges). Delete a
`clean*.mp4` and re-render anytime; nothing is destructive to the raw files.
