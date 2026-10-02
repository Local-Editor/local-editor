#!/usr/bin/env python3
"""Transcribe a session with faster-whisper (fully local) -> transcript.json.

Prefers the webcam file (clean mic audio) over the composite. Word-level
timestamps so the editor can cut at word granularity.

Usage: transcribe.py <session-dir> [--model base|small|medium] [--language en]
"""
import argparse
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import shutil

from common import duration_of, load_json, migrate_edits, write_json
from composite import Live, write_audio

# Whisper is trained to produce CLEAN text and silently drops disfluencies.
# Seeding the decoder with a filler-laden prompt makes it transcribe them
# verbatim — this matters more than model size for catching umms.
VERBATIM_PROMPT = ("Umm, let me think like, hmm... Okay, so, erm, you know. "
                   "Uh, I mean, it's like, sort of, well, um, yeah.")


def detect_gap_sounds(wav_path, words, min_gap=0.3, min_run=0.18):
    """Energy scan of the pauses BETWEEN transcribed words. Whisper refuses
    to write some umms no matter what; any audible blob in a gap becomes a
    clickable "(um?)" marker so it can still be cut in the editor."""
    import numpy as np
    with wave.open(str(wav_path)) as wf:
        sr = wf.getframerate()
        pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    audio = pcm.astype(np.float32) / 32768.0
    hop = int(sr * 0.02)  # 20 ms frames
    n = len(audio) // hop
    rms = np.sqrt((audio[:n * hop].reshape(n, hop) ** 2).mean(axis=1))

    def level(t0, t1):
        a, b = int(t0 / 0.02), max(int(t0 / 0.02) + 1, int(t1 / 0.02))
        return rms[a:b] if a < len(rms) else np.array([0.0])

    speech = np.median(np.concatenate([level(w["start"], w["end"]) for w in words])) if words else 0.05
    noise = np.percentile(rms, 10)
    thresh = max(3 * noise, 0.2 * speech)

    markers = []
    for i in range(len(words) - 1):
        g0, g1 = words[i]["end"], words[i + 1]["start"]
        if g1 - g0 < min_gap:
            continue
        frames = level(g0, g1) > thresh
        run_start = None
        for k, hot in enumerate(list(frames) + [False]):
            t = g0 + k * 0.02
            if hot and run_start is None:
                run_start = t
            elif not hot and run_start is not None:
                if t - run_start >= min_run:
                    markers.append({
                        "w": "(um?)", "start": round(run_start, 3), "end": round(t, 3),
                        "removed": False, "reason": None, "edited": False,
                        "keepGapAfter": False, "detected": True,
                    })
                run_start = None
    return markers


def _rms_envelope(path, hop_ms=10):
    """16 kHz mono RMS envelope, one value per hop_ms — a cheap, robust
    fingerprint for aligning two renderings of the same voice."""
    import numpy as np
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "env.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(path),
                        "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)
        with wave.open(str(wav)) as wf:
            pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    audio = pcm.astype(np.float32) / 32768.0
    hop = int(16000 * hop_ms / 1000)
    n = len(audio) // hop
    return np.sqrt((audio[:n * hop].reshape(n, hop) ** 2).mean(axis=1))


def measure_offset(source, composite, fallback, max_lag=3.0):
    """SOURCE time -> COMPOSITE time, measured from the audio itself.

    meta.json's webcamOffsetSec is only the recorder's start-time estimate, and
    the composite's audio can disagree with it (the webm decode may swallow a
    corrupt leading packet, or a composite.mp4 may predate a re-record).
    render.py cuts the composite timeline, so that is the one that matters —
    align to it directly and fall back to meta only when the match is weak."""
    try:
        import numpy as np
    except ImportError:
        return fallback, "numpy missing"
    try:
        es, ec = _rms_envelope(source), _rms_envelope(composite)
    except Exception as e:
        return fallback, f"probe failed ({e})"
    lim = 100 * max_lag                       # lag search radius, in 10 ms frames
    n = min(len(es), len(ec))
    if n < 3000:                              # under 30 s: not enough to be sure
        return fallback, "clip too short to measure"
    win = min(6000, n // 2)                   # a 60 s slice, taken from the middle
    st = (n - win) // 2                       # where speech is dense, not the silent head
    a = es[st:st + win] - es[st:st + win].mean()
    lo, hi = max(0, st - int(lim)), min(len(ec), st + win + int(lim))
    b = ec[lo:hi] - ec[lo:hi].mean()
    if len(b) < len(a) + 2 or not a.any() or not b.any():
        return fallback, "not enough signal"
    c = np.correlate(b, a, mode="valid")
    k = int(c.argmax())
    score = float(c[k]) / (np.linalg.norm(a) * np.linalg.norm(b[k:k + win]) + 1e-9)
    lag = (k + lo - st) * 0.01               # frames -> seconds
    if score < 0.3:
        return fallback, f"weak match (score {score:.2f})"
    if abs(lag) > max_lag:
        return fallback, f"implausible lag ({lag:+.2f}s)"
    return round(lag, 3), f"measured (score {score:.2f})"


def pick_audio_source(d: Path, meta: dict):
    """Timestamps must live on the COMPOSITE timeline (what the editor plays).
    composite.py anchors that timeline to the SCREEN recorder's start, so a
    webcam moment at T lands at T + webcamOffsetSec. The offset is SIGNED and
    both signs matter: positive means the webcam recorder started later and
    composite.py delays its head; negative means it started earlier and
    composite.py TRIMS that much off its head. Clamping this to >= 0 leaves
    every word late by |offset| and the render cuts off the opening words."""
    for name, offset in [("webcam.webm", float(meta.get("webcamOffsetSec", 0.0))),
                         ("composite.mp4", 0.0),
                         ("screen.webm", 0.0)]:
        f = d / name
        if f.exists():
            return f, offset
    sys.exit("no media found in session")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--model", default="small",
                    help="base | small | medium | large-v3-turbo (better & slower)")
    ap.add_argument("--language", default=None)
    args = ap.parse_args()

    d = Path(args.session_dir)
    meta = load_json(d / "meta.json", {})
    source, offset = pick_audio_source(d, meta)
    comp = d / "composite.mp4"
    if source.name != comp.name:
        # Align to the composite TIMELINE — the one render.py cuts. Its audio
        # is built straight from the raw files in a second or two, so this no
        # longer waits for composite.mp4 (process.py builds that alongside).
        with tempfile.TemporaryDirectory() as tmp:
            ref = Path(tmp) / "composite-audio.wav"
            if not write_audio(d, ref):
                ref = comp if comp.exists() else None
            if ref:
                offset, how = measure_offset(source, ref, offset)
                print(f"source->composite offset {offset:+.3f}s — {how}", flush=True)
    print(f"transcribing {source.name} (offset {offset:+.3f}s) with model={args.model}", flush=True)

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", str(source),
                        "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)

        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        opts = dict(language=args.language, word_timestamps=True,
                    initial_prompt=VERBATIM_PROMPT,
                    # hotwords re-inject the verbatim style into every 30s
                    # window on the sequential path, where initial_prompt only
                    # reaches the first one (condition_on_previous_text is off)
                    hotwords=VERBATIM_PROMPT,
                    condition_on_previous_text=False,
                    vad_filter=True, vad_parameters={"min_silence_duration_ms": 400})
        try:
            from faster_whisper import BatchedInferencePipeline
        except ImportError:                      # faster-whisper < 1.1
            BatchedInferencePipeline = None
        if BatchedInferencePipeline:
            # Batched mode primes EVERY speech chunk with the verbatim prompt.
            # Measured on a real 4-min take (large-v3-turbo): 13 fillers found
            # vs 8 — the sequential decoder folded the rest into the next
            # word's timestamps ("social" starting on the "um" before it), so
            # those umms could not be cut at all. Greedy decoding (beam 1)
            # makes it ~12% faster too, with word timings unchanged (median
            # 0ms, p90 20ms against the beam-5 run).
            segments, info = BatchedInferencePipeline(model=model).transcribe(
                str(wav), batch_size=8, beam_size=1, **opts)
        else:
            segments, info = model.transcribe(str(wav), **opts)

        words = []
        for seg in segments:
            for w in seg.words or []:
                words.append({
                    "w": w.word.strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "removed": False,
                    "reason": None,
                    "edited": False,
                    "keepGapAfter": False,
                })
            print(f"  [{seg.start:7.2f}s] {seg.text.strip()}", flush=True)

        # the gap scan indexes into `wav`, so it must run on the SOURCE
        # timeline — shift everything to composite time afterwards
        markers = detect_gap_sounds(wav, words)
        if markers:
            words = sorted(words + markers, key=lambda w: w["start"])
            print(f"gap-sound safety net: {len(markers)} unheard-audio '(um?)' markers added")

    if abs(offset) > 0.001:
        # source timeline -> composite timeline; a negative offset means the
        # head of this audio was trimmed away and never reaches the composite
        words = [w for w in words if w["end"] + offset > 0]
        for w in words:
            w["start"] = round(max(0.0, w["start"] + offset), 3)
            w["end"] = round(max(0.0, w["end"] + offset), 3)
        print(f"shifted {len(words)} words by {offset:+.3f}s onto the composite timeline")

    composite = d / "composite.mp4"
    live = Live.of(d)
    measured = "the raw recordings" if live else (composite if composite.exists() else source)
    duration = live.duration() if live else duration_of(measured)

    # A duration of 0 (or one that does not even reach the last word) means the
    # probe failed — a half-written composite, a container with no duration
    # header. Writing it through would materialize a zero-length arrangement in
    # the editor: "After cuts 0:00", an empty timeline and a render with nothing
    # in it. The speech we just transcribed is a safe floor.
    last_word = max((w["end"] for w in words), default=0.0)
    if duration < last_word + 0.001:
        print(f"WARNING: {getattr(measured, 'name', measured)} reported {duration:.3f}s, which is "
              f"shorter than the speech in it ({last_word:.3f}s) — falling back "
              f"to the transcript's own length")
        duration = last_word + 0.5

    transcript = {
        "language": info.language,
        "duration": round(duration, 3),
        "source": source.name,
        "model": args.model,
        "settings": {"padSec": 0.12, "maxGapSec": 1.0},
        "words": words,
    }
    import datetime
    transcript["generatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")

    out = d / "transcript.json"
    if out.exists():
        old = json.loads(out.read_text())
        stats = migrate_edits(old, transcript)
        print(f"carried over your edits from the previous transcript: "
              f"{stats['removed']} cut words, {stats['keepGapAfter']} kept pauses, "
              f"{stats['edited']} text edits")
        n = 1
        while (d / f"transcript.backup{n}.json").exists():
            n += 1
        # copy, not rename: transcript.json must never be missing, even briefly
        shutil.copyfile(out, d / f"transcript.backup{n}.json")
        print(f"previous transcript backed up to transcript.backup{n}.json")
    write_json(out, transcript)
    print(f"transcript.json written: {len(words)} words, language={info.language}")


if __name__ == "__main__":
    main()
