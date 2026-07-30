#!/usr/bin/env python3
"""Build lightweight preview proxies so the editor plays smoothly even for
high-resolution screen recordings.

Browsers hardware-decode H.264 up to 4K, but VP9 only to ~1080p — so a 3K VP9
screen capture (full Retina) falls back to CPU decoding and stutters when played
raw. This transcodes screen.webm / webcam.webm to hardware-friendly H.264 capped
at 1080p (`proxy-screen.mp4` / `proxy-webcam.mp4`), normalized to a constant 30fps
(which also smooths any variable-frame-rate capture). Same duration, so the edit
model is unchanged. The editor prefers these for PLAYBACK; the untouched raw files
are still used for the final render, so nothing is lost in quality.

Usage: proxy.py <session-dir>
"""
import sys
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import duration_of, ffprobe, has_audio
from compress import _run_ffmpeg   # streams a "»fp k/N pct" progress line

_VT = None


def _h264():
    global _VT
    if _VT is None:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True).stdout
        _VT = "h264_videotoolbox" in out
    # preview quality — small & fast, hardware when available
    if _VT:
        return ["-c:v", "h264_videotoolbox", "-q:v", "50", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p"]


def _build(src, dst, max_w, k, total):
    dur = duration_of(src)
    # cap width (never upscale), force even dims, constant 30fps, square pixels
    vf = f"scale='min({max_w},iw)':-2:flags=bicubic,fps=30,setsar=1"
    audio = ["-c:a", "aac", "-b:a", "128k"] if has_audio(ffprobe(src)) else ["-an"]
    args = ["-i", str(src), "-vf", vf] + _h264() + audio + \
           ["-movflags", "+faststart", str(dst)]
    _run_ffmpeg(args, dur, k, total)


def main():
    d = Path(sys.argv[1])
    if not d.is_dir():
        sys.exit(f"no such session: {d}")
    jobs = []
    if (d / "screen.webm").exists():
        jobs.append(("screen.webm", "proxy-screen.mp4", 1920))
    if (d / "webcam.webm").exists():
        jobs.append(("webcam.webm", "proxy-webcam.mp4", 1280))
    total = len(jobs)
    if not total:
        print("nothing to proxy — no raw screen/webcam files", flush=True)
        return
    print(f"building {total} preview prox{'y' if total == 1 else 'ies'}", flush=True)

    for i, (sfile, dfile, mw) in enumerate(jobs, 1):
        print("»stage proxy", flush=True)
        print(f"[{i}/{total}] {dfile}…", flush=True)
        tmp = (d / dfile).with_suffix(".tmp.mp4")
        try:
            _build(d / sfile, tmp, mw, i, total)
        except Exception as e:
            if tmp.exists():
                tmp.unlink()
            print(f"  failed ({e})", flush=True)
            continue
        tmp.replace(d / dfile)
        print(f"  {dfile} ready ({(d / dfile).stat().st_size / 1e6:.0f}MB)", flush=True)

    print("preview proxies ready", flush=True)


if __name__ == "__main__":
    main()
