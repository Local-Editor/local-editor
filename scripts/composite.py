#!/usr/bin/env python3
"""Composite webcam overlay onto the screen recording -> composite.mp4.

Reads from a session folder:
  screen.webm   — the screen capture (kept untouched)
  webcam.webm   — webcam + mic (kept untouched)
  layout.json   — normalized overlay {x, y, w, aspect, radius, mirror}
  meta.json     — {webcamOffsetSec, hasWebcam, ...}

Usage: composite.py <session-dir>
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ffprobe, video_stream, has_audio, duration_of,
                    run_ffmpeg, even, write_rounded_mask_png, load_json,
                    encode_args)


def main(session_dir):
    d = Path(session_dir)
    screen = d / "screen.webm"
    webcam = d / "webcam.webm"
    out = d / "composite.mp4"
    layout = load_json(d / "layout.json", {})
    meta = load_json(d / "meta.json", {})

    if not screen.exists():
        if webcam.exists():
            # webcam-only recording: the camera IS the video
            w_info = ffprobe(webcam)
            wv = video_stream(w_info)
            ww, wh = even(int(wv["width"])), even(int(wv["height"]))
            args = ["-i", str(webcam), "-vf", f"scale={ww}:{wh},fps=30"]
            if not has_audio(w_info):
                args += ["-an"]
            run_ffmpeg(args + encode_args() + [str(out)])
            print(f"composite done (webcam only): {out}")
            return
        sys.exit("no screen.webm or webcam.webm in session")

    s_info = ffprobe(screen)
    sv = video_stream(s_info)
    sw, sh = int(sv["width"]), int(sv["height"])
    screen_audio = has_audio(s_info)

    if not webcam.exists():
        # Screen-only with no mic track: just transcode to a seekable mp4.
        args = ["-i", str(screen), "-vf", f"scale={even(sw)}:{even(sh)},fps=30"]
        if not screen_audio:
            args += ["-an"]
        run_ffmpeg(args + encode_args() + [str(out)])
        print(f"composite done (screen only): {out}")
        return

    w_info = ffprobe(webcam)
    webcam_audio = has_audio(w_info)

    if video_stream(w_info) is None:
        # screen-only mode: webcam.webm is a mic-only audio track — mux it
        off = float(meta.get("webcamOffsetSec", 0.0))
        delay_ms = max(0, int(round(off * 1000)))
        trim_s = max(0.0, -off)
        graph = f"[0:v]scale={even(sw)}:{even(sh)},fps=30[v]"
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
        run_ffmpeg(["-i", str(screen), "-i", str(webcam),
                    "-filter_complex", graph, "-map", "[v]"] + audio_map
                   + ([] if audio_map else ["-an"]) + encode_args() + [str(out)])
        print(f"composite done (screen + mic): {out} ({duration_of(out):.1f}s)")
        return

    # Overlay geometry in screen pixels, matching the recorder preview.
    cam_w = even(float(layout.get("w", 0.24)) * sw)
    cam_h = even(cam_w / float(layout.get("aspect", 1.0)))
    ox = int(float(layout.get("x", 0.72)) * sw)
    oy = int(float(layout.get("y", 0.68)) * sh)
    radius = float(layout.get("radius", 12))
    mirror = bool(layout.get("mirror", True))

    # Recorder start-time skew between the two MediaRecorders.
    off = float(meta.get("webcamOffsetSec", 0.0))
    delay_ms = max(0, int(round(off * 1000)))          # webcam started later -> delay it
    trim_s = max(0.0, -off)                            # webcam started earlier -> trim its head

    sync = (f"trim=start={trim_s:.3f},setpts=PTS-STARTPTS"
            + (f"+{off:.3f}/TB" if off > 0.001 else ""))

    # Per-piece bubble placement: each scissor piece of footage can carry its
    # own bubble position/size (sg["cam"]). Uncovered source time = base layout.
    tr = load_json(d / "transcript.json", {}) or {}
    screen_dur = duration_of(screen)
    cam_segs = sorted([sg for sg in (tr.get("segments") or []) if sg.get("cam")],
                      key=lambda sg: float(sg["s0"]))

    intervals = []  # (t0, t1, effective layout) covering [0, screen_dur]
    cursor = 0.0
    for sg in cam_segs:
        s0, s1 = max(0.0, float(sg["s0"])), min(screen_dur, float(sg["s1"]))
        if s0 - cursor > 0.05:
            intervals.append((cursor, s0, dict(layout)))
        if s1 - s0 > 0.05:
            intervals.append((s0, s1, {**layout, **sg["cam"]}))
        cursor = max(cursor, s1)
    if screen_dur + 1 - cursor > 0.05:
        intervals.append((cursor, screen_dur + 1, dict(layout)))

    mask_inputs = []
    parts = [f"[0:v]scale={even(sw)}:{even(sh)},fps=30[scr]",
             f"[1:v]{sync}[camsync]",
             f"[camsync]split={len(intervals)}" +
             "".join(f"[c{i}]" for i in range(len(intervals)))]
    prev = "[scr]"
    for i, (t0, t1, eff) in enumerate(intervals):
        cw = even(float(eff.get("w", 0.24)) * sw)
        ch = even(cw / float(eff.get("aspect", 1.0)))
        exi = int(float(eff.get("x", 0.72)) * sw)
        eyi = int(float(eff.get("y", 0.68)) * sh)
        mask_i = d / f"mask-{i}.png"
        write_rounded_mask_png(mask_i, cw, ch, radius)
        mask_inputs += ["-loop", "1", "-i", str(mask_i)]
        midx = 2 + i
        parts.append(
            f"[c{i}]scale={cw}:{ch}:force_original_aspect_ratio=increase,"
            f"crop={cw}:{ch}" + (",hflip" if mirror else "") + f"[k{i}]")
        parts.append(f"[{midx}:v]format=gray[m{i}]")
        parts.append(f"[k{i}][m{i}]alphamerge[ka{i}]")
        nxt = f"[v{i}]"
        parts.append(f"{prev}[ka{i}]overlay={exi}:{eyi}:eof_action=pass"
                     f":enable='between(t,{t0:.3f},{t1:.3f})'{nxt}")
        prev = nxt
    parts.append(f"{prev}null[v]")
    cam_chain = ";".join(parts)

    # Audio: mic (webcam) is primary; mix in system audio when present.
    audio_chain = ""
    audio_map = []
    if webcam_audio and screen_audio:
        audio_chain = (
            f";[1:a]atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms}[mic]"
            f";[0:a][mic]amix=inputs=2:duration=longest:weights=0.6 1.0[a]"
        )
        audio_map = ["-map", "[a]"]
    elif webcam_audio:
        audio_chain = (
            f";[1:a]atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms}[a]"
        )
        audio_map = ["-map", "[a]"]
    elif screen_audio:
        audio_map = ["-map", "0:a"]

    args = ["-i", str(screen), "-i", str(webcam)] + mask_inputs +            ["-filter_complex", cam_chain + audio_chain,
            "-map", "[v]"] + audio_map + (["-an"] if not audio_map else [])
    run_ffmpeg(args + encode_args() + [str(out)])
    # sidecar so render.py knows which bubble placements this composite used
    sig = [[round(float(sg["s0"]), 2), round(float(sg["s1"]), 2), sg["cam"]]
           for sg in cam_segs]
    (d / ".composite-layouts.json").write_text(json.dumps(sig, sort_keys=True))
    print(f"composite done: {out} ({duration_of(out):.1f}s, {len(intervals)} bubble position(s))")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: composite.py <session-dir>")
    main(sys.argv[1])
