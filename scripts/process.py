#!/usr/bin/env python3
"""After a recording: transcribe it and build composite.mp4 at the same time.

Neither waits for the other any more: transcription aligns its words to the
composite's audio built straight from the raw files, and wide renders
composite live from those files too. Whisper is CPU work while the composite
is mostly the hardware encoder, so running them side by side has the
transcript ready in about the time transcription alone takes — instead of
after the composite AND the transcription.

Usage: process.py <session-dir> [--model small]
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import exit_on_sigterm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--model", default="small")
    args = ap.parse_args()
    exit_on_sigterm()   # cancel SIGTERMs the whole group: both children stop too

    here = Path(__file__).parent
    steps = {
        "transcription": subprocess.Popen([sys.executable, str(here / "transcribe.py"),
                                           args.session_dir, "--model", args.model]),
        "composite": subprocess.Popen([sys.executable, str(here / "composite.py"),
                                       args.session_dir]),
    }
    failed = [name for name, p in steps.items() if p.wait() != 0]
    if failed:
        sys.exit(f"{' and '.join(failed)} failed — see above")
    print("processing done: transcript and composite are ready", flush=True)


if __name__ == "__main__":
    main()
