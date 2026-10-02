#!/usr/bin/env python3
"""AI clean-up pass over transcript.json — marks words `removed` with a reason.

Fully local heuristics:
  filler       — um / uh / erm etc.
  stutter      — immediately repeated word ("the the")
  retake       — a sentence repeated (near-)verbatim shortly after; the
                 EARLIER take is cut (you usually nail it the second time)
  false start  — short abandoned sentence whose opening words restart the next

Long pauses are not marked here — render.py collapses any silence longer
than settings.maxGapSec automatically (unless keepGapAfter is set on the
preceding word in the editor).

Never un-removes anything, so manual edits are preserved. Run repeatedly
safely. For the deeper semantic pass (rambling, tangents, better-take
judgement) use the `screen-studio` Claude Code skill, which edits the same
file.

Usage: enhance.py <session-dir> [--max-gap 1.0]
"""
import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import write_json

FILLERS = {"um", "uh", "uhm", "umm", "erm", "er", "ah", "eh", "hmm", "hm", "mmm", "mm"}


def norm(word):
    return re.sub(r"[^\w']", "", word.lower())


def norm_w(w):
    """Normalized text for matching; detected '(um?)' markers are not real
    words — they must never participate in filler/retake text matching."""
    return "" if w.get("detected") else norm(w["w"])


def split_sentences(words):
    """Group word indices into sentences on terminal punctuation or a >1.2s pause."""
    sentences, cur = [], []
    for i, w in enumerate(words):
        cur.append(i)
        nxt = words[i + 1] if i + 1 < len(words) else None
        ends = bool(re.search(r"[.!?]$", w["w"]))
        pause = nxt and (nxt["start"] - w["end"]) > 1.2
        if ends or pause or nxt is None:
            sentences.append(cur)
            cur = []
    return sentences


def sentence_text(words, idxs):
    return " ".join(norm_w(words[i]) for i in idxs if norm_w(words[i]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--max-gap", type=float, default=None,
                    help="collapse pauses longer than this (stored in settings)")
    args = ap.parse_args()

    path = Path(args.session_dir) / "transcript.json"
    if not path.exists():
        sys.exit("no transcript.json — run transcribe first")
    tr = json.loads(path.read_text())
    words = tr["words"]
    counts = {"filler": 0, "stutter": 0, "retake": 0, "false start": 0}

    def cut(i, reason):
        if not words[i]["removed"]:
            words[i]["removed"] = True
            words[i]["reason"] = reason
            counts[reason] += 1

    # 1. fillers
    for i, w in enumerate(words):
        if norm_w(w) in FILLERS:
            cut(i, "filler")

    # 1b. "(um?)" gap-sound markers from transcribe.py — audio blobs Whisper
    # refused to transcribe. Short ones are near-certainly umms/breaths; cut
    # them (restorable in the dashboard). Long ones are left for a human/
    # Claude to judge.
    counts["gap sound"] = 0
    for i, w in enumerate(words):
        if w.get("detected") and (w["end"] - w["start"]) <= 1.2:
            if not w["removed"]:
                w["removed"] = True
                w["reason"] = "gap sound"
                counts["gap sound"] += 1

    # 2. stutters — immediate word repeat, cut the first
    for i in range(len(words) - 1):
        a, b = norm_w(words[i]), norm_w(words[i + 1])
        if a and a == b and (words[i + 1]["start"] - words[i]["end"]) < 0.8:
            cut(i, "stutter")

    # 3. adjacent repeated phrase — the same run of >=3 words spoken twice
    # back-to-back (Whisper often joins retakes with a comma, so the
    # sentence-level pass below can miss them); cut the FIRST run
    normed = [norm_w(w) for w in words]
    i = 0
    while i < len(words):
        matched = False
        for k in range(min(12, (len(words) - i) // 2), 2, -1):
            j = i + k
            if (normed[i:i + k] == normed[j:j + k] and all(normed[i:i + k])
                    and words[j]["start"] - words[j - 1]["end"] < 3.0):
                for m in range(i, i + k):
                    cut(m, "retake")
                i = j
                matched = True
                break
        if not matched:
            i += 1

    # 4. retakes + false starts, sentence level
    sentences = split_sentences(words)
    texts = [sentence_text(words, s) for s in sentences]
    for i in range(len(sentences) - 1):
        if not texts[i]:
            continue
        for j in range(i + 1, min(i + 4, len(sentences))):
            gap = words[sentences[j][0]]["start"] - words[sentences[i][-1]]["end"]
            if gap > 20:
                break
            wc_i = len(sentences[i])
            if wc_i >= 3 and texts[j] and SequenceMatcher(None, texts[i], texts[j]).ratio() > 0.8:
                for k in sentences[i]:
                    cut(k, "retake")
                break
            first_i = [norm_w(words[k]) for k in sentences[i][:2]]
            first_j = [norm_w(words[k]) for k in sentences[j][:2]]
            if wc_i <= 4 and j == i + 1 and first_i and first_i == first_j:
                for k in sentences[i]:
                    cut(k, "false start")
                break

    if args.max_gap is not None:
        tr.setdefault("settings", {})["maxGapSec"] = args.max_gap

    write_json(path, tr)
    total = sum(counts.values())
    print(f"enhance: marked {total} words — " +
          ", ".join(f"{v} {k}" for k, v in counts.items() if v))
    print("long pauses will be collapsed at render "
          f"(maxGapSec={tr.get('settings', {}).get('maxGapSec', 1.0)})")


if __name__ == "__main__":
    main()
