#!/usr/bin/env python3
"""Carry manual edits from an older transcript onto the current one.

Normally transcribe.py does this automatically; use this when a transcript
was regenerated without migration, e.g.:
  migrate_edits.py <session-dir> --from transcript.backup2.json
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import migrate_edits, write_json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--from", dest="src", required=True,
                    help="old transcript file (inside the session) to take edits from")
    args = ap.parse_args()

    d = Path(args.session_dir)
    old = json.loads((d / args.src).read_text())
    cur_path = d / "transcript.json"
    cur = json.loads(cur_path.read_text())
    stats = migrate_edits(old, cur)
    write_json(cur_path, cur)
    print(f"migrated from {args.src}: {stats['removed']} cut words, "
          f"{stats['keepGapAfter']} kept pauses, {stats['edited']} text edits")


if __name__ == "__main__":
    main()
