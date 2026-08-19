#!/usr/bin/env python3
"""Burned-in captions.

The editor keeps every caption as an insert of kind "subtitle" on its own
timeline (see public/editor.js) — so a caption drags, trims and gets retyped
exactly like any other clip. At render time render.py maps each cue's TIMELINE
position through the arrangement into OUTPUT time and calls render_layer()
here.

Captions are drawn with Pillow rather than ffmpeg's `ass`/`drawtext` filters:
plenty of ffmpeg builds ship without libass or libfreetype (the Homebrew build
this was written against has neither), and rasterizing here also means the
editor's CSS preview and the rendered file can share one set of numbers. Each
cue becomes a full-frame transparent PNG; the concat demuxer streams them with
per-cue durations and a single `overlay` composites the lot in one pass.

The three looks mirror `.cap-overlay` in public/style.css — change one, change
the other, or the preview over the player stops matching the render.
"""
from pathlib import Path

# fontsize = frame height / N
SIZES = {"small": 30.0, "medium": 23.0, "large": 17.0}
POSITIONS = ("bottom", "middle", "top")
MAX_CHARS = 38          # target characters on a caption line
CHAR_EM = 0.52          # average glyph advance of Arial Bold, as a fraction
                        # of the fontsize — the line budget is MAX_CHARS of it
SIDE_MARGIN = 0.05      # minimum left/right margin, fraction of the frame width
V_MARGIN = 0.055        # bottom/top margin, fraction of the frame height
LINE_SPACING = 1.18
DIM_ALPHA = 0.42        # opacity of the words that aren't being spoken

# weight -> font files to try, best first. The last entries are the usual
# Linux metric-compatible substitutes.
FONTS = {
    "bold": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
    "black": [
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
        "/Library/Fonts/Arial Black.ttf",
        "C:/Windows/Fonts/ariblk.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
}

# stroke/shadow are fractions of the fontsize. `em` overrides CHAR_EM where the
# look's font is wider — Arial Black in caps runs ~1.5x Arial Bold, and without
# it every caption would wrap a line or two early.
LOOKS = {
    "outline": {"weight": "bold", "fill": (255, 255, 255, 255),
                "stroke": 0.075, "stroke_fill": (0, 0, 0, 255), "em": CHAR_EM,
                "shadow": 0.05, "shadow_alpha": 190, "box": None, "upper": False},
    "boxed":   {"weight": "bold", "fill": (255, 255, 255, 255),
                "stroke": 0.0, "stroke_fill": (0, 0, 0, 255), "em": CHAR_EM,
                "shadow": 0.0, "shadow_alpha": 0, "box": (0, 0, 0, 158),
                "upper": False},
    "pop":     {"weight": "black", "fill": (255, 229, 0, 255),
                "stroke": 0.115, "stroke_fill": (0, 0, 0, 255), "em": 0.80,
                "shadow": 0.065, "shadow_alpha": 215, "box": None, "upper": True},
}


class MissingPillow(RuntimeError):
    pass


def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFilter, ImageFont
    except ImportError as e:      # pragma: no cover - depends on the install
        raise MissingPillow(
            "captions need Pillow — install it with "
            "`.venv/bin/pip install pillow` (it is in requirements.txt)") from e
    return Image, ImageDraw, ImageFilter, ImageFont


def _font(weight, size):
    _, _, _, ImageFont = _pil()
    for path in FONTS.get(weight, FONTS["bold"]):
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default(size)      # last resort: still legible


def _text_w(font, text, stroke):
    """Advance width, which is what laying words out side by side needs — the
    ink bbox would drift once words are positioned one at a time."""
    return font.getlength(text) + 2 * stroke


def wrap_lines(font, text, max_px, stroke):
    """Split `text` into balanced lines that each fit inside `max_px`.

    Greedy wrapping leaves a long first line and an orphan on the second;
    filling to width/n instead gives the even, subtitle-looking block."""
    words = text.split()
    if not words:
        return []
    total = _text_w(font, text, stroke)
    n = max(1, -(-int(total) // max(1, int(max_px))))     # ceil division
    target = total / n
    lines, cur = [], []
    for w in words:
        trial = " ".join(cur + [w])
        if cur and (_text_w(font, trial, stroke) > max_px
                    or (_text_w(font, trial, stroke) > target
                        and len(lines) < n - 1)):
            lines.append(" ".join(cur))
            cur = [w]
        else:
            cur.append(w)
    if cur:
        lines.append(" ".join(cur))
    return lines


def metrics(W, H, style=None):
    """The numbers the editor preview mirrors: font size and text block width."""
    style = style or {}
    look = LOOKS.get(style.get("style") or "outline", LOOKS["outline"])
    fs = max(12.0, H / SIZES.get(style.get("size") or "medium", SIZES["medium"]))
    line_px = min(W * (1 - 2 * SIDE_MARGIN), MAX_CHARS * fs * look["em"])
    return fs, line_px


def plan_cue(text, W, H, look, fs, line_px, position):
    """Everything about one caption that does not depend on which word is lit:
    the wrapped lines, each word's box, and where the band sits in the frame."""
    font = _font(look["weight"], int(round(fs)))
    stroke = int(round(fs * look["stroke"]))
    shadow_off = int(round(fs * look["shadow"]))
    pad_x, pad_y = fs * 0.42, fs * 0.14          # only used by the boxed look

    lines = wrap_lines(font, text, line_px, stroke)
    if not lines:
        return None

    ascent, descent = font.getmetrics()
    line_h = int(round((ascent + descent) * LINE_SPACING))
    block_h = line_h * len(lines) + (int(pad_y * 2) if look["box"] else 0)
    slack = int(stroke + shadow_off + fs * 0.5)
    band_h = block_h + slack * 2

    margin = H * V_MARGIN
    if position == "top":
        top = margin - slack
    elif position == "middle":
        top = (H - band_h) / 2
    else:
        top = H - margin - block_h - slack
    top = int(round(max(0, min(top, max(0, H - band_h)))))

    # lay every word out individually — highlighting one means drawing it in a
    # different colour, which needs its own x. Spacing uses advance widths so
    # word-by-word placement matches how the line measured during wrapping.
    space = font.getlength(" ")
    rows, index = [], 0
    for li, line in enumerate(lines):
        parts = line.split()
        widths = [font.getlength(p) for p in parts]
        line_w = sum(widths) + space * (len(parts) - 1)
        x = (W - line_w) / 2
        y = slack + li * line_h + (int(pad_y) if look["box"] else 0)
        placed = []
        for p, w in zip(parts, widths):
            placed.append({"text": p, "x": x, "y": y, "i": index})
            x += w + space
            index += 1
        rows.append({"words": placed, "y": y, "w": line_w})
    return {"font": font, "stroke": stroke, "shadow": shadow_off, "rows": rows,
            "line_h": line_h, "pad_x": pad_x, "pad_y": pad_y, "slack": slack,
            "band_h": band_h, "top": top, "n_words": index}


def _fade(colour, mul):
    r, g, b, a = colour
    return (r, g, b, max(0, min(255, int(round(a * mul)))))


def draw_cue(Image, ImageDraw, ImageFilter, plan, W, look, fs, active=None,
             dim=DIM_ALPHA):
    """Paint one caption band. `active` lights that word and fades the rest."""
    band = Image.new("RGBA", (W, plan["band_h"]), (0, 0, 0, 0))
    stroke, pad_x, pad_y = plan["stroke"], plan["pad_x"], plan["pad_y"]

    def paint(target, dy, fill, stroke_fill, boxes, act):
        d = ImageDraw.Draw(target)
        for row in plan["rows"]:
            y = row["y"] + dy
            if boxes and look["box"]:
                d.rounded_rectangle(
                    [(W - row["w"]) / 2 - pad_x, y - pad_y,
                     (W + row["w"]) / 2 + pad_x, y + plan["line_h"] + pad_y * 0.2],
                    radius=fs * 0.16, fill=look["box"])
            for word in row["words"]:
                mul = 1.0 if (act is None or word["i"] == act) else dim
                d.text((word["x"], y), word["text"], font=plan["font"],
                       fill=_fade(fill, mul), anchor="la", stroke_width=stroke,
                       stroke_fill=_fade(stroke_fill, mul))

    if plan["shadow"] and look["shadow_alpha"]:
        # The blur is the expensive part and the shadow sits behind the text,
        # where which word is lit doesn't read — so draw it once per caption
        # and reuse it for every word.
        shade = plan.get("_shadow")
        if shade is None:
            a = look["shadow_alpha"]
            shade = Image.new("RGBA", (W, plan["band_h"]), (0, 0, 0, 0))
            paint(shade, plan["shadow"], (0, 0, 0, a), (0, 0, 0, a), False, None)
            shade = shade.filter(ImageFilter.GaussianBlur(max(1.0, fs * 0.035)))
            plan["_shadow"] = shade
        band.alpha_composite(shade)
    paint(band, 0, look["fill"], look["stroke_fill"], True, active)
    return band


def _word_spans(words, start, end):
    """Per-word display windows. A word stays lit until the next one begins, so
    the caption never blinks back to "nothing focused" between words."""
    clean = []
    for w in words or []:
        try:
            text, s, e = w[0], float(w[1]), float(w[2])
        except (TypeError, ValueError, IndexError):
            return []
        if not str(text).strip():
            return []
        clean.append([str(text), max(start, min(s, end)), min(end, max(e, s))])
    if not clean:
        return []
    clean.sort(key=lambda x: x[1])
    spans = []
    for i, (_, s, _e) in enumerate(clean):
        nxt = clean[i + 1][1] if i + 1 < len(clean) else end
        spans.append((max(start, s if i else start), min(end, max(nxt, s))))
    return spans


def render_layer(cues, W, H, tmpdir, style=None):
    """cues: [(start, end, text, words)] on the OUTPUT timeline, ordered and
    non-overlapping; `words` is [(text, start, end)] or None. Draws each caption
    — one frame per spoken word when highlighting is on — and writes a
    concat-demuxer playlist ffmpeg streams as a transparent caption track.

    Returns (playlist, y_offset): the band is only as tall as the captions
    need, so `y_offset` is where it belongs in the frame."""
    if not cues:
        return None
    Image, ImageDraw, ImageFilter, _ = _pil()
    style = style or {}
    look = LOOKS.get(style.get("style") or "outline", LOOKS["outline"])
    position = style.get("position") if style.get("position") in POSITIONS else "bottom"
    highlight = style.get("highlight") is not False
    fs, line_px = metrics(W, H, style)

    # ---- lay every caption out first: the band only has to be as tall as the
    # tallest one, which keeps the PNGs (and the overlay) off the full frame
    planned = []
    for start, end, text, words in cues:
        start, end = max(0.0, float(start)), float(end)
        text = " ".join(str(text or "").split())
        if end - start < 0.1 or not text:
            continue
        plan = plan_cue(text.upper() if look["upper"] else text, W, H, look, fs,
                        line_px, position)
        if not plan:
            continue
        spans = _word_spans(words, start, end) if highlight else []
        # a caption whose words no longer line up with its text (retyped by
        # hand, say) is drawn whole rather than lit in the wrong places
        if len(spans) != plan["n_words"]:
            spans = []
        planned.append((start, end, plan, spans))
    if not planned:
        return None

    top = min(p["top"] for _, _, p, _ in planned)
    bottom = max(p["top"] + p["band_h"] for _, _, p, _ in planned)
    band_h = max(2, min(H - top, bottom - top))

    tmpdir = Path(tmpdir)
    blank = tmpdir / "cap-blank.png"
    Image.new("RGBA", (W, band_h), (0, 0, 0, 0)).save(blank)

    def save(plan, active, n):
        canvas = Image.new("RGBA", (W, band_h), (0, 0, 0, 0))
        canvas.alpha_composite(
            draw_cue(Image, ImageDraw, ImageFilter, plan, W, look, fs, active),
            (0, plan["top"] - top))
        f = tmpdir / f"cap-{n:04d}.png"
        canvas.save(f)
        return f

    entries, cursor, n = [], 0.0, 0
    for start, end, plan, spans in planned:
        if start - cursor > 0.01:
            entries.append((blank, start - cursor))
        for k, (a, b) in enumerate(spans or [(start, end)]):
            if b - a < 0.02:
                continue
            entries.append((save(plan, k if spans else None, n), b - a))
            n += 1
        cursor = end
    if not n:
        return None
    # the concat demuxer only honours a duration when another file follows it
    entries.append((blank, 0.04))
    entries.append((blank, 0.04))

    playlist = tmpdir / "captions.txt"
    playlist.write_text("".join(
        f"file '{f.as_posix()}'\nduration {d:.3f}\n" for f, d in entries),
        encoding="utf-8")
    return playlist, top


def overlay_filter(index, fps, into, out_label, y=0):
    """Filtergraph fragment compositing caption input `index` onto `into`."""
    return (f"[{index}:v]fps={fps:g},format=rgba[caplayer];"
            f"{into}[caplayer]overlay=0:{int(y)}:eof_action=pass{out_label}")
