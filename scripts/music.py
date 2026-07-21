#!/usr/bin/env python3
"""Screen Studio music library — chill background tracks, fully scriptable.

Sources:
  * Incompetech (Kevin MacLeod) — 1400+ tracks, CC-BY 4.0: free for any use,
    needs a credit line, which this tool records automatically per track.
  * Anything you download yourself (Pixabay, YouTube Audio Library, ...)
    via `add` — you're responsible for that license.

Library lives in screen-studio/music/ with library.json metadata sidecar.

Usage:
  music.py search chill lofi        # search the Incompetech catalog
  music.py get "Wallpaper"          # download a track by (partial) title
  music.py starter                  # pull a curated chill starter pack
  music.py add /path/track.mp3      # import your own file
  music.py list                     # what's in the library
"""
import argparse
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"
LIB = MUSIC_DIR / "library.json"
CATALOG = MUSIC_DIR / "incompetech-catalog.json"
CATALOG_URL = "https://incompetech.com/music/royalty-free/pieces.json"
MP3_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/"

# a hand-checked chill starter set (feel: Calming/Relaxed, low intensity)
STARTER = ["Wallpaper", "Carefree", "Deliberate Thought", "Meditation Impromptu 01",
           "Easy Lemon", "Dreamy Flashback", "Peace of Mind", "Airport Lounge"]


def load_lib():
    return json.loads(LIB.read_text()) if LIB.exists() else {}


def save_lib(lib):
    MUSIC_DIR.mkdir(exist_ok=True)
    LIB.write_text(json.dumps(lib, indent=2))


def load_catalog():
    if not CATALOG.exists():
        print("downloading Incompetech catalog (one-time, server is slow)...", flush=True)
        MUSIC_DIR.mkdir(exist_ok=True)
        with urllib.request.urlopen(CATALOG_URL, timeout=300) as r:
            CATALOG.write_bytes(r.read())
    return json.loads(CATALOG.read_text())


def search(terms):
    cat = load_catalog()
    q = [t.lower() for t in terms]
    hits = []
    for t in cat:
        hay = " ".join([t.get("title", ""), t.get("feel", ""), t.get("description", ""),
                        t.get("instruments", "")]).lower()
        if all(term in hay for term in q):
            hits.append(t)
    hits.sort(key=lambda t: t.get("title", ""))
    for t in hits[:40]:
        print(f"  {t['title']:<38} {t.get('length','?'):>8}  bpm {t.get('bpm','?'):>3}  [{t.get('feel','').strip()}]")
    print(f"{len(hits)} matches" + (" (top 40 shown)" if len(hits) > 40 else ""))
    return hits


def slugify(name):
    return re.sub(r"[^\w.-]+", "-", name).strip("-")


def get(title_query):
    cat = load_catalog()
    q = title_query.lower()
    match = next((t for t in cat if t["title"].lower() == q), None) \
        or next((t for t in cat if q in t["title"].lower()), None)
    if not match:
        sys.exit(f"no catalog match for {title_query!r} — try music.py search")
    fname = slugify(match["filename"])
    dest = MUSIC_DIR / fname
    MUSIC_DIR.mkdir(exist_ok=True)
    if not dest.exists():
        url = MP3_BASE + urllib.parse.quote(match["filename"])
        print(f"downloading {match['title']} ...", flush=True)
        with urllib.request.urlopen(url, timeout=600) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    lib = load_lib()
    lib[fname] = {
        "title": match["title"],
        "artist": "Kevin MacLeod",
        "length": match.get("length"),
        "feel": match.get("feel", "").strip(),
        "license": "CC-BY 4.0",
        "attribution": (f"Music: “{match['title']}” by Kevin MacLeod (incompetech.com), "
                        "licensed under Creative Commons: By Attribution 4.0 "
                        "— https://creativecommons.org/licenses/by/4.0/"),
        "source": "incompetech",
    }
    save_lib(lib)
    print(f"added: {fname} ({dest.stat().st_size // 1024} KB)")
    return fname


def add(src):
    MUSIC_DIR.mkdir(exist_ok=True)
    if re.match(r"https?://", src):
        name = slugify(Path(urllib.parse.urlparse(src).path).name) or "track.mp3"
        dest = MUSIC_DIR / name
        print(f"downloading {src} ...", flush=True)
        with urllib.request.urlopen(src, timeout=600) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    else:
        p = Path(src).expanduser()
        if not p.exists():
            sys.exit(f"not found: {p}")
        dest = MUSIC_DIR / slugify(p.name)
        shutil.copy2(p, dest)
    lib = load_lib()
    lib[dest.name] = {"title": dest.stem, "artist": None, "license": "unknown (user-supplied)",
                      "attribution": None, "source": "user"}
    save_lib(lib)
    print(f"added: {dest.name}")


def starter():
    for t in STARTER:
        try:
            get(t)
        except SystemExit as e:
            print(f"  skip {t}: {e}")
    list_lib()


def list_lib():
    lib = load_lib()
    if not lib:
        print("library empty — try: music.py starter")
        return
    for fname, m in sorted(lib.items()):
        exists = "✓" if (MUSIC_DIR / fname).exists() else "MISSING"
        print(f"  {exists} {fname:<44} {m.get('title','')} [{m.get('license','?')}]")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["search", "get", "add", "starter", "list"])
    ap.add_argument("args", nargs="*")
    a = ap.parse_args()
    if a.cmd == "search":
        search(a.args or ["calming"])
    elif a.cmd == "get":
        get(" ".join(a.args))
    elif a.cmd == "add":
        add(a.args[0])
    elif a.cmd == "starter":
        starter()
    else:
        list_lib()
