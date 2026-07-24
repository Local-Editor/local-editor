#!/usr/bin/env python3
"""Compress a session's edit files in place to reclaim disk space.

- .webm raw recordings (screen.webm / webcam.webm): re-encoded VP9 at CRF.
  MediaRecorder's real-time VP9 is bloated — an offline pass typically shrinks
  it 2-3x with no visible loss. Audio is copied.
- .mp4/.mov (composite + renders): visually-lossless H.265 (hevc_videotoolbox).

Every file keeps its exact duration, fps and resolution, and its NAME (screen.webm
stays screen.webm) so transcribe/composite still work. A file is only replaced when
the re-encode is actually smaller AND its duration still matches — otherwise the
original is left untouched. Results are recorded in meta.json['compressed'] so a
file is never compressed twice. Shared assets, masks and sidecars are skipped.

Usage: compress.py <session-dir>
"""
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import run_ffmpeg, duration_of, ffprobe, video_stream, hevc_args, load_json


def _save_meta(d, meta):
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


def _compress_webm(src, dst):
    # VP9 keeps the .webm container valid for the rest of the pipeline; row-mt +
    # good deadline keep it a few x realtime. Opus audio copied (no re-encode).
    run_ffmpeg(["-i", str(src), "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
                "-deadline", "good", "-cpu-used", "3", "-row-mt", "1",
                "-c:a", "copy", str(dst)])


def _compress_mp4(src, dst):
    run_ffmpeg(["-i", str(src)] + hevc_args() + [str(dst)])


def _is_hevc(f):
    try:
        vs = video_stream(ffprobe(f))
        return bool(vs) and vs.get("codec_name") == "hevc"
    except Exception:
        return False


def main():
    d = Path(sys.argv[1])
    if not d.is_dir():
        sys.exit(f"no such session: {d}")
    meta = load_json(d / "meta.json") or {}
    done = meta.get("compressed") or {}

    targets = []
    for f in sorted(d.iterdir()):
        if not f.is_file():
            continue
        n = f.name
        # already handled, shared library assets, masks, sidecars — leave alone
        if n in done or n.startswith("asset-") or n.startswith("mask-") or n.startswith("."):
            continue
        ext = f.suffix.lower()
        if ext == ".webm":
            targets.append((f, "webm"))
        elif ext in (".mp4", ".mov"):
            targets.append((f, "mp4"))

    total = len(targets)
    print(f"compressing {total} file(s)", flush=True)
    if not total:
        print("nothing to compress — already done", flush=True)
        return

    for i, (f, kind) in enumerate(targets, 1):
        print("»stage compress", flush=True)
        print(f"[{i}/{total}] {f.name}…", flush=True)
        before = f.stat().st_size

        # mp4 already H.265 (e.g. rendered with "compress to save space") — no win
        if kind == "mp4" and _is_hevc(f):
            done[f.name] = {"before": before, "after": before, "already": True}
            meta["compressed"] = done
            _save_meta(d, meta)
            print("  already H.265 — left as-is", flush=True)
            continue

        dur0 = duration_of(f)
        tmp = f.with_name(f.stem + ".cmp" + f.suffix)
        try:
            (_compress_webm if kind == "webm" else _compress_mp4)(f, tmp)
        except Exception as e:
            if tmp.exists():
                tmp.unlink()
            print(f"  skipped ({e})", flush=True)
            continue

        after = tmp.stat().st_size if tmp.exists() else before
        dur1 = duration_of(tmp) if tmp.exists() else 0.0
        # safety: never keep a re-encode that lost/gained time or didn't shrink
        if abs(dur1 - dur0) > 0.3:
            tmp.unlink()
            print(f"  skipped (duration drift {dur0:.2f}→{dur1:.2f}s)", flush=True)
            continue
        if after < before * 0.97:
            tmp.replace(f)
            done[f.name] = {"before": before, "after": after}
            print(f"  {before / 1e6:.1f}MB → {after / 1e6:.1f}MB "
                  f"({100 * (1 - after / before):.0f}% smaller)", flush=True)
        else:
            tmp.unlink()
            done[f.name] = {"before": before, "after": before, "already": True}
            print("  already compact — left as-is", flush=True)
        meta["compressed"] = done
        _save_meta(d, meta)   # persist after each file so a cancel is resumable

    print("compression done", flush=True)


if __name__ == "__main__":
    main()
