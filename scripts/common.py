"""Shared helpers for Screen Studio scripts."""
import json
import math
import os
import signal
import subprocess
import sys
import zlib
import struct
from pathlib import Path


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def video_stream(info):
    return next((s for s in info["streams"] if s["codec_type"] == "video"), None)


def has_audio(info):
    return any(s["codec_type"] == "audio" for s in info["streams"])


def _packet_end(path, select):
    """End time of the last packet of a stream, or 0 if it has none."""
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", select, "-show_entries",
         "packet=pts_time,duration_time", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout.strip().splitlines()
    if not out:
        return 0.0
    parts = (out[-1].split(",") + [""])[:2]
    try:
        end = float(parts[0])
    except ValueError:
        return 0.0
    try:
        end += float(parts[1])              # packet duration, when known
    except ValueError:
        pass
    return end


def stream_has_alpha(vs):
    """True when the video stream carries an alpha channel (ProRes 4444,
    VP9-alpha webm, PNG-style formats). VP9 hides it behind a tag."""
    if not vs:
        return False
    if vs.get("pix_fmt", "").startswith(("yuva", "rgba", "argb", "bgra", "gbrap")):
        return True
    tags = {k.lower(): v for k, v in (vs.get("tags") or {}).items()}
    return tags.get("alpha_mode") == "1"


def duration_of(path):
    """Container duration; falls back to decoding (MediaRecorder webm often
    has no duration header)."""
    info = ffprobe(path)
    d = info.get("format", {}).get("duration")
    if d and float(d) > 0:
        return float(d)
    for s in info.get("streams", []):        # some containers carry it per-stream
        try:
            if float(s.get("duration") or 0) > 0:
                return float(s["duration"])
        except ValueError:
            pass
    # Last resort: read packet timestamps. Try video first, then audio — a
    # mic-only recording (screen-only mode) has no video stream at all, and
    # asking for v:0 there silently returned 0 and wrecked the edit downstream.
    for sel in ("v:0", "a:0"):
        end = _packet_end(path, sel)
        if end > 0:
            return end
    return 0.0


def exit_on_sigterm():
    """Cancelling a job SIGTERMs its whole process group. Python's default is
    to die on the spot, skipping every `finally` — which is where half-written
    outputs get removed. Exit through them instead."""
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


def build_then_swap(final, build):
    """Run `build(tmp_path)` and move the result over `final` only once it
    succeeds. A build that is cancelled or fails part-way otherwise leaves a
    perfectly valid, too-SHORT file under the real name — and the next render
    reuses it without a word. The temp name keeps the .mp4 extension (ffmpeg
    picks the muxer from it) and a leading dot (the UI lists no such file)."""
    final = Path(final)
    tmp = final.with_name(f".{final.stem}.building{final.suffix}")
    try:
        result = build(tmp)
        os.replace(tmp, final)
        return result
    finally:
        tmp.unlink(missing_ok=True)


def run_ffmpeg(args):
    cmd = ["ffmpeg", "-hide_banner", "-y"] + args
    print("+", " ".join(str(a) for a in cmd), flush=True)
    subprocess.run(cmd, check=True)


def even(n):
    n = int(round(n))
    return n if n % 2 == 0 else n + 1


_encoders = None


def _has_encoder(name):
    global _encoders
    if _encoders is None:
        _encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                                   capture_output=True, text=True).stdout
    return name in _encoders


# Keyframe interval, in frames (2s at 30fps). Left unset, ffmpeg hands
# VideoToolbox its generic default of 12 — a full keyframe every 0.4s, which
# spends most of the bitrate re-sending a screen that barely changes. libx264
# and libx265 pick their own (longer) interval and don't need it.
GOP = "60"

# quality tier -> (videotoolbox h264 -q:v, libx264 -crf,
#                  videotoolbox hevc -q:v, libx265 -crf)
# Calibrated by SSIM against the source on real screen recordings: with the 2s
# keyframe interval each tier is sharper AND 12-20% smaller than the old
# 0.4s-keyframe tiers (72/60/46), and the H.265 column is ~30% smaller than
# the H.264 one while still beating the old two-pass "compress" output.
QUALITY = {"high": ("80", "16", "74", "18"),
           "balanced": ("75", "19", "68", "21"),
           "small": ("62", "24", "60", "26")}


def encode_args(quality="balanced", hevc=False):
    """Video+audio encode settings. Prefers Apple's hardware encoder
    (VideoToolbox Media Engine, constant-quality mode) — 5-10x faster than
    libx264 on M-series; bitrate adapts to content so static screen shares
    stay small. hevc=True encodes H.265 instead: ~30% fewer bytes for
    near-identical quality (the "compress to save space" option)."""
    vt264, x264, vt265, x265 = QUALITY.get(quality, QUALITY["balanced"])
    if hevc:
        if _has_encoder("hevc_videotoolbox"):
            video = ["-c:v", "hevc_videotoolbox", "-q:v", vt265, "-g", GOP]
        else:
            video = ["-c:v", "libx265", "-preset", "medium", "-crf", x265]
        # the hvc1 tag keeps the track playable in QuickTime / Finder / Safari
        video += ["-tag:v", "hvc1"]
    elif _has_encoder("h264_videotoolbox"):
        video = ["-c:v", "h264_videotoolbox", "-q:v", vt264, "-g", GOP]
    else:
        video = ["-c:v", "libx264", "-preset", "veryfast", "-crf", x264]
    return video + ["-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]


def hevc_args():
    """H.265 re-encode of a finished file at the balanced tier (compress.py).
    Audio is copied, not re-encoded — a second AAC pass would degrade it for
    no space win."""
    if _has_encoder("hevc_videotoolbox"):
        video = ["-c:v", "hevc_videotoolbox", "-q:v", QUALITY["balanced"][2], "-g", GOP,
                 "-pix_fmt", "yuv420p"]
    else:
        video = ["-c:v", "libx265", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    return video + ["-tag:v", "hvc1", "-c:a", "copy", "-movflags", "+faststart"]


def write_rounded_mask_png(path, w, h, radius_pct):
    """Grayscale PNG rounded-rect alpha mask, stdlib only (no PIL).
    radius_pct matches the CSS border-radius % from the recorder UI:
    50% on a square box = circle. The curved edge is anti-aliased (alpha =
    how much of each pixel lies inside the curve) — a hard 0/255 cut-off
    makes the webcam bubble's rounded corners visibly staircased."""
    r = max(0.0, min(50.0, float(radius_pct))) / 100.0 * min(w, h)
    full = b"\x00" + b"\xff" * w                # filter byte + an all-opaque row
    rows = bytearray()
    for y in range(h):
        py = y + 0.5                              # pixel centre
        cy = r if py < r else (h - r if py > h - r else None)
        if cy is None:
            rows += full
            continue
        row = bytearray(b"\xff" * w)
        dy = py - cy
        for x in range(w):
            px = x + 0.5
            cx = r if px < r else (w - r if px > w - r else None)
            if cx is None:
                continue
            cover = r + 0.5 - math.hypot(px - cx, dy)
            row[x] = 255 if cover >= 1 else 0 if cover <= 0 else int(cover * 255 + 0.5)
        rows += b"\x00" + row

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
           + chunk(b"IEND", b""))
    Path(path).write_bytes(png)


def normalize_audio_timeline(path):
    """Rewrite `path`'s audio so its TIMESTAMPS follow its SAMPLES exactly.

    The two ways this pipeline addresses audio have to agree. render.py picks
    keep-spans with atrim/select, which address audio by timestamp, while
    transcribe.py reads the mic by decoding it straight through, which
    addresses it by sample order. Encoding a composite can leave those
    disagreeing — measured on a real recording, the finished composite's audio
    timestamps ran 1.2s behind its samples, so every cut landed 1.2s late and
    the render lost its opening words ("Hey Ian, I figured…").

    Round-tripping the audio through PCM rebuilds a stream where the two are
    identical. The video is stream-copied, so this costs a file pass and no
    picture quality. Idempotent — safe to run on an already-clean file."""
    p = Path(path)
    if not has_audio(ffprobe(p)):
        return
    pcm = p.with_name(p.stem + ".autmp.wav")
    fixed = p.with_name(p.stem + ".autmp.mp4")
    try:
        run_ffmpeg(["-i", str(p), "-vn", "-c:a", "pcm_s16le",
                    "-ar", "48000", "-ac", "2", str(pcm)])
        run_ffmpeg(["-i", str(p), "-i", str(pcm), "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", str(fixed)])
        fixed.replace(p)
    finally:
        for t in (pcm, fixed):
            if t.exists():
                t.unlink()


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    return json.loads(p.read_text())


def write_json(path, obj):
    """Write JSON beside `path` and rename it into place: a reader (the server,
    an open editor) never sees half a file, and a crash keeps the old one."""
    p = Path(path)
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    os.replace(tmp, p)


def update_json(path, key, value):
    """Set one top-level key of a JSON file, keeping every other key as it is
    on disk NOW rather than when this script started — the server edits
    meta.json (titles, render names) while long jobs run. None removes it."""
    data = load_json(path, {}) or {}
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value
    write_json(path, data)


def migrate_edits(old, new):
    """Carry manual edits from an old transcript onto a re-transcription of
    the same audio. Words re-tokenize but the TIMELINE is identical, so:
      - removed words  -> new words whose midpoint falls in an old removed span
      - keepGapAfter   -> nearest new word ending within 0.5s
      - edited text    -> only when the word interval matches near-exactly
    Returns a summary dict."""
    new_words = new["words"]
    stats = {"removed": 0, "keepGapAfter": 0, "edited": 0}

    removed_spans = [(w["start"], w["end"], w.get("reason"))
                     for w in old.get("words", []) if w.get("removed")]
    for w in new_words:
        mid = (w["start"] + w["end"]) / 2
        for a, b, reason in removed_spans:
            if a - 0.05 <= mid <= b + 0.05:
                if not w.get("removed"):
                    w["removed"] = True
                    w["reason"] = reason or "manual"
                    stats["removed"] += 1
                break

    for t in [w["end"] for w in old.get("words", []) if w.get("keepGapAfter")]:
        cand = min(new_words, key=lambda w: abs(w["end"] - t), default=None)
        if cand and abs(cand["end"] - t) < 0.5 and not cand.get("keepGapAfter"):
            cand["keepGapAfter"] = True
            stats["keepGapAfter"] += 1

    for ow in old.get("words", []):
        if ow.get("edited"):
            cand = min(new_words,
                       key=lambda w: abs(w["start"] - ow["start"]) + abs(w["end"] - ow["end"]),
                       default=None)
            if cand and abs(cand["start"] - ow["start"]) < 0.15 \
                    and abs(cand["end"] - ow["end"]) < 0.15 and not cand.get("detected"):
                cand["w"] = ow["w"]
                cand["edited"] = True
                stats["edited"] += 1

    if old.get("settings"):
        new.setdefault("settings", {}).update(old["settings"])
    if old.get("cutRanges"):
        new["cutRanges"] = sorted(set(map(tuple, (new.get("cutRanges") or []))) |
                                  set(map(tuple, old["cutRanges"])))
        new["cutRanges"] = [list(r) for r in new["cutRanges"]]
    if old.get("inserts") and not new.get("inserts"):
        new["inserts"] = old["inserts"]
    if old.get("camLayouts") and not new.get("camLayouts"):
        new["camLayouts"] = old["camLayouts"]
    if old.get("segments") and not new.get("segments"):
        new["segments"] = old["segments"]
    if old.get("tracks") and not new.get("tracks"):
        new["tracks"] = old["tracks"]
    return stats


def clean_time(t, segs):
    """Map a time on the ORIGINAL timeline to the post-cut (clean) timeline."""
    return sum(min(b, max(a, t)) - a for a, b in segs if a < t)


def keep_segments(transcript):
    """Word cuts -> list of (start, end) keep spans on the ORIGINAL timeline.
    Mirrors keepSegments() in public/editor.js — keep the two in sync.

    A removed word ALWAYS forces a cut (even a short um), with the pad
    clamped so it can't leak the removed audio back in. Silences longer
    than maxGapSec are collapsed unless keepGapAfter is set."""
    settings = transcript.get("settings") or {}
    pad = float(settings.get("padSec", 0.12))
    max_gap = float(settings.get("maxGapSec", 1.0))
    words = transcript["words"]
    kept_idx = [i for i, w in enumerate(words) if not w.get("removed")]
    if not kept_idx:
        return []

    segs = []
    first = words[kept_idx[0]]
    a = max(0.0, first["start"] - pad)
    b = first["end"] + pad
    # everything before the first kept word is removed — don't pad into it
    if kept_idx[0] > 0:
        a = max(a, words[kept_idx[0] - 1]["end"])
    prev_i = kept_idx[0]
    for i in kept_idx[1:]:
        w, prev = words[i], words[prev_i]
        removed_between = [words[k] for k in range(prev_i + 1, i)]
        gap = w["start"] - prev["end"]
        if removed_between:
            segs.append((a, min(b, removed_between[0]["start"])))
            a = max(w["start"] - pad, removed_between[-1]["end"])
            b = w["end"] + pad
        elif gap > max_gap and not prev.get("keepGapAfter"):
            segs.append((a, b))
            a = max(0.0, w["start"] - pad)
            b = w["end"] + pad
        else:
            b = w["end"] + pad
        prev_i = i
    # ...and everything after the last kept word is removed too
    if prev_i + 1 < len(words):
        b = min(b, words[prev_i + 1]["start"])
    segs.append((a, b))

    # Manual time-range cuts from the editor timeline (e.g. trimming a
    # wordless head/tail) are subtracted from whatever the words kept.
    for ca, cb in transcript.get("cutRanges") or []:
        nxt = []
        for x, y in segs:
            if cb <= x or ca >= y:
                nxt.append((x, y))
                continue
            if ca > x:
                nxt.append((x, ca))
            if cb < y:
                nxt.append((cb, y))
        segs = nxt
    return [(s, e) for s, e in segs if e - s > 0.02]
