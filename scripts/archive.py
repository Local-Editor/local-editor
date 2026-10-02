#!/usr/bin/env python3
"""Archive a session's heavy media to Google Drive (rclone) and restore it back.

Archiving is a MOVE, not a copy: the files are uploaded, verified against the
copies on Drive, and only then deleted locally. The small sidecars (meta.json,
transcript.json, layout.json, masks, credits) always stay on disk, so the
recording keeps showing up in the editor with its edit intact — only the picture
is offline, exactly like relinking media in an NLE. `restore` pulls it back down.

Works on whole sessions (the Edit tab) or single files (the Renders page) via
--files. State is a per-FILE map, merged on every archive, so archiving one
render never forgets media archived earlier:

    meta.json['archive'] = {
        "remote": "gdrive:Local Editor Archive/<session>",
        "files": {"clean.mp4": {"size": 135105846, "at": "2026-08-19T..."}},
    }

A session counts as fully archived when that map is non-empty and no media is
left on disk. Restoring drops only the keys it brought back, and removes the
whole 'archive' key once nothing is left on Drive.

Uses the same rclone remote the upload dashboard uses (`gdrive:` by default,
configured in ~/.config/rclone/rclone.conf). --transfers 1 is deliberate: Drive
discards uncommitted chunk sessions if the process dies, so one file at a time
means each finished file is committed immediately.

Usage:
    archive.py archive <session-dir> [--files a.mp4 b.webm] [--remote R] [--keep]
    archive.py restore <session-dir> [--files a.mp4 b.webm] [--remote R]
"""
import argparse
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json, update_json

DEFAULT_REMOTE = "gdrive:Local Editor Archive"

# Heavy files worth shipping to Drive. Everything else in a session dir is a
# few KB of edit state and stays local so the session is still browsable.
MEDIA_EXT = {".webm", ".mp4", ".mov", ".mkv", ".wav", ".mp3", ".m4a", ".aac"}

# rclone flags mirrored from ~/rclone-dashboard/start.sh — proven against this
# Drive account (chunk_size 128M lives in the remote's config).
RCLONE_FLAGS = [
    "--transfers", "1",
    "--retries", "10",
    "--low-level-retries", "20",
    "--stats", "1s",
    "--stats-one-line",
    # Periodic stats are logged at INFO, and rclone's default level is NOTICE —
    # without this the progress line never appears and the bar sits at 0%.
    # Raising the stats level (rather than -v) keeps it to one line a second
    # instead of the INFO flood that once starved a transfer on this account.
    "--stats-log-level", "NOTICE",
]

PCT_RE = re.compile(r",\s*(\d+)%,")


def human(n):
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def is_media(name):
    return not name.startswith(".") and Path(name).suffix.lower() in MEDIA_EXT


def media_files(d: Path):
    """Session media on disk, sorted for stable ordering."""
    return [f for f in sorted(d.iterdir()) if f.is_file() and is_media(f.name)]


def archived_map(meta):
    """The per-file archive map, tolerating the {name: size} shape written by
    the first version of this script."""
    files = ((meta.get("archive") or {}).get("files")) or {}
    return {n: (v if isinstance(v, dict) else {"size": v}) for n, v in files.items()}


def save_meta(d: Path, meta: dict):
    """Persist the archive map only — the server may have renamed the session
    or a render while the transfer ran, and those edits must survive."""
    update_json(d / "meta.json", "archive", meta.get("archive"))


def run_rclone(args, label):
    """Run rclone, echoing a '»ap <pct>' line whenever the overall percentage
    moves. --stats-one-line writes '10.5 MiB / 52.4 MiB, 20%, 3.5 MiB/s, ETA 12s'
    once a second; that percentage is across all files in the run."""
    cmd = ["rclone"] + args + RCLONE_FLAGS
    print("+ " + " ".join(str(a) for a in cmd), flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    last = -1
    for line in proc.stdout:
        m = PCT_RE.search(line)
        if m:
            pct = min(99, int(m.group(1)))
            if pct != last:
                last = pct
                print(f"»ap {pct}", flush=True)
            continue          # don't spam the log with a stats line per second
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"rclone {label} exited {proc.returncode}")


def files_from(names):
    """rclone --files-from-raw list file (raw = paths taken literally)."""
    tmp = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    tmp.write("\n".join(names) + "\n")
    tmp.close()
    return tmp.name


def transfer(src, dst, names, stage, label):
    """Copy `names` from src to dst, then verify them, or raise."""
    listfile = files_from(names)
    try:
        print(f"»stage {stage}", flush=True)
        run_rclone(["copy", str(src), str(dst), "--files-from-raw", listfile], "copy")
        # Verify before anything is deleted. rclone check hashes both sides
        # (Drive exposes md5 for uploaded binaries), so a truncated or corrupted
        # transfer fails here and the originals are left alone.
        print("»stage verify", flush=True)
        print(f"verifying {label}…", flush=True)
        run_rclone(["check", str(src), str(dst), "--files-from-raw", listfile, "--one-way"],
                   "check")
    finally:
        Path(listfile).unlink(missing_ok=True)


def remote_for(remote_root: str, session: str) -> str:
    return f"{remote_root.rstrip('/')}/{session}"


def check_rclone(remote_root: str):
    """Fail fast with a readable message rather than deep inside a transfer."""
    try:
        subprocess.run(["rclone", "version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        sys.exit("rclone is not installed or not on PATH — `brew install rclone`")
    name = remote_root.split(":", 1)[0]
    remotes = subprocess.run(["rclone", "listremotes"], capture_output=True,
                             text=True).stdout.split()
    if f"{name}:" not in remotes:
        sys.exit(f"rclone remote '{name}:' is not configured — `rclone config`")


def do_archive(d: Path, remote_root: str, keep: bool, only=None):
    meta = load_json(d / "meta.json") or {}
    done = archived_map(meta)

    files = media_files(d)
    if only:
        wanted = set(only)
        missing = wanted - {f.name for f in files}
        if missing:
            sys.exit(f"not on disk (or not a media file): {', '.join(sorted(missing))}")
        files = [f for f in files if f.name in wanted]
    files = [f for f in files if f.name not in done]
    if not files:
        print("nothing to archive — already on Drive", flush=True)
        return

    # Keep every file for a session in one Drive folder even if the configured
    # remote changed after the first archive, so restore stays predictable.
    dest = (meta.get("archive") or {}).get("remote") or remote_for(remote_root, d.name)
    sizes = {f.name: f.stat().st_size for f in files}
    total = sum(sizes.values())
    print(f"archiving {len(files)} file(s), {human(total)} → {dest}", flush=True)
    for n in sorted(sizes):
        print(f"  · {n} ({human(sizes[n])})", flush=True)

    transfer(d, dest, [f.name for f in files], "upload", "uploaded copies against local originals")

    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for n, size in sizes.items():
        done[n] = {"size": size, "at": at}
    meta["archive"] = {"remote": dest, "files": done}
    save_meta(d, meta)      # written BEFORE deleting: a crash mid-delete still
                            # leaves a session that knows where its media went

    if keep:
        print("»stage done", flush=True)
        print(f"backed up {human(total)} (local copies kept)", flush=True)
        return

    print("»stage cleanup", flush=True)
    freed = 0
    for f in files:
        try:
            f.unlink()
            freed += sizes[f.name]
        except OSError as e:
            print(f"  could not delete {f.name}: {e}", flush=True)
    print(f"archived to Drive — {human(freed)} freed locally", flush=True)


def do_restore(d: Path, remote_root: str, only=None):
    meta = load_json(d / "meta.json") or {}
    done = archived_map(meta)
    if not done:
        print("nothing archived — nothing to restore", flush=True)
        return
    src = (meta.get("archive") or {}).get("remote") or remote_for(remote_root, d.name)

    names = sorted(done)
    if only:
        unknown = set(only) - set(names)
        if unknown:
            sys.exit(f"not in this session's archive: {', '.join(sorted(unknown))}")
        names = sorted(only)

    total = sum(done[n].get("size", 0) for n in names)
    print(f"restoring {len(names)} file(s), {human(total)} ← {src}", flush=True)
    transfer(src, d, names, "download", "downloaded files against Drive")

    missing = [n for n in names if not (d / n).exists()]
    if missing:
        sys.exit(f"restore incomplete — still missing: {', '.join(missing)}")

    # Drop only what came back; the Drive copies are deliberately left in place
    # (re-archiving overwrites them).
    for n in names:
        done.pop(n, None)
    if done:
        meta["archive"] = {"remote": src, "files": done}
    else:
        meta.pop("archive", None)
    save_meta(d, meta)
    print("»stage done", flush=True)
    print(f"restored {human(total)} — {len(names)} file(s) editable again", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=["archive", "restore"])
    ap.add_argument("session_dir")
    ap.add_argument("--files", nargs="+", metavar="NAME",
                    help="only these files (default: all media / all archived)")
    ap.add_argument("--remote", default=DEFAULT_REMOTE,
                    help=f"remote root (default: {DEFAULT_REMOTE})")
    ap.add_argument("--keep", action="store_true",
                    help="upload as a backup but keep the local files")
    a = ap.parse_args()

    d = Path(a.session_dir)
    if not d.is_dir():
        sys.exit(f"no such session: {d}")
    if a.files and any("/" in f or f in ("", ".", "..") for f in a.files):
        sys.exit("--files takes plain file names, not paths")
    check_rclone(a.remote)

    if a.action == "archive":
        do_archive(d, a.remote, a.keep, a.files)
    else:
        do_restore(d, a.remote, a.files)


if __name__ == "__main__":
    main()
