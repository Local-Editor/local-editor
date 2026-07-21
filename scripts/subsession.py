#!/usr/bin/env python3
"""Create a NEW edit session from a slice of an existing one.

Extracts [start, end] of the source composite into a fresh session folder
with its own transcript (words shifted, edits preserved), so the selection
can be edited and rendered independently.

Usage: subsession.py <session-dir> --start 12.5 --end 84.0
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import duration_of, run_ffmpeg, encode_args, load_json

RECORDINGS = Path(__file__).resolve().parent.parent / "recordings"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    args = ap.parse_args()

    d = Path(args.session_dir)
    src = d / "composite.mp4"
    if not src.exists():
        print("no composite.mp4 — building it first", flush=True)
        subprocess.run([sys.executable, str(Path(__file__).parent / "composite.py"),
                       str(d)], check=True)

    start, end = max(0.0, args.start), min(args.end, duration_of(src))
    if end - start < 0.5:
        sys.exit("selection too short")

    n = 1
    while (RECORDINGS / f"{d.name}-part{n}").exists():
        n += 1
    new_id = f"{d.name}-part{n}"
    nd = RECORDINGS / new_id
    nd.mkdir()

    # frame-accurate slice, re-encoded on the hardware encoder
    run_ffmpeg(["-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src)]
               + encode_args("balanced") + [str(nd / "composite.mp4")])

    tr = load_json(d / "transcript.json", {"words": [], "settings": {}})
    words = []
    for w in tr.get("words", []):
        if w["end"] < start or w["start"] > end:
            continue
        nw = dict(w)
        nw["start"] = round(max(0.0, w["start"] - start), 3)
        nw["end"] = round(min(end - start, w["end"] - start), 3)
        words.append(nw)
    new_tr = {
        "language": tr.get("language"),
        "duration": round(end - start, 3),
        "source": "composite.mp4",
        "model": tr.get("model"),
        "settings": tr.get("settings") or {"padSec": 0.12, "maxGapSec": 1.0},
        "words": words,
        "cutRanges": [[round(max(0, a - start), 3), round(min(end - start, b - start), 3)]
                      for a, b in (tr.get("cutRanges") or [])
                      if b > start and a < end],
    }
    (nd / "transcript.json").write_text(json.dumps(new_tr, indent=2))

    src_meta = load_json(d / "meta.json", {})
    (nd / "meta.json").write_text(json.dumps({
        "createdAt": src_meta.get("createdAt"),
        "title": f"{src_meta.get('title', d.name)} — part {n}",
        "hasWebcam": False,
        "webcamOffsetSec": 0,
        "parentSession": d.name,
        "parentRange": [start, end],
    }, indent=2))

    print(f"{len(words)} words carried over", flush=True)
    print(f"subsession ready: {new_id}", flush=True)


if __name__ == "__main__":
    main()
