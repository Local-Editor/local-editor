#!/usr/bin/env python3
"""Render the final video from the editor's arrangement.

Pipeline:
  1. word/range cuts   -> keep spans on the source recording
  2. segments          -> scissor pieces placed on the timeline (gaps = black)
  3. overlays          -> inserts composited ON TOP at their timeline position
                          (audio mixed in; can extend past the end)
  4. music + captions  -> beds ducked under the voice, captions burned on top

All four stages are ONE filtergraph feeding ONE encode. Each stage used to
write its own intermediate file, which cost a lossy generation and a full trip
through the hardware encoder per stage — and the encoder, not decoding or
filtering, is what limits render speed.

Formats: wide — composited live from screen.webm + webcam.webm (composite.Live),
or cut from composite.mp4 when those are gone — | short/square (reframe.py
intermediate).
--range START END renders only that slice of the source (no arrangement),
used by the transcript's "render only this part".

Usage: render.py <session-dir> [--quality high|balanced|small]
                 [--format wide|short|square] [--layout cam-top|cam-bottom|overlay]
                 [--range START END] [--input X] [--output Y]
                 [--compress] [--denoise]
"""
import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ffprobe, has_audio, duration_of, run_ffmpeg, load_json,
                    keep_segments, encode_args, video_stream, clean_time, even,
                    stream_has_alpha, exit_on_sigterm, build_then_swap, Graph,
                    warn_if_frames_missing)
from composite import Live
import subtitles


DENOISE_MODEL = Path(__file__).resolve().parent / "models" / "rnnoise.rnnn"
RECORDINGS = Path(__file__).resolve().parent.parent / "recordings"
MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"
STEREO = "aformat=sample_rates=48000:channel_layouts=stereo"


def denoise_chain():
    """Voice clean-up applied to the source audio before it is cut. RNNoise
    (arnndn) isolates a single speaker best — ~27 dB of steady background
    removed with the voice essentially unchanged — with an FFT denoise as the
    fallback when the model is absent. Music beds join later, untouched."""
    if DENOISE_MODEL.exists():
        return f"highpass=f=80,arnndn=m='{DENOISE_MODEL}'"
    return "highpass=f=80,afftdn=nr=20:nf=-30:tn=1"


def probe_rate(src):
    """(fps, rate) — `rate` is the exact rational for filters, so a 29.97
    source isn't rounded to 29.97 flat and slowly drifted."""
    vs = video_stream(ffprobe(src))
    try:
        num, den = (int(x) for x in vs["r_frame_rate"].split("/"))
        fps = num / den
        if 0 < fps <= 240:
            return fps, f"{num}/{den}"
    except Exception:
        pass
    return 30.0, "30"


def snap_keeps(keeps, fps):
    """Keep spans snapped to the frame grid. Video can only cut on whole frames
    while audio cuts exactly, so unsnapped boundaries let the two drift a
    little per cut — ~1s of lip-sync drift over 300 cuts."""
    segs = [(round(a * fps) / fps, round(b * fps) / fps) for a, b in keeps]
    return [(a, b) for a, b in segs if b - a >= 1.0 / fps]


def intersect(keeps, s0, s1):
    return [(max(a, s0), min(b, s1)) for a, b in keeps if b > s0 and a < s1]


def seek_origin(segs, fps):
    """Where to start reading a source that only needs `segs`: a second ahead
    of the first kept frame, on the frame grid so cut times stay on it too.
    Whole multiples of 3 frames (0.1s at 30fps; 100.1ms at 29.97) are also
    whole microseconds, ffmpeg's seek unit — a seek a fraction of a µs off
    the grid flips which frame wins a rounding tie, and screen recordings
    timed in whole ms hit exact half-frame ties all the time."""
    return max(0.0, math.floor((segs[0][0] - 1.0) * fps / 3) * 3 / fps)


def cut_audio(g, stem, segs, origin, pre=None):
    """Concatenate `segs` (source times; the input's t=0 is source `origin`)
    out of audio `stem` -> label. atrim+concat, because aselect does not drop
    audio frames on ffmpeg 8."""
    split = [g.label("as") for _ in segs]
    g.add(f"{stem}{pre + ',' if pre else ''}asplit={len(segs)}{''.join(split)}")
    pads = []
    for (a, b), s in zip(segs, split):
        lab = g.label("ak")
        g.add(f"{s}atrim={a - origin:.5f}:{b - origin:.5f},asetpts=PTS-STARTPTS{lab}")
        pads.append(lab)
    out = g.label("ac")
    g.add("".join(pads) + f"concat=n={len(pads)}:v=0:a=1{out}")
    return out


class FileSource:
    """Footage read from a finished file: composite.mp4, a social reframe,
    or --input. open() seeks a fresh input to the stretch asked for."""

    def __init__(self, path):
        info = ffprobe(path)
        vs = video_stream(info)
        a_st = next((x for x in info["streams"] if x["codec_type"] == "audio"), None)
        self.path = path
        self.W, self.H = even(int(vs["width"])), even(int(vs["height"]))
        self.fps, self.rate = probe_rate(path)
        self.audio = a_st is not None
        self.mono = self.audio and int(a_st.get("channels", 2)) == 1
        self.dur = duration_of(path)

    def open(self, g, origin, end):
        """(video, audio-or-None) labels for [origin, end), with t=0 at origin."""
        idx = g.input((["-ss", f"{origin:.6f}"] if origin > 0 else [])
                      + ["-t", f"{end - origin:.6f}", "-i", self.path])
        return f"[{idx}:v]", (f"[{idx}:a]" if self.audio else None)


class LiveSource:
    """Footage composited on the fly from a session's raw recordings (see
    composite.Live): the same picture and sound as its composite.mp4, without
    encoding that file first or cutting a lossy copy of it."""

    def __init__(self, live, mask_dir):
        self.live, self.mask_dir = live, mask_dir
        self.W, self.H = live.W, live.H
        self.fps, self.rate = 30.0, "30/1"           # composite.py's fps=30
        self.audio, self.mono = True, False
        self.dur = live.duration()

    def open(self, g, origin, end):
        v = self.live.video(g, self.mask_dir, origin, end)
        a = g.label("la")
        # stereo the way composite.mp4's is (aformat's upmix, as -ac 2 does
        # there), so a live render sounds exactly like one cut from the file
        g.add(f"{self.live.audio(g)}atrim=start={origin:.6f}:end={end:.6f},"
              f"asetpts=PTS-STARTPTS,{STEREO}{a}")
        return v, a


def piece_streams(g, source, segs, fps, pre):
    """One footage piece: a frame-exact select of `segs` out of `source`.
    Each piece opens its own stretch, seeked near its first kept frame — no
    decoding of footage it never shows, and pieces play in any order without
    one waiting on (and buffering) another. Video and audio come out exactly
    sum(b - a) long, so the pieces concatenate in sync."""
    origin = seek_origin(segs, fps)
    sv, sa = source.open(g, origin, segs[-1][1] + 1.0)
    half = 0.5 / fps
    vsel = "+".join(f"between(t,{a - origin - half:.5f},{b - origin - half:.5f})"
                    for a, b in segs)
    v = g.label("pv")
    g.add(f"{sv}select='{vsel}',setpts=N/FRAME_RATE/TB,setsar=1{v}")
    a = g.label("pa")
    if sa:
        cut = cut_audio(g, sa, segs, origin, pre)
        # mono voice: upmix at unity (c0->both), NOT aformat's 0.707 pan-law —
        # players duplicate mono at full level, so 0.707 renders 3dB quiet
        g.add(f"{cut}{'pan=stereo|c0=c0|c1=c0,' if source.mono else ''}{STEREO}{a}")
    else:
        g.add(f"anullsrc=r=48000:cl=stereo,atrim=duration={sum(b - a for a, b in segs):.6f}{a}")
    return v, a


def gap_streams(g, frames, fps, rate, W, H):
    """`frames` frames of black + matching silence."""
    v, a = g.label("gv"), g.label("ga")
    g.add(f"color=c=black:s={W}x{H}:r={rate},format=yuv420p,setsar=1,"
          f"trim=end_frame={frames},setpts=PTS-STARTPTS{v}")
    g.add(f"anullsrc=r=48000:cl=stereo,atrim=duration={frames / fps:.6f}{a}")
    return v, a


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


def overlay_streams(g, d, ins, W, H, fps, rate, ft, footage, denoise_for):
    """Insert clip -> (video, audio-or-None, ox, oy, length) placed at output
    time `ft`. Framed clips (ins.frame) scale to the frame width at their own
    aspect and sit at (ox, oy); others fill the screen. Transparent sources
    stay transparent. A recording's footage comes live from its raw files when
    they're on disk (`footage`). Returns None when missing or fully cut."""
    live, own = footage(ins)
    f = None if live else resolve_insert(d, ins)
    if not live and not f:
        return None
    # footage of this same recording carries the same voice — clean it too
    if live:
        vs, alpha, audio, total = True, False, True, live.dur
        pre = denoise_for(None) if own else None
    else:
        probe = ffprobe(f)
        vs = video_stream(probe)
        alpha, audio, total = stream_has_alpha(vs), has_audio(probe), duration_of(f)
        pre = denoise_for(f)
    frame = ins.get("frame")
    ox = int(float(frame["x"]) * W) if frame else 0
    oy = int(float(frame["y"]) * H) if frame else 0
    # trim: srcStart = in-point into the source, duration = length used
    # (right-edge trims change duration without srcStart)
    src_start = float(ins.get("srcStart") or 0)
    dur_used = float(ins.get("duration") or 0)
    remaining = max(0.0, total - src_start)
    length = dur_used if 0 < dur_used < remaining - 0.05 else remaining
    if length < 0.05:
        return None

    # the clip's own internal cuts, in clip-local time (after srcStart)
    keeps = None
    cuts = sorted([list(map(float, c)) for c in (ins.get("cuts") or [])])
    if cuts:
        kk, pos = [], 0.0
        for ca, cb in cuts:
            if ca - pos > 0.05:
                kk.append((pos, min(ca, length)))
            pos = max(pos, cb)
        if length - pos > 0.05:
            kk.append((pos, length))
        keeps = snap_keeps(kk, fps)
        if not keeps:
            print(f"overlay {ins.get('id')}: every part of it is cut — skipped", flush=True)
            return None
    out_len = sum(b - a for a, b in keeps) if keeps else length

    if live:
        sv, sa = live.open(g, src_start, src_start + length)
    else:
        # ffmpeg's native vp9 decoder silently drops the alpha plane
        dec = ["-c:v", "libvpx-vp9"] if alpha and f.suffix.lower() == ".webm" else []
        seek = ["-ss", f"{src_start:.6f}"] if src_start > 0.01 else []
        idx = g.input(dec + seek + ["-t", f"{length:.6f}", "-i", f])
        sv, sa = f"[{idx}:v]", (f"[{idx}:a]" if audio else None)

    if vs:
        if frame:
            fw = even(max(64, float(frame["w"]) * W))
            chain = f"{sv}scale={fw}:-2"
        else:
            pad_color = ":color=black@0" if alpha else ""
            chain = (f"{sv}scale={W}:{H}:force_original_aspect_ratio=decrease,"
                     f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2{pad_color}")
        chain += f",fps={rate},setsar=1" + (",format=yuva420p" if alpha else "")
    else:
        # audio-only clip: black picture under the sound, as in the editor
        chain = f"color=c=black:s={W}x{H}:r={rate},trim=duration={length:.6f}"
    if keeps:
        half = 0.5 / fps
        vsel = "+".join(f"between(t,{a - half:.5f},{b - half:.5f})" for a, b in keeps)
        chain += f",select='{vsel}',setpts=N/FRAME_RATE/TB"
    v = g.label("ov")
    g.add(chain + f",setpts=PTS-STARTPTS+{ft:.6f}/TB{v}")

    a = None
    if sa:
        stem = sa
        if keeps:
            stem = cut_audio(g, stem, keeps, 0.0, pre)
            pre = None
        a = g.label("oa")
        delay = int(round(ft * 1000))
        g.add(f"{stem}{pre + ',' if pre else ''}aresample=48000,{STEREO},"
              f"adelay={delay}|{delay}{a}")
    return v, a, ox, oy, out_len


def eff_dur(ins):
    """Clip length after its own internal cuts — mirrors effDur() in editor.js."""
    cut = 0.0
    for c in ins.get("cuts") or []:
        try:
            cut += max(0.0, float(c[1]) - float(c[0]))
        except (TypeError, ValueError, IndexError):
            pass
    return max(0.0, float(ins.get("duration") or 0) - cut)


def arrangement_to_source(segments, c):
    """Timeline position -> time on the source recording (None inside a gap)."""
    for sg in segments:
        length = float(sg["s1"]) - float(sg["s0"])
        if float(sg["pos"]) <= c < float(sg["pos"]) + length:
            return float(sg["s0"]) + (c - float(sg["pos"]))
    return None


def write_captions(cues, tr, W, H, tmpdir, to_output):
    """Caption clips (timeline positions) -> a transparent caption track timed
    to the OUTPUT video, or None when there is nothing to burn. `to_output`
    maps a timeline position to a time in the finished file."""
    if not cues:
        return None
    print("»stage captions", flush=True)
    timed = []
    prev_end = 0.0
    for c in sorted(cues, key=lambda i: float(i.get("at") or 0)):
        text = (c.get("text") or "").strip()
        length = eff_dur(c)
        if not text or length <= 0.05:
            continue
        at = float(c.get("at") or 0)
        a, b = to_output(at), to_output(at + length)
        # a caption whose material was cut away maps to zero length. The floor
        # is deliberately low: at one word per caption a quick "the" genuinely
        # is only a couple of frames long.
        if a is None or b is None or b - a < 0.06:
            continue
        a = max(a, prev_end)                     # never let two overlap
        if b - a < 0.06:
            continue
        prev_end = b
        # per-word timings ride the same arrangement -> output mapping, so the
        # highlight stays on the spoken word after cuts move it
        words = []
        for w in c.get("words") or []:
            try:
                ws, we = to_output(float(w["s"])), to_output(float(w["e"]))
            except (TypeError, ValueError, KeyError):
                words = []
                break
            if ws is None or we is None:
                words = []
                break
            words.append((w.get("w"), max(a, ws), min(b, max(we, ws))))
        timed.append((a, b, text, words or None))
    try:
        layer = subtitles.render_layer(timed, W, H, tmpdir,
                                       tr.get("subtitleStyle"))
    except subtitles.MissingPillow as e:
        print(f"captions skipped — {e}", flush=True)
        return None
    if layer:
        print(f"burning in {len(timed)} caption(s)", flush=True)
    return layer


def prepare_source(d, args, tr, live_for):
    """The footage to cut, and the file to write. A wide render composites
    live from the raw recordings when they're on disk. Otherwise it cuts
    composite.mp4 — rebuilt when a piece's bubble moved, if the raws are there
    to rebuild it from — or, for a social format, the reframe (built once)."""
    if args.fmt == "wide":
        out = d / (args.output or ("clean-part.mp4" if args.range else "clean.mp4"))
        live = None if args.input else live_for(d)
        if live:
            print("compositing live from the raw recordings", flush=True)
            return live, out
        src = d / (args.input or "composite.mp4")
        if src.name == "composite.mp4":
            cam_segs = sorted([sg for sg in (tr.get("segments") or []) if sg.get("cam")],
                              key=lambda sg: float(sg["s0"]))
            want_layouts = json.dumps(
                [[round(float(sg["s0"]), 2), round(float(sg["s1"]), 2), sg["cam"]]
                 for sg in cam_segs], sort_keys=True)
            sidecar = d / ".composite-layouts.json"
            have_layouts = sidecar.read_text() if sidecar.exists() else "[]"
            raws = (d / "screen.webm").exists() or (d / "webcam.webm").exists()
            if not src.exists() or (want_layouts != have_layouts and raws):
                print("»stage composite", flush=True)
                print("building composite (webcam-bubble layout changed)"
                      if src.exists() else "no composite.mp4 — building it first", flush=True)
                subprocess.run([sys.executable, str(Path(__file__).parent / "composite.py"),
                                str(d)], check=True)
            elif want_layouts != have_layouts:
                print("the bubble placement changed, but the raw recording isn't on "
                      "disk to rebuild from (archived?) — rendering the existing "
                      "composite", flush=True)
    else:
        src = d / f"reframe-{args.fmt}-{args.layout}.mp4"
        out = d / (args.output or f"clean-{args.fmt}-{args.layout}.mp4")
        if not src.exists():
            print("»stage reframe", flush=True)
            print(f"building {src.name} first", flush=True)
            subprocess.run([sys.executable, str(Path(__file__).parent / "reframe.py"),
                            str(d), "--format", args.fmt, "--layout", args.layout,
                            "--quality", args.quality], check=True)
    return FileSource(src), out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--input", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--quality", default="balanced", choices=["high", "balanced", "small"])
    ap.add_argument("--compress", action="store_true",
                    help="encode H.265 instead of H.264 (~30% smaller, same single pass)")
    ap.add_argument("--denoise", action="store_true",
                    help="strip background noise from the voice (RNNoise), keep only the speaker")
    ap.add_argument("--format", dest="fmt", default="wide",
                    choices=["wide", "short", "square"])
    ap.add_argument("--layout", default="cam-top",
                    choices=["cam-top", "cam-bottom", "overlay"])
    ap.add_argument("--range", nargs=2, type=float, default=None,
                    metavar=("START", "END"))
    args = ap.parse_args()
    exit_on_sigterm()

    d = Path(args.session_dir)
    tr = load_json(d / "transcript.json")
    if not tr:
        sys.exit("no transcript.json — run transcribe first")
    tmp = tempfile.TemporaryDirectory(prefix="render-")
    tmpdir = Path(tmp.name)

    lives = {}

    def live_for(sd):
        """LiveSource for session folder `sd`, or None when its raw recordings
        aren't there to composite from (see composite.Live.of)."""
        key = sd.resolve()
        if key not in lives:
            lv = Live.of(sd, tr if key == d.resolve() else None)
            lives[key] = LiveSource(lv, tmpdir) if lv else None
        return lives[key]

    source, out = prepare_source(d, args, tr, live_for)
    W, H, fps, rate, dur = source.W, source.H, source.fps, source.rate, source.dur
    keeps_all = [(max(0.0, a), min(b, dur)) for a, b in keep_segments(tr) if a < dur]
    pre = denoise_chain() if args.denoise else None
    own_files = {(d / "composite.mp4").resolve()}
    if isinstance(source, FileSource):
        own_files.add(source.path.resolve())

    def denoise_for(f):
        """The voice clean-up, for this recording's own footage (f=None: it is)."""
        return pre if pre and (f is None or f.resolve() in own_files) else None

    def footage(ins):
        """(LiveSource, is-this-recording) when `ins` plays a recording's
        composite and that recording's raw files are on disk, else (None, _)."""
        if ins.get("musicTrack"):
            return None, False
        if ins.get("fromSession"):
            if (ins.get("fromFile") or "composite.mp4") != "composite.mp4":
                return None, False
            sd = RECORDINGS / ins["fromSession"]
        elif ins.get("file") == "composite.mp4":
            sd = d
        else:
            return None, False
        return live_for(sd), sd.resolve() == d.resolve()

    segments = sorted(tr.get("segments") or
                      [{"id": "seg1", "s0": 0.0, "s1": dur, "pos": 0.0}],
                      key=lambda s: s["pos"])
    inserts_all = sorted(tr.get("inserts") or [], key=lambda i: i.get("at", 0))
    # music clips are audio beds mixed (ducked) under the voice; captions are
    # burned into the picture at the very end — neither is a video overlay
    music_ins = [i for i in inserts_all if i.get("kind") == "music"]
    caption_ins = [i for i in inserts_all if i.get("kind") == "subtitle"]
    overlays = [i for i in inserts_all
                if i.get("kind") not in ("music", "subtitle")]
    if pre:
        print("removing background noise from the voice", flush=True)

    g = Graph()

    # ---- main track: footage pieces (and black gaps) in timeline order ----
    seq = []             # (video, audio) labels to concatenate
    blocks = []          # {arr0, arrLen, out0, kind, sg, keeps, effLen}
    if args.range:
        # partial render: just the selected slice of the source, no arrangement
        r0, r1 = args.range
        keeps = intersect(keeps_all, r0, r1)
        segs = snap_keeps(keeps, fps)
        if not segs:
            sys.exit("nothing kept inside the selected range")
        seq.append(piece_streams(g, source, segs, fps, pre))
        out_t = sum(b - a for a, b in segs)
        overlays, music_ins = [], []

        def to_output(c):
            t = arrangement_to_source(segments, c)
            return None if t is None else clean_time(t, keeps)
    else:
        cursor, out_t = 0.0, 0.0
        for sg in segments:
            raw_len = max(0.0, sg["s1"] - sg["s0"])
            gap = sg["pos"] - cursor
            if gap > 0.05:
                frames = max(1, round(gap * fps))
                seq.append(gap_streams(g, frames, fps, rate, W, H))
                blocks.append({"arr0": cursor, "arrLen": gap, "out0": out_t, "kind": "gap"})
                out_t += frames / fps
            keeps = intersect(keeps_all, sg["s0"], sg["s1"])
            segs = snap_keeps(keeps, fps)
            eff = sum(b - a for a, b in segs)
            if segs:
                seq.append(piece_streams(g, source, segs, fps, pre))
            blocks.append({"arr0": sg["pos"], "arrLen": raw_len, "out0": out_t,
                           "kind": "piece", "sg": sg, "keeps": keeps, "effLen": eff})
            out_t += eff
            cursor = sg["pos"] + raw_len
        if not any(b["kind"] == "piece" and b["effLen"] > 0 for b in blocks):
            sys.exit("nothing left to render — every part of the recording is cut")

        def to_output(c):
            """Arrangement time -> output time (through cuts and gaps)."""
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

    if len(seq) == 1:
        bv, ba = seq[0]
    else:
        bv, ba = "[bv]", "[ba]"
        g.add("".join(v + a for v, a in seq) + f"concat=n={len(seq)}:v=1:a=1{bv}{ba}")
    base_dur = out_t

    # ---- overlays, stacked like the editor preview: the upper track (lower
    # index) wins. The LAST overlay composited lands on top, so upper tracks
    # sort LAST (track index descending), ties broken by position ----
    track_ids = [t.get("id") for t in (tr.get("tracks") or [])]

    def _track_rank(ins):
        try:
            return track_ids.index(ins.get("track"))
        except ValueError:
            return 0
    overlays.sort(key=lambda i: (-_track_rank(i), i.get("at", 0)))
    placed = []
    for ins in overlays:
        ft = to_output(float(ins.get("at", 0)))
        res = overlay_streams(g, d, ins, W, H, fps, rate, ft, footage, denoise_for)
        if not res:
            if not footage(ins)[0] and not resolve_insert(d, ins):
                print(f"overlay {ins.get('id')}: file missing — skipped", flush=True)
            continue
        placed.append((ft,) + res)
    if placed:
        print(f"compositing {len(placed)} overlay(s)", flush=True)

    end_needed = max([base_dur] + [ft + ln for ft, _, _, _, _, ln in placed])
    ext = end_needed - base_dur if end_needed - base_dur > 0.01 else 0.0
    total_out = base_dur + ext

    vprev = bv
    if ext:
        vprev = g.label("vx")
        g.add(f"{bv}tpad=stop_duration={ext:.3f}:color=black{vprev}")
        bpad = g.label("ax")
        g.add(f"{ba}apad=pad_dur={ext:.3f}{bpad}")
        ba = bpad
    amix_pads = []
    for ft, v, a, ox, oy, ln in placed:
        nxt = g.label("vo")
        g.add(f"{vprev}{v}overlay={ox}:{oy}:eof_action=pass"
              f":enable='between(t,{ft:.3f},{ft + ln:.3f})'{nxt}")
        vprev = nxt
        if a:
            amix_pads.append(a)

    # ---- music beds: gain + fades + position, mixed together, then ducked
    # under the voice (which doubles as the sidechain key) ----
    mus_pads = []
    for m in music_ins:
        f = resolve_insert(d, m)
        if not f:
            print(f"music {m.get('musicTrack') or m.get('id')}: file missing — skipped", flush=True)
            continue
        ft = to_output(float(m.get("at", 0)))
        if m.get("loop"):
            cl = max(0.0, total_out - ft)               # looped: always to the end
        else:
            cl = float(m.get("duration") or 0) or duration_of(f)
            cl = min(cl, max(0.0, total_out - ft))      # never outlast the video
        if cl < 0.1:
            continue
        ss = float(m.get("srcStart") or 0)
        idx = g.input((["-stream_loop", "-1"] if m.get("loop") else [])   # atrim caps it
                      + (["-ss", f"{ss:.3f}"] if ss > 0.01 else []) + ["-i", f])
        # volume: linear fraction (editor's % slider); older clips stored dB
        vol = m.get("volume")
        vol = float(vol) if vol is not None else 10 ** (float(m.get("gain", -21)) / 20)
        vol = max(0.0, min(1.5, vol))
        delay = int(round(ft * 1000))
        lab = g.label("mu")
        g.add(f"[{idx}:a]atrim=0:{cl:.3f},volume={vol:.4f},"
              f"afade=t=in:d=1.5,afade=t=out:st={max(0.0, cl - 2.5):.2f}:d=2.5,"
              f"adelay={delay}|{delay},{STEREO}{lab}")
        mus_pads.append(lab)
    if mus_pads:
        print(f"mixing {len(mus_pads)} music bed(s), ducked under the voice", flush=True)
        if len(mus_pads) > 1:
            music = g.label("muall")
            g.add("".join(mus_pads) + f"amix=inputs={len(mus_pads)}:duration=longest"
                  f":dropout_transition=0:normalize=0{music}")
        else:
            music = mus_pads[0]
        voice, key = g.label("voice"), g.label("sckey")
        g.add(f"{ba}asplit=2{voice}{key}")
        ducked = g.label("mduck")
        g.add(f"{music}{key}sidechaincompress=threshold=0.02:ratio=12"
              f":attack=80:release=800:makeup=1{ducked}")
        ba = voice
        amix_pads.append(ducked)

    # ---- captions land last, on top of everything that was composited ----
    cap = write_captions(caption_ins, tr, W, H, tmpdir, to_output)
    if cap:
        idx = g.input(["-f", "concat", "-safe", "0", "-i", cap[0]])
        g.add(subtitles.overlay_filter(idx, fps, vprev, "[vcap]", cap[1]))
        vprev = "[vcap]"

    if amix_pads:
        # dropout_transition=0: the default 2s end-of-stream ramp renormalizes
        # the whole mix ~3dB down when a delayed/trimmed input ends
        g.add(f"{ba}{''.join(amix_pads)}amix=inputs={len(amix_pads) + 1}"
              f":duration=longest:dropout_transition=0:normalize=0[aout]")
        ba = "[aout]"

    script = tmpdir / "graph.txt"
    script.write_text(";".join(g.parts))
    print("»stage render", flush=True)
    if args.compress:
        print("encoding as H.265 to save space", flush=True)
    try:
        # a failed or cancelled render must not destroy the previous good one
        build_then_swap(out, lambda part: run_ffmpeg(
            g.args() + ["-filter_complex_script", str(script), "-map", vprev, "-map", ba]
            + encode_args(args.quality, hevc=args.compress) + [str(part)]))
    finally:
        tmp.cleanup()
    print(f"clean video: {out} ({duration_of(out):.1f}s)", flush=True)
    warn_if_frames_missing(out)


if __name__ == "__main__":
    main()
