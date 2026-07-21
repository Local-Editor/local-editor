#!/usr/bin/env python3
"""Lay background music under a session's video -> <input>-music.mp4.

The music is looped/trimmed to the video length, faded in/out, volume-dropped,
and sidechain-DUCKED under your voice (music dips whenever you speak, swells
in pauses). Video stream is copied, so this is fast.

Also writes/updates credits.txt in the session folder when the track needs
attribution (Incompetech CC-BY) — paste it into your video description.

Usage: addmusic.py <session-dir> --track <library-file> [--input clean.mp4]
                   [--gain -21] [--no-duck]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import ffprobe, has_audio, duration_of, run_ffmpeg

MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--track", required=True, help="file name inside screen-studio/music/")
    ap.add_argument("--input", default=None, help="video to score (default: clean.mp4, else composite.mp4)")
    ap.add_argument("--gain", type=float, default=-21, help="music level in dB relative to full scale")
    ap.add_argument("--no-duck", action="store_true", help="don't duck the music under the voice")
    args = ap.parse_args()

    d = Path(args.session_dir)
    src = d / (args.input or ("clean.mp4" if (d / "clean.mp4").exists() else "composite.mp4"))
    if not src.exists():
        sys.exit(f"no {src.name} — render/composite first")
    track = MUSIC_DIR / args.track
    if not track.exists():
        sys.exit(f"track not in library: {args.track} (see music.py list)")

    out = d / f"{src.stem}-music.mp4"
    dur = duration_of(src)
    voice = has_audio(ffprobe(src))
    fade_out = max(0.0, dur - 2.5)

    music = (f"[1:a]volume={args.gain}dB,"
             f"afade=t=in:d=1.5,afade=t=out:st={fade_out:.2f}:d=2.5,"
             f"atrim=0:{dur:.2f}[m]")
    if voice and not args.no_duck:
        graph = (music
                 + ";[0:a]asplit=2[voice][key]"
                 + ";[m][key]sidechaincompress=threshold=0.02:ratio=12:attack=80:release=800:makeup=1[duck]"
                 + ";[voice][duck]amix=inputs=2:duration=first:normalize=0[a]")
    elif voice:
        graph = music + ";[0:a][m]amix=inputs=2:duration=first:normalize=0[a]"
    else:
        graph = music.replace("[m]", "[a]")

    run_ffmpeg(["-i", str(src), "-stream_loop", "-1", "-i", str(track),
                "-filter_complex", graph,
                "-map", "0:v", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", "-shortest", str(out)])

    lib = json.loads((MUSIC_DIR / "library.json").read_text()) if (MUSIC_DIR / "library.json").exists() else {}
    attribution = (lib.get(args.track) or {}).get("attribution")
    if attribution:
        credits = d / "credits.txt"
        existing = credits.read_text() if credits.exists() else ""
        if attribution not in existing:
            credits.write_text(existing + attribution + "\n")
        print(f"attribution line written to {credits} — include it in the video description")
    print(f"scored video: {out} ({duration_of(out):.1f}s)")


if __name__ == "__main__":
    main()
