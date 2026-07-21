#!/usr/bin/env python3
"""Reframe a session to a social format (full length, cuts applied later).

Builds reframe-<format>-<layout>.mp4 from the RAW screen + webcam files so
each half is cropped from the original pixels (no double-scaling):

  formats: short (1080x1920)  square (1080x1080)  wide (passthrough)
  layouts: cam-top     webcam fills the top half, screen the bottom
           cam-bottom  screen top, webcam bottom
           overlay     screen crop-filled + webcam bubble (bottom-right)

Audio matches composite.py: webcam mic (+ system audio mixed if present),
recorder start-skew corrected. render.py chains onto the result to apply
transcript cuts.

Usage: reframe.py <session-dir> --format short --layout cam-top [--quality balanced]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ffprobe, video_stream, has_audio, duration_of, run_ffmpeg,
                    even, write_rounded_mask_png, load_json, encode_args)

CANVAS = {"short": (1080, 1920), "square": (1080, 1080)}


def fill(src_label, w, h, extra=""):
    """Scale-and-centre-crop a stream to exactly w x h."""
    return (f"{src_label}scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}{extra}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--format", choices=["short", "square"], required=True)
    ap.add_argument("--layout", choices=["cam-top", "cam-bottom", "overlay"],
                    default="cam-top")
    ap.add_argument("--quality", default="balanced")
    args = ap.parse_args()

    d = Path(args.session_dir)
    screen = d / "screen.webm"
    webcam = d / "webcam.webm"
    meta = load_json(d / "meta.json", {})
    layout = load_json(d / "layout.json", {})
    if not screen.exists():
        sys.exit("no screen.webm in session")
    have_cam = webcam.exists()

    W, H = CANVAS[args.format]
    out = d / f"reframe-{args.format}-{args.layout}.mp4"

    off = float(meta.get("webcamOffsetSec", 0.0))
    delay_ms = max(0, int(round(off * 1000)))
    trim_s = max(0.0, -off)
    cam_sync = (f"trim=start={trim_s:.3f},setpts=PTS-STARTPTS"
                + (f"+{off:.3f}/TB" if off > 0.001 else ""))
    mirror = ",hflip" if layout.get("mirror", True) else ""

    inputs = ["-i", str(screen)]
    if have_cam:
        inputs += ["-i", str(webcam)]

    if not have_cam:
        graph = f"[0:v]{fill('', W, H)},fps=30[v]"
    elif args.layout == "overlay":
        cam_w = even(W * 0.36)
        cam_h = cam_w
        mask = d / f"mask-{args.format}.png"
        write_rounded_mask_png(mask, cam_w, cam_h, float(layout.get("radius", 18)))
        inputs += ["-loop", "1", "-i", str(mask)]
        graph = (
            f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30[scr];"
            f"[1:v]{cam_sync},scale={cam_w}:{cam_h}:force_original_aspect_ratio=increase,"
            f"crop={cam_w}:{cam_h}{mirror}[cam];"
            f"[2:v]format=gray[m];[cam][m]alphamerge[cama];"
            f"[scr][cama]overlay={W - cam_w - 40}:{H - cam_h - 40}:eof_action=pass[v]"
        )
    else:
        half = even(H / 2)
        cam_first = args.layout == "cam-top"
        cam_chain = (f"[1:v]{cam_sync},scale={W}:{half}:force_original_aspect_ratio=increase,"
                     f"crop={W}:{half}{mirror}[camh]")
        scr_chain = (f"[0:v]scale={W}:{half}:force_original_aspect_ratio=increase,"
                     f"crop={W}:{half}[scrh]")
        top, bottom = ("[camh]", "[scrh]") if cam_first else ("[scrh]", "[camh]")
        graph = (f"{cam_chain};{scr_chain};"
                 f"{top}{bottom}vstack=inputs=2:shortest=0,fps=30[v]")

    # audio — mic primary, mix system audio when present (same as composite.py)
    screen_audio = has_audio(ffprobe(screen))
    webcam_audio = have_cam and has_audio(ffprobe(webcam))
    audio_map = []
    if webcam_audio and screen_audio:
        graph += (f";[1:a]atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS,"
                  f"adelay={delay_ms}|{delay_ms}[mic]"
                  f";[0:a][mic]amix=inputs=2:duration=longest:weights=0.6 1.0[a]")
        audio_map = ["-map", "[a]"]
    elif webcam_audio:
        graph += (f";[1:a]atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS,"
                  f"adelay={delay_ms}|{delay_ms}[a]")
        audio_map = ["-map", "[a]"]
    elif screen_audio:
        audio_map = ["-map", "0:a"]

    run_ffmpeg(inputs + ["-filter_complex", graph, "-map", "[v]"] + audio_map
               + ([] if audio_map else ["-an"])
               + encode_args(args.quality) + [str(out)])
    print(f"reframed: {out} ({duration_of(out):.1f}s, {W}x{H}, {args.layout})")
    return out


if __name__ == "__main__":
    main()
