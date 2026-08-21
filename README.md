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

Optional — only if you want the **Google Drive archive** (moving old recordings
off your disk, see below). Nothing else needs it, and it stays off until you
switch it on:

```bash
brew install rclone      # apt install rclone · winget install Rclone.Rclone
rclone config            # add a Google Drive remote, name it "gdrive"
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

**⏸ Pause** (or press **P**) stops the recording without ending it. The paused
stretch is left out of the file entirely rather than recorded as a freeze, so
there is nothing to trim afterwards — take a breath, find a tab, then Resume.
The timer freezes in amber while paused and counts only recorded time.

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
  **📼 add from another edit**, **🗑 delete a footage piece** (after a
  scissor split), add/remove timelines.
- **⌘Z / ⇧⌘Z** (Ctrl on Windows/Linux) undo / redo any edit — word cuts,
  range cuts, splits, moves, trims, deletes.
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
- 💬 **Subtitles in one click**: "Add subtitles" reads the transcript and drops
  a caption clip onto a Subtitles timeline for every phrase you kept. Drag,
  trim, duplicate or right-click one to retype it, like any clip. Three looks
  (outline / boxed / bold yellow caps), three sizes, top / middle / bottom —
  previewed live over the player and **burned into the render**. Cut something
  afterwards and the button turns orange to offer a rebuild.
  - **Words at once** sets how much text is on screen: 1–6 for the fast
    one-or-two-word look, or "Full phrase" to break on pauses and sentence
    ends. Changing it re-chunks the captions straight away.
  - **Highlight spoken word** lights the word being said and fades the rest.
    The timing comes from the transcript's per-word timestamps, so the
    highlight stays on the right word through cuts and rearranged footage.
- 🎵 Background music is a **timeline track**: pick a track (▶ 30s to preview),
  hit "Add to timeline" and it lands as a clip on a Music lane at the playhead —
  drag/trim it like any clip. At render it's mixed **ducked under your voice**.
- **Overlay assets**: drop `asset-*.webm` (transparent VP9) or `asset-*.mp4`
  files into any session folder — they show on the Renders page and in the
  timeline's 📼 picker, and **transparency survives into the final render**.
- Progress shows as a % bar with stage labels and a ✕ Cancel button; resumes
  if you reload mid-render.

### Deleting a recording

The 🗑 on each row of the **Edit** tab's picker deletes a whole recording —
video, transcript, every render of it, and its Google Drive copy if it was
archived. It asks twice and names the size first, since it can be gigabytes and
there is no undo. Two cases it refuses outright: while a job is still running,
and when another recording plays this one as a timeline insert (deleting it
would leave that edit with missing footage) — that one can be overridden.

## 3 · Renders  (`/renders.html`)

Every finished video across all sessions, newest first, with previews +
downloads. ⋮ menu to rename, archive or delete a single render. Double-click a
name to rename the recording (applies everywhere) or a specific render.

**☁ Archive to Google Drive** in the ⋮ menu moves that one finished video to
Drive and frees the space — handy once a render is delivered but you don't want
to throw it away. The card stays on the page as a cloud placeholder with
**⬇ Restore from Drive**; deleting an archived card removes the Drive copy too.

The bar at the top does it in bulk: **☁ Archive renders older than N day(s)**
(7 by default) counts what qualifies, and one button clears the lot with a live
% bar. Renders in the same recording go up in a single pass.

Both only ever touch **finished renders** — `clean*.mp4`, `*-music.mp4`,
`composite.mp4`, `asset-*`. The raw `screen.webm` / `webcam.webm` they came from
are never archived from this page; use the Edit tab for those.

---

## ☁ Google Drive archive

Recordings pile up fast. The panel at the top of the **Edit** tab moves old ones
to Google Drive with [rclone](https://rclone.org/) and frees the space here —
while keeping every recording listed and one click from editable again.

- **☁ Archive** on any row uploads that recording's video, **verifies it on
  Drive**, then deletes the local copy. Only the media moves: `transcript.json`,
  `meta.json`, `layout.json` and the masks stay put, so the session keeps its
  title, its transcript and all your cuts.
- Single files can go too — see the ⋮ menu on the **Renders** page. A recording
  with only some files on Drive shows `☁ 2 on Drive` and still plays and renders
  normally; **⬇ Restore** fetches back everything it has up there.
- **⬇ Restore** downloads the video back and the session is fully editable
  again. Opening an archived recording shows the same offer as a banner over the
  player, with rendering disabled until the footage is back.
- **Auto-archive** (off by default) sweeps every 30 minutes and archives any
  recording whose video has sat untouched longer than the cutoff — 1 day out of
  the box, editable in the box next to the toggle. Re-rendering or re-recording
  resets that clock for the whole session.
- Progress is a live % bar: overall across the batch, plus the current
  recording's own upload percentage and stage.

Setup is the optional rclone step from the top of this README — a remote named
`gdrive`. Without it the panel just reports that rclone isn't configured, and
nothing else in the app is affected.

Files land in `gdrive:Local Editor Archive/<session>/`. Change the remote (or
the cutoff) in `archive-config.json`, written next to `server.js` the first time
you touch the settings. Uploads run one file at a time with retries, so each
finished file is committed to Drive before the next starts.

Restoring leaves the Drive copy in place rather than deleting it — a restored
recording is still backed up, and re-archiving it later just overwrites. Use
**Delete render** (or `rclone delete`) if you want the Drive space back.

Two things are deliberately never archived automatically: recordings newer than
the cutoff, and any recording another session pulls a timeline **insert** from —
archiving those would pull footage out from under an edit that is still using it.

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
                     addmusic · music · subsession · subtitles ·
                     migrate_edits · archive · common
.claude/skills/      the screen-studio skill for Claude Code automation
.venv/               python env (faster-whisper, numpy, pillow) — made at setup
music/               CC-BY track library + catalog — fetched by music.py
recordings/          one folder per session (edit state lives in transcript.json)
```

The single source of truth for an edit is `recordings/<session>/transcript.json`
(words + cuts + segments + inserts + per-piece webcam + cutRanges). Delete a
`clean*.mp4` and re-render anytime; nothing is destructive to the raw files.
