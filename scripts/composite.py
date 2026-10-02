#!/usr/bin/env python3
"""Composite webcam overlay onto the screen recording -> composite.mp4.

Reads from a session folder:
  screen.webm   — the screen capture (kept untouched)
  webcam.webm   — webcam + mic (kept untouched)
  layout.json   — normalized overlay {x, y, w, aspect, radius, mirror}
  meta.json     — {webcamOffsetSec, hasWebcam, ...}

The two recorder modes with a mic track (webcam + screen, and screen-only with
a mic) are described by `Live`, which render.py also uses to build any stretch
of this same composite straight from the raw files — so a render needn't cut
composite.mp4 at all. Webcam-only and mic-less recordings are built here only.

Usage: composite.py <session-dir>
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ffprobe, video_stream, has_audio, duration_of,
                    run_ffmpeg, even, write_rounded_mask_png, load_json,
                    encode_args, normalize_audio_timeline, build_then_swap,
                    exit_on_sigterm, Graph, warn_if_frames_missing)


# Rewrite audio timestamps so they follow the SAMPLES, one after another.
#
# Load-bearing for cutting. render.py selects keep-spans with atrim/select,
# which address audio by TIMESTAMP, while transcribe.py reads the mic by
# decoding it start-to-finish, which addresses it by SAMPLE ORDER. Those two
# only agree while the timestamps stay continuous — and encoding this graph can
# leave the composite's audio timestamps running ~1.2s behind its samples, so
# every cut landed ~1.2s late and sliced the opening words off the render.
# The raw webcam.webm is sample-continuous, so re-deriving timestamps from the
# sample count loses nothing and keeps the two addressing schemes identical.
SEQ_PTS = "asetpts=N/SR/TB"


def mic_chain(idx, trim_s, delay_ms, out_label):
    """Mic -> the composite's timeline, read from input `idx`.

    That index matters: see mic_input(). Everything else here is the plain
    start-skew correction — trim the head when the webcam recorder started
    first, delay it when it started second."""
    return (f"[{idx}:a]atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS,"
            f"adelay={delay_ms}|{delay_ms},{SEQ_PTS}{out_label}")


def mic_input(webcam, n_inputs):
    """Give the mic its OWN input handle, appended after `n_inputs` existing ones.

    This is not redundancy. Pulling both streams of one MediaRecorder webm
    through a single input handle desynchronises the audio: on a real 3-minute
    recording the voice landed ~0.48s ahead of where the start-skew says it
    should, so every render had the voice and the webcam bubble running ahead
    of the screen — and transcript-driven cuts sliced off the opening words.
    Decoding the webcam's video and its audio through separate input handles
    restores exact alignment (verified against the recorder's measured skew).

    Appending at the END keeps every earlier input index — and so the mask
    indices in the overlay chain — unchanged."""
    return n_inputs, ["-i", str(webcam)]


# Mic at full level with the system audio 0.6 under it. amix normalizes by
# default — it divided BOTH inputs by the weight sum (1.6), so any recording
# with system audio came out ~4dB quieter than a mic-only one. The limiter
# catches the rare moment both are loud; latency=1 keeps it sample-aligned.
SYSTEM_MIX = ("amix=inputs=2:duration=longest:weights=0.6 1.0:normalize=0,"
              "alimiter=limit=0.95:level=0:latency=1")


def bubble_intervals(layout, cam_segs, screen_dur):
    """(t0, t1, placement) covering the recording: the base layout.json bubble,
    overridden by each scissor piece's own placement (sg["cam"])."""
    intervals = []
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
    return intervals


class Live:
    """The composite of one session, described from its raw recordings.

    video() and audio() add its streams to a Graph. composite.mp4 is these
    streams encoded end to end; render.py asks for just the stretches an edit
    keeps, which skips the full composite encode, a generation of quality, and
    the rebuild every time a piece's bubble moves. Both read the SAME
    description, so the two can't drift apart."""

    def __init__(self, d, tr=None):
        self.d = d
        self.screen, self.webcam = d / "screen.webm", d / "webcam.webm"
        self.layout = load_json(d / "layout.json", {})
        meta = load_json(d / "meta.json", {})
        s_info, w_info = ffprobe(self.screen), ffprobe(self.webcam)
        sv = video_stream(s_info)
        self.sw, self.sh = int(sv["width"]), int(sv["height"])
        self.W, self.H = even(self.sw), even(self.sh)
        self.screen_audio = has_audio(s_info)
        self.webcam_audio = has_audio(w_info)
        self.cam_video = video_stream(w_info) is not None
        # recorder start-time skew between the two MediaRecorders
        self.off = float(meta.get("webcamOffsetSec", 0.0))
        self.delay_ms = max(0, int(round(self.off * 1000)))  # webcam started later -> delay it
        self.trim_s = max(0.0, -self.off)                    # started earlier -> trim its head
        self.screen_dur = duration_of(self.screen)
        tr = tr if tr is not None else (load_json(d / "transcript.json", {}) or {})
        self.cam_segs = sorted([sg for sg in (tr.get("segments") or []) if sg.get("cam")],
                               key=lambda sg: float(sg["s0"]))
        self.intervals = (bubble_intervals(self.layout, self.cam_segs, self.screen_dur)
                          if self.cam_video else [])

    @classmethod
    def of(cls, d, tr=None):
        """The session's Live, or None when its raw files can't stand in for
        composite.mp4 — archived, webcam-only, or no mic track."""
        if not ((d / "screen.webm").exists() and (d / "webcam.webm").exists()):
            return None
        live = cls(d, tr)
        return live if live.webcam_audio else None

    def duration(self):
        """Length of the composite timeline: the screen, or the delayed mic if
        it runs longer (composite.mp4's duration is the longer stream)."""
        return max(self.screen_dur, duration_of(self.webcam) + self.off)

    def signature(self):
        """Which bubble placements a composite was built with (the sidecar)."""
        return [[round(float(sg["s0"]), 2), round(float(sg["s1"]), 2), sg["cam"]]
                for sg in self.cam_segs]

    def video(self, g, mask_dir, origin=0.0, end=None):
        """Composite video from source time `origin` to `end` (None = the end),
        timed so t=0 is `origin`. Returns its label."""
        seek = origin > 0
        # The screen is read from the keyframe BEFORE origin (-noaccurate_seek):
        # a still screen can go seconds without a new frame, and the fps filter
        # needs the last one before origin to fill that stretch. Its -t would
        # count from that keyframe, so the trim below ends the stream instead.
        si = g.input((["-noaccurate_seek", "-ss", f"{origin:.6f}"] if seek else [])
                     + ["-i", self.screen])
        chain = f"[{si}:v]scale={self.W}:{self.H},fps=30"
        if end is not None:
            chain += f",trim=end={end - origin:.6f}"
        prev = g.label("scr")
        g.add(chain + prev)
        ivs = [iv for iv in self.intervals if iv[1] > origin and (end is None or iv[0] < end)]
        if not ivs:
            return prev
        # The webcam VIDEO is aligned at the INPUT (-itsoffset), not with a
        # trim/setpts pair in the graph. `trim=start=N,setpts=PTS-STARTPTS`
        # looks equivalent but silently mis-rebases here: measured against the
        # source, it put the bubble 1.5s ahead of where the skew asks for, so
        # the face ran ahead of the voice in every render. -itsoffset lands it
        # exactly, and -ss/-t after it stay on the composite timeline.
        ci = g.input(["-itsoffset", f"{self.off:.3f}"]
                     + (["-ss", f"{origin:.6f}"] if seek else [])
                     + (["-t", f"{end - origin:.6f}"] if end is not None else [])
                     + ["-i", self.webcam])
        cams = [g.label("c") for _ in ivs]
        g.add(f"[{ci}:v]split={len(ivs)}{''.join(cams)}")
        radius = float(self.layout.get("radius", 12))
        mirror = ",hflip" if self.layout.get("mirror", True) else ""
        for (t0, t1, eff), cam in zip(ivs, cams):
            # overlay geometry in screen pixels, matching the recorder preview
            cw = even(float(eff.get("w", 0.24)) * self.sw)
            ch = even(cw / float(eff.get("aspect", 1.0)))
            x = int(float(eff.get("x", 0.72)) * self.sw)
            y = int(float(eff.get("y", 0.68)) * self.sh)
            mask = Path(mask_dir) / f"mask-{cw}x{ch}-r{radius:g}.png"   # dirs are shared
            if not mask.exists():
                write_rounded_mask_png(mask, cw, ch, radius)
            mi = g.input(["-loop", "1", "-i", mask])
            k, m, ka, nxt = g.label("k"), g.label("m"), g.label("ka"), g.label("v")
            g.add(f"{cam}scale={cw}:{ch}:force_original_aspect_ratio=increase:flags=lanczos,"
                  f"crop={cw}:{ch}{mirror}{k}")
            g.add(f"[{mi}:v]format=gray{m}")
            g.add(f"{k}{m}alphamerge{ka}")
            g.add(f"{prev}{ka}overlay={x}:{y}:eof_action=pass"
                  f":enable='between(t,{t0 - origin:.3f},{t1 - origin:.3f})'{nxt}")
            prev = nxt
        return prev

    def audio(self, g):
        """Composite audio on the composite timeline from t=0 (mic, with any
        system audio mixed under it). Read from the start, never seeked: its
        timestamps must come from the sample count (see SEQ_PTS)."""
        # the mic gets its own input handle — see mic_input()
        mi = g.input(["-i", self.webcam])
        mic = g.label("mic")
        g.add(mic_chain(mi, self.trim_s, self.delay_ms, mic))
        if not self.screen_audio:
            return mic
        si = g.input(["-i", self.screen])
        out = g.label("a")
        g.add(f"[{si}:a]{mic}{SYSTEM_MIX},{SEQ_PTS}{out}")
        return out


def write_audio(d, out):
    """Just the composite's audio (16 kHz mono wav) — what transcribe.py aligns
    words to, without waiting for composite.mp4. False if it can't be built."""
    live = Live.of(d)
    if not live:
        return False
    g = Graph()
    a = live.audio(g)
    run_ffmpeg(g.args() + ["-filter_complex", ";".join(g.parts), "-map", a,
                           "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)])
    return True


def build(d, out):
    """Composite session `d` into `out`. Returns the per-piece bubble placement
    signature for the .composite-layouts.json sidecar (None: no bubble)."""
    screen = d / "screen.webm"
    webcam = d / "webcam.webm"

    if not screen.exists():
        if webcam.exists():
            # webcam-only recording: the camera IS the video
            w_info = ffprobe(webcam)
            wv = video_stream(w_info)
            ww, wh = even(int(wv["width"])), even(int(wv["height"]))
            # Chrome tags only the webcam's matrix — label primaries and
            # transfer too, or players guess (QuickTime shifts the colours)
            args = ["-i", str(webcam), "-vf", f"scale={ww}:{wh},fps=30,setparams=color_primaries=bt709"
                    ":color_trc=bt709:colorspace=bt709:range=tv"]
            if not has_audio(w_info):
                args += ["-an"]
            run_ffmpeg(args + encode_args() + [str(out)])
            normalize_audio_timeline(out)
            print("composite done (webcam only)")
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
        normalize_audio_timeline(out)
        print("composite done (screen only)")
        return

    live = Live(d)
    g = Graph()
    with tempfile.TemporaryDirectory(prefix="masks-") as masks:
        maps = ["-map", live.video(g, masks)]
        if live.webcam_audio:
            maps += ["-map", live.audio(g)]
        elif screen_audio:                      # no mic track: the screen's own sound
            maps += ["-map", f"{g.input(['-i', screen])}:a"]
        else:
            maps += ["-an"]
        run_ffmpeg(g.args() + ["-filter_complex", ";".join(g.parts)] + maps
                   + encode_args() + [str(out)])
    normalize_audio_timeline(out)
    if live.cam_video:
        print(f"composite done: {duration_of(out):.1f}s, "
              f"{len(live.intervals)} bubble position(s)")
        return live.signature()
    print(f"composite done (screen + mic): {duration_of(out):.1f}s")
    return None


def main(session_dir):
    d = Path(session_dir)
    exit_on_sigterm()
    sig = build_then_swap(d / "composite.mp4", lambda tmp: build(d, tmp))
    warn_if_frames_missing(d / "composite.mp4")
    if sig is not None:
        # written only once the new composite is in place, so it never vouches
        # for a file that a cancelled build left behind
        (d / ".composite-layouts.json").write_text(json.dumps(sig, sort_keys=True))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: composite.py <session-dir>")
    main(sys.argv[1])
