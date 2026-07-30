#!/usr/bin/env python3
"""Render the final video from the editor's arrangement.

Pipeline:
  1. word/range cuts   -> keep spans on the source recording
  2. segments          -> scissor pieces placed on the timeline (gaps = black)
  3. overlays          -> inserts composited ON TOP at their timeline position
                          (audio mixed in; can extend past the end)

Formats: wide (composite.mp4) | short/square (reframe.py intermediate).
--range START END renders only that slice of the source (no arrangement),
used by the transcript's "render only this part".

Usage: render.py <session-dir> [--quality high|balanced|small]
                 [--format wide|short|square] [--layout cam-top|cam-bottom|overlay]
                 [--range START END] [--input X] [--output Y]
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ffprobe, has_audio, duration_of, run_ffmpeg, load_json,
                    keep_segments, encode_args, video_stream, clean_time, even,
                    compress_to_hevc)


DENOISE_MODEL = Path(__file__).resolve().parent / "models" / "rnnoise.rnnn"


def _denoise_source(src):
    """Return a copy of `src` with background noise stripped from the voice (video
    stream copied untouched). RNNoise (arnndn) isolates a single speaker best —
    ~27 dB of steady background removed with the voice essentially unchanged —
    falling back to an FFT denoise if the model is absent. Applied to the SOURCE
    so every cut/arrange/mix path downstream inherits the cleaned voice; music
    beds are added later and stay untouched."""
    if not has_audio(ffprobe(src)):
        return src
    print("»stage denoise", flush=True)
    print("removing background noise from the voice", flush=True)
    dtmp = Path(tempfile.mkdtemp(prefix="denoise-"))
    out = dtmp / (src.stem + ".mp4")
    if DENOISE_MODEL.exists():
        af = f"highpass=f=80,arnndn=m={DENOISE_MODEL}"      # spaces in path are fine
    else:
        af = "highpass=f=80,afftdn=nr=20:nf=-30:tn=1"        # built-in fallback
    run_ffmpeg(["-i", str(src), "-map", "0", "-c:v", "copy", "-af", af,
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    return out


def _maybe_compress(out, args):
    """Optional final pass: shrink the finished render to visually-lossless H.265."""
    if not getattr(args, "compress", False):
        return
    print("»stage compress", flush=True)
    res = compress_to_hevc(out)
    if res:
        before, after = res
        pct = 100 * (1 - after / before)
        print(f"compressed {before / 1e6:.1f}MB → {after / 1e6:.1f}MB "
              f"({pct:.0f}% smaller, H.265)", flush=True)
    else:
        print("compression left the file as-is (already efficient)", flush=True)

RECORDINGS = Path(__file__).resolve().parent.parent / "recordings"


def probe_fps(src):
    vs = video_stream(ffprobe(src))
    try:
        num, den = vs["r_frame_rate"].split("/")
        fps = float(num) / float(den)
    except Exception:
        fps = 0
    return fps if 0 < fps <= 240 else 30.0


def snap_to(fps):
    return lambda t: round(t * fps) / fps


def cut_piece(src, keeps, fps, quality, audio, out):
    """One-pass select cut of `keeps` (source times) -> out. Frame-snapped
    boundaries keep video and audio timelines identical (sync!)."""
    snap = snap_to(fps)
    segs = [(snap(a), snap(b)) for a, b in keeps]
    segs = [(a, b) for a, b in segs if b - a >= 1.0 / fps]
    if not segs:
        return 0.0
    half = 0.5 / fps
    vsel = "+".join(f"between(t,{a - half:.5f},{b - half:.5f})" for a, b in segs)
    parts = [f"[0:v]select='{vsel}',setpts=N/FRAME_RATE/TB[v]"]
    if audio:
        pads = []
        for k, (a, b) in enumerate(segs):
            parts.append(f"[0:a]atrim={a:.5f}:{b:.5f},asetpts=PTS-STARTPTS[a{k}]")
            pads.append(f"[a{k}]")
        parts.append("".join(pads) + f"concat=n={len(segs)}:v=0:a=1[a]")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(";".join(parts))
        script = f.name
    maps = ["-map", "[v]"] + (["-map", "[a]"] if audio else [])
    run_ffmpeg(["-i", str(src), "-filter_complex_script", script] + maps +
               encode_args(quality) + [str(out)])
    return sum(b - a for a, b in segs)


def intersect(keeps, s0, s1):
    return [(max(a, s0), min(b, s1)) for a, b in keeps if b > s0 and a < s1]


MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"


def resolve_insert(d, ins):
    if ins.get("musicTrack"):
        f = MUSIC_DIR / ins["musicTrack"]
        return f if f.exists() else None
    if ins.get("fromSession"):
        other = RECORDINGS / ins["fromSession"]
        comp = other / (ins.get("fromFile") or "composite.mp4")
        if not comp.exists() and comp.name == "composite.mp4":
            subprocess.run([sys.executable, str(Path(__file__).parent / "composite.py"),
                            str(other)], check=True)
        return comp if comp.exists() else None
    f = d / ins.get("file", "")
    return f if f.exists() else None


def stream_has_alpha(vs):
    """True when the video stream carries an alpha channel (ProRes 4444,
    VP9-alpha webm, PNG-style formats). VP9 hides it behind a tag."""
    if not vs:
        return False
    if vs.get("pix_fmt", "").startswith(("yuva", "rgba", "argb", "bgra", "gbrap")):
        return True
    tags = {k.lower(): v for k, v in (vs.get("tags") or {}).items()}
    return tags.get("alpha_mode") == "1"


def normalize_overlay(d, ins, W, H, fps, quality, tmpdir, k):
    """Insert file -> normalized clip with its own cuts applied.
    Returns (file, ox, oy): framed clips (ins.frame) scale to the frame width
    at their own aspect and overlay at (ox, oy); others fill the screen.
    Transparent sources stay transparent (ProRes 4444 intermediate)."""
    f = resolve_insert(d, ins)
    if not f:
        return None
    probe = ffprobe(f)
    alpha = stream_has_alpha(video_stream(probe))
    norm = tmpdir / (f"ov{k}.mov" if alpha else f"ov{k}.mp4")
    # ffmpeg's native vp9 decoder silently drops the alpha plane
    dec = ["-c:v", "libvpx-vp9"] if alpha and f.suffix.lower() == ".webm" else []
    enc = (["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
            "-c:a", "aac", "-b:a", "192k"] if alpha else encode_args(quality))
    frame = ins.get("frame")
    ox = int(float(frame["x"]) * W) if frame else 0
    oy = int(float(frame["y"]) * H) if frame else 0
    # trim: srcStart = in-point into the source, duration = length used.
    # Apply -ss when trimmed in, and -t whenever a duration shorter than the
    # source is set (right-edge trims change duration without srcStart).
    src_start = float(ins.get("srcStart") or 0)
    dur_used = float(ins.get("duration") or 0)
    src_total = duration_of(f)
    seek = []
    if src_start > 0.01:
        seek += ["-ss", f"{src_start:.3f}"]
    if 0 < dur_used < src_total - src_start - 0.05:
        seek += ["-t", f"{dur_used:.3f}"]
    if video_stream(probe):
        if frame:
            fw = even(max(64, float(frame["w"]) * W))
            vf = f"scale={fw}:-2,fps={fps:g},setsar=1"
        else:
            pad_color = ":color=black@0" if alpha else ""
            vf = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                  f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2{pad_color},fps={fps:g},setsar=1")
        args = dec + seek + ["-i", str(f), "-vf", vf]
        if not has_audio(probe):
            args = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] + dec + seek + \
                   ["-i", str(f), "-vf", vf, "-map", "1:v", "-map", "0:a", "-shortest"]
    else:
        adur = min(dur_used, src_total - src_start) if dur_used > 0 else duration_of(f)
        args = ["-f", "lavfi", "-i", f"color=black:size={W}x{H}:rate={fps:g}"] + \
               seek + ["-i", str(f), "-map", "0:v", "-map", "1:a", "-t", f"{adur:.3f}"]
    run_ffmpeg(args + ["-ar", "48000", "-ac", "2"] + enc + [str(norm)])

    cuts = sorted([list(map(float, c)) for c in (ins.get("cuts") or [])])
    if cuts and alpha:
        print(f"overlay {ins.get('id')}: internal cuts aren't supported on "
              f"transparent clips yet — playing it uncut", flush=True)
        cuts = []
    if cuts:
        ndur = duration_of(norm)
        keeps, pos = [], 0.0
        for ca, cb in cuts:
            if ca - pos > 0.05:
                keeps.append((pos, min(ca, ndur)))
            pos = max(pos, cb)
        if ndur - pos > 0.05:
            keeps.append((pos, ndur))
        if keeps and keeps != [(0.0, ndur)]:
            cut_file = tmpdir / f"ov{k}-cut.mp4"
            cut_piece(norm, keeps, fps, quality, True, cut_file)
            norm = cut_file
    return norm, ox, oy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--input", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--quality", default="balanced", choices=["high", "balanced", "small"])
    ap.add_argument("--compress", action="store_true",
                    help="final visually-lossless H.265 pass to reduce file size")
    ap.add_argument("--denoise", action="store_true",
                    help="strip background noise from the voice (RNNoise), keep only the speaker")
    ap.add_argument("--format", dest="fmt", default="wide",
                    choices=["wide", "short", "square"])
    ap.add_argument("--layout", default="cam-top",
                    choices=["cam-top", "cam-bottom", "overlay"])
    ap.add_argument("--range", nargs=2, type=float, default=None,
                    metavar=("START", "END"))
    args = ap.parse_args()

    d = Path(args.session_dir)
    tr_early = load_json(d / "transcript.json") or {}
    if args.fmt == "wide":
        src = d / (args.input or "composite.mp4")
        out = d / (args.output or ("clean-part.mp4" if args.range else "clean.mp4"))
        # rebuild the composite when the webcam-bubble keyframes changed
        import json as _json
        cam_segs = sorted([sg for sg in (tr_early.get("segments") or []) if sg.get("cam")],
                          key=lambda sg: float(sg["s0"]))
        want_layouts = _json.dumps(
            [[round(float(sg["s0"]), 2), round(float(sg["s1"]), 2), sg["cam"]]
             for sg in cam_segs], sort_keys=True)
        sidecar = d / ".composite-layouts.json"
        have_layouts = sidecar.read_text() if sidecar.exists() else "[]"
        if not src.exists() or want_layouts != have_layouts:
            print("»stage composite", flush=True)
            print("building composite (webcam-bubble layout changed)"
                  if src.exists() else "no composite.mp4 — building it first", flush=True)
            subprocess.run([sys.executable, str(Path(__file__).parent / "composite.py"),
                            str(d)], check=True)
    else:
        src = d / f"reframe-{args.fmt}-{args.layout}.mp4"
        out = d / (args.output or f"clean-{args.fmt}-{args.layout}.mp4")
        if not src.exists():
            print("»stage reframe", flush=True)
            print(f"building {src.name} first", flush=True)
            subprocess.run([sys.executable, str(Path(__file__).parent / "reframe.py"),
                            str(d), "--format", args.fmt, "--layout", args.layout,
                            "--quality", args.quality], check=True)

    tr = load_json(d / "transcript.json")
    if not tr:
        sys.exit("no transcript.json — run transcribe first")

    if getattr(args, "denoise", False):
        src = _denoise_source(src)

    dur = duration_of(src)
    fps = probe_fps(src)
    audio = has_audio(ffprobe(src))
    vs = video_stream(ffprobe(src))
    W, H = even(int(vs["width"])), even(int(vs["height"]))
    keeps_all = [(max(0.0, a), min(b, dur)) for a, b in keep_segments(tr) if a < dur]

    # ---- partial render: just the selected slice, no arrangement ----
    if args.range:
        r0, r1 = args.range
        keeps = intersect(keeps_all, r0, r1)
        if not keeps:
            sys.exit("nothing kept inside the selected range")
        n = cut_piece(src, keeps, fps, args.quality, audio, out)
        _maybe_compress(out, args)
        print(f"clean video: {out} ({n:.1f}s of selection)", flush=True)
        return

    segments = sorted(tr.get("segments") or
                      [{"id": "seg1", "s0": 0.0, "s1": dur, "pos": 0.0}],
                      key=lambda s: s["pos"])
    inserts_all = sorted(tr.get("inserts") or [], key=lambda i: i.get("at", 0))
    # music clips are audio beds mixed (ducked) under the voice, not overlays
    music_ins = [i for i in inserts_all if i.get("kind") == "music"]
    overlays = [i for i in inserts_all if i.get("kind") != "music"]
    # stack by track like the editor preview: the upper track (lower index) wins.
    # overlays are composited in list order and the LAST one lands on top, so
    # sort upper tracks LAST (track index descending), ties broken by position.
    track_ids = [t.get("id") for t in (tr.get("tracks") or [])]

    def _track_rank(ins):
        try:
            return track_ids.index(ins.get("track"))
        except ValueError:
            return 0
    overlays.sort(key=lambda i: (-_track_rank(i), i.get("at", 0)))

    print("»stage cut", flush=True)
    tmpdir = Path(tempfile.mkdtemp(prefix="arrange-"))
    blocks = []          # {arr0, arrLen, out0, kind, sg, keeps, effLen}
    files = []           # ordered files to concatenate
    cursor, out_t = 0.0, 0.0
    for k, sg in enumerate(segments):
        raw_len = max(0.0, sg["s1"] - sg["s0"])
        gap = sg["pos"] - cursor
        if gap > 0.05:
            gfile = tmpdir / f"gap{k}.mp4"
            run_ffmpeg(["-f", "lavfi", "-i", f"color=black:size={W}x{H}:rate={fps:g}",
                        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                        "-t", f"{gap:.3f}"] + encode_args(args.quality) + [str(gfile)])
            files.append(gfile)
            blocks.append({"arr0": cursor, "arrLen": gap, "out0": out_t, "kind": "gap"})
            out_t += gap
        keeps = intersect(keeps_all, sg["s0"], sg["s1"])
        pfile = tmpdir / f"piece{k}.mp4"
        eff = cut_piece(src, keeps, fps, args.quality, audio, pfile) if keeps else 0.0
        if eff > 0:
            files.append(pfile)
        blocks.append({"arr0": sg["pos"], "arrLen": raw_len, "out0": out_t,
                       "kind": "piece", "sg": sg, "keeps": keeps, "effLen": eff})
        out_t += eff
        cursor = sg["pos"] + raw_len

    # arrangement time -> output time (through cuts and gaps)
    def final_time(c):
        for b in blocks:
            if c < b["arr0"]:
                return b["out0"]
            if c < b["arr0"] + b["arrLen"]:
                if b["kind"] == "gap":
                    return b["out0"] + (c - b["arr0"])
                t = b["sg"]["s0"] + (c - b["arr0"])
                off = sum(min(kb, t) - ka for ka, kb in b["keeps"] if ka < t)
                return b["out0"] + max(0.0, min(off, b["effLen"]))
        return out_t

    # concat the arrangement
    arranged = tmpdir / "arranged.mp4"
    if len(files) == 1:
        files[0].replace(arranged)
    else:
        ai = "aformat=sample_rates=48000:channel_layouts=stereo"
        inputs, parts, pads = [], [], []
        for k, f in enumerate(files):
            inputs += ["-i", str(f)]
            parts.append(f"[{k}:v]setpts=PTS-STARTPTS[v{k}]")
            parts.append(f"[{k}:a]asetpts=PTS-STARTPTS,{ai}[a{k}]")
            pads += [f"[v{k}]", f"[a{k}]"]
        graph = ";".join(parts) + ";" + "".join(pads) + \
                f"concat=n={len(files)}:v=1:a=1[v][a]"
        run_ffmpeg(inputs + ["-filter_complex", graph, "-map", "[v]", "-map", "[a]"]
                   + encode_args(args.quality) + [str(arranged)])

    if not overlays and not music_ins:
        arranged.replace(out)
        _maybe_compress(out, args)
        print(f"clean video: {out} ({duration_of(out):.1f}s)", flush=True)
        return

    # ---- composite overlays ON TOP at their timeline positions ----
    if overlays:
        print(f"compositing {len(overlays)} overlay(s)", flush=True)
    norm, times = [], []
    for k, ins in enumerate(overlays):
        res = normalize_overlay(d, ins, W, H, fps, args.quality, tmpdir, k)
        if not res:
            print(f"overlay {ins.get('id')}: file missing — skipped", flush=True)
            continue
        nf, ox, oy = res
        ft = final_time(float(ins.get("at", 0)))
        norm.append((nf, ox, oy))
        times.append((ft, duration_of(nf)))

    # ---- resolve music beds ----
    mus = []
    for m in music_ins:
        f = resolve_insert(d, m)
        if not f:
            print(f"music {m.get('musicTrack') or m.get('id')}: file missing — skipped", flush=True)
            continue
        mus.append((f, m, final_time(float(m.get("at", 0)))))
    if mus:
        print(f"mixing {len(mus)} music bed(s), ducked under the voice", flush=True)

    if not norm and not mus:
        arranged.replace(out)
        _maybe_compress(out, args)
        print(f"clean video: {out} ({duration_of(out):.1f}s)", flush=True)
        return
    print("»stage mix", flush=True)

    base_dur = duration_of(arranged)
    end_needed = max([base_dur] + [ft + fd for ft, fd in times])
    ext = max(0.0, end_needed - base_dur)

    total_out = max(base_dur + ext, base_dur)
    # music-only pass leaves every pixel alone — copy the video stream
    # instead of re-encoding (fast, no generation loss)
    video_untouched = not norm and ext <= 0.01
    inputs = ["-i", str(arranged)]
    parts = []
    vprev = "[bv]"
    if not video_untouched:
        parts.append(f"[0:v]tpad=stop_duration={ext:.3f}:color=black[bv]" if ext > 0.01
                     else "[0:v]null[bv]")
    # mono voice: upmix at unity (c0->both), NOT aformat's 0.707 pan-law —
    # players duplicate mono at full level, so 0.707 would make every mixed
    # render 3dB quieter than the plain one
    a_st = next((s for s in ffprobe(arranged)["streams"]
                 if s["codec_type"] == "audio"), None)
    mono = a_st and int(a_st.get("channels", 2)) == 1
    base_a = ("[0:a]" + ("pan=stereo|c0=c0|c1=c0," if mono else "")
              + "aformat=sample_rates=48000:channel_layouts=stereo"
              + (f",apad=pad_dur={ext:.3f}" if ext > 0.01 else ""))
    if mus:
        # the voice doubles as the sidechain key that ducks the music
        parts.append(base_a + ",asplit=2[ba][sckey]")
    else:
        parts.append(base_a + "[ba]")
    amix_pads = ["[ba]"]
    for k, ((nf, ox, oy), (ft, fd)) in enumerate(zip(norm, times)):
        inputs += ["-i", str(nf)]
        parts.append(f"[{k + 1}:v]setpts=PTS+{ft:.3f}/TB[ov{k}]")
        nxt = f"[vo{k}]"
        parts.append(f"{vprev}[ov{k}]overlay={ox}:{oy}:eof_action=pass"
                     f":enable='between(t,{ft:.3f},{ft + fd:.3f})'{nxt}")
        vprev = nxt
        delay = int(round(ft * 1000))
        parts.append(f"[{k + 1}:a]adelay={delay}|{delay},"
                     f"aformat=sample_rates=48000:channel_layouts=stereo[oa{k}]")
        amix_pads.append(f"[oa{k}]")

    # ---- music beds: gain + fades + position, mixed together, then ducked ----
    mus_pads = []
    for k, (f, m, ft) in enumerate(mus):
        if m.get("loop"):
            cl = max(0.0, total_out - ft)               # looped: always to the end
        else:
            cl = float(m.get("duration") or 0) or duration_of(f)
            cl = min(cl, max(0.0, total_out - ft))      # never outlast the video
        if cl < 0.1:
            continue
        idx = 1 + len(norm) + len(mus_pads)
        seek = []
        ss = float(m.get("srcStart") or 0)
        if ss > 0.01:
            seek = ["-ss", f"{ss:.3f}"]
        if m.get("loop"):
            inputs += ["-stream_loop", "-1"]   # atrim below caps the length
        inputs += seek + ["-i", str(f)]
        # volume: linear fraction (editor's % slider); older clips stored dB
        vol = m.get("volume")
        vol = float(vol) if vol is not None else 10 ** (float(m.get("gain", -21)) / 20)
        vol = max(0.0, min(1.5, vol))
        delay = int(round(ft * 1000))
        fade_out = max(0.0, cl - 2.5)
        parts.append(f"[{idx}:a]atrim=0:{cl:.3f},volume={vol:.4f},"
                     f"afade=t=in:d=1.5,afade=t=out:st={fade_out:.2f}:d=2.5,"
                     f"adelay={delay}|{delay},"
                     f"aformat=sample_rates=48000:channel_layouts=stereo[mu{len(mus_pads)}]")
        mus_pads.append(f"[mu{len(mus_pads)}]")
    if mus_pads:
        if len(mus_pads) > 1:
            parts.append("".join(mus_pads) +
                         f"amix=inputs={len(mus_pads)}:duration=longest:dropout_transition=0:normalize=0[muall]")
            music_lbl = "[muall]"
        else:
            music_lbl = mus_pads[0]
        parts.append(f"{music_lbl}[sckey]sidechaincompress=threshold=0.02:ratio=12"
                     f":attack=80:release=800:makeup=1[mduck]")
        amix_pads.append("[mduck]")
    elif mus:
        # every bed fell outside the video — drop the unused sidechain key
        parts.append("[sckey]anullsink")
    # dropout_transition=0: the default 2s end-of-stream ramp renormalizes the
    # whole mix ~3dB down when a delayed/trimmed input ends — kills the fix
    parts.append("".join(amix_pads) +
                 f"amix=inputs={len(amix_pads)}:duration=longest:dropout_transition=0:normalize=0[a]")
    graph = ";".join(parts)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(graph)
        script = f.name
    if video_untouched:
        maps = ["-map", "0:v", "-map", "[a]"]
        enc = ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    else:
        maps = ["-map", vprev.strip("[]").join(["[", "]"]), "-map", "[a]"]
        enc = encode_args(args.quality)
    run_ffmpeg(inputs + ["-filter_complex_script", script] + maps + enc + [str(out)])
    _maybe_compress(out, args)
    print(f"clean video: {out} ({duration_of(out):.1f}s)", flush=True)


if __name__ == "__main__":
    main()
