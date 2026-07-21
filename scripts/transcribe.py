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
from common import duration_of, load_json, migrate_edits

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


def pick_audio_source(d: Path, meta: dict):
    """Timestamps must live on the COMPOSITE timeline (what the editor plays),
    so if the webcam recorder started later we shift by its offset."""
    for name, offset in [("webcam.webm", float(meta.get("webcamOffsetSec", 0.0))),
                         ("composite.mp4", 0.0),
                         ("screen.webm", 0.0)]:
        f = d / name
        if f.exists():
            return f, max(0.0, offset)
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
    print(f"transcribing {source.name} (offset {offset:+.3f}s) with model={args.model}", flush=True)

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", str(source),
                        "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)

        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            str(wav), language=args.language, word_timestamps=True,
            initial_prompt=VERBATIM_PROMPT,
            # hotwords re-inject the verbatim style into EVERY 30s window
            # (initial_prompt only reaches the first one when
            # condition_on_previous_text is off)
            hotwords=VERBATIM_PROMPT,
            condition_on_previous_text=False,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 400})

        words = []
        for seg in segments:
            for w in seg.words or []:
                words.append({
                    "w": w.word.strip(),
                    "start": round(w.start + offset, 3),
                    "end": round(w.end + offset, 3),
                    "removed": False,
                    "reason": None,
                    "edited": False,
                    "keepGapAfter": False,
                })
            print(f"  [{seg.start:7.2f}s] {seg.text.strip()}", flush=True)

        markers = detect_gap_sounds(wav, words)
        if markers:
            for m in markers:
                m["start"] += offset
                m["end"] += offset
            words = sorted(words + markers, key=lambda w: w["start"])
            print(f"gap-sound safety net: {len(markers)} unheard-audio '(um?)' markers added")

    composite = d / "composite.mp4"
    duration = duration_of(composite if composite.exists() else source)

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
        out.rename(d / f"transcript.backup{n}.json")
        print(f"previous transcript backed up to transcript.backup{n}.json")
    out.write_text(json.dumps(transcript, indent=2))
    print(f"transcript.json written: {len(words)} words, language={info.language}")


if __name__ == "__main__":
    main()
