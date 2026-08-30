#!/usr/bin/env python3
"""
Compose a recorded demo (scripts/record-demo.mjs output) into a 1280x720
30 fps MP4: agent transcript on the left, the live duck on the right.

    sim/.venv/bin/python scripts/compose-demo.py <rec-dir> [out.mp4]

Needs Pillow (in sim/.venv) and ffmpeg on PATH.
"""
from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 30
CHAT_W = 560
PAD = 18
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
F_TEXT = ImageFont.truetype(str(FONT_DIR / "DejaVuSans.ttf"), 17)
F_BOLD = ImageFont.truetype(str(FONT_DIR / "DejaVuSans-Bold.ttf"), 17)
F_MONO = ImageFont.truetype(str(FONT_DIR / "DejaVuSansMono.ttf"), 15)
F_SMALL = ImageFont.truetype(str(FONT_DIR / "DejaVuSans.ttf"), 13)
F_TITLE = ImageFont.truetype(str(FONT_DIR / "DejaVuSans-Bold.ttf"), 20)

BG = (18, 18, 22)
PANEL = (28, 28, 34)
USER = (48, 66, 110)
ASSIST = (38, 38, 46)
TOOL = (36, 52, 44)
ERR = (78, 36, 36)
FG = (232, 232, 236)
DIM = (150, 150, 160)
ACCENT = (250, 182, 1)  # duck yellow

LEAD_IN_S = 1.0   # video starts this long before the first event
TAIL_S = 2.5      # and runs this long after the last


def load(rec: Path):
    events = [json.loads(l) for l in (rec / "events.jsonl").read_text().splitlines() if l.strip()]
    times = [float(x) for x in (rec / "frames" / "times.txt").read_text().split()]
    frames = sorted((rec / "frames").glob("*.jpg"))
    assert len(frames) == len(times), f"{len(frames)} frames vs {len(times)} times"
    return events, times, frames


def summarize_result(text: str) -> str:
    """One or two useful lines from a tool result, for the chat panel."""
    try:
        d = json.loads(text)
    except Exception:
        return text.strip().splitlines()[0][:80] if text.strip() else ""
    if not isinstance(d, dict):
        return json.dumps(d)[:80]
    keep = []
    for k in ("healthy", "mode", "battery", "policy", "odometry", "applied", "interrupted", "behavior",
              "started", "note", "accepted", "limited_by", "safety", "move"):
        if k in d:
            v = d[k]
            if isinstance(v, dict):
                v = {kk: vv for kk, vv in v.items() if not isinstance(vv, (dict, list)) or kk in ("applied", "limited_by")}
            keep.append(f"{k}: {json.dumps(v)}")
    return "\n".join(keep[:4]) if keep else json.dumps(d)[:80]


class Chat:
    """Renders the transcript panel for a given time."""

    def __init__(self, events, t0):
        self.items = []
        names = {}
        for e in events:
            t = e["t"] - t0
            if e["type"] == "user":
                self.items.append((t, "user", e["text"], None))
            elif e["type"] == "assistant":
                self.items.append((t, "assistant", e["text"], None))
            elif e["type"] == "tool_use":
                names[e["id"]] = e["name"]
                args = ", ".join(f"{k}={json.dumps(v)}" for k, v in e["input"].items())
                self.items.append((t, "tool", f"▶ {e['name']}({args})", None))
            elif e["type"] == "tool_result":
                if not e["text"] and not e.get("image"):
                    continue  # ToolSearch plumbing, not a robot call
                img = None
                if e.get("image"):
                    img = Image.open(io.BytesIO(base64.b64decode(e["image"]))).convert("RGB")
                kind = "error" if e.get("is_error") or e["text"].startswith("Error:") else "result"
                self.items.append((t, kind, summarize_result(e["text"]), img))
        self.cache = {}

    def bubble(self, kind, text, img):
        width = CHAT_W - 2 * PAD
        font = F_MONO if kind in ("tool", "result", "error") else F_TEXT
        chars = 52 if font is F_MONO else 46
        lines = []
        for para in text.split("\n"):
            lines += textwrap.wrap(para, chars) or [""]
        lh = 21 if font is F_TEXT else 19
        h = 14 + lh * len(lines) + (img.height // 2 + 10 if img else 0)
        im = Image.new("RGB", (width, h), {"user": USER, "assistant": ASSIST, "tool": TOOL, "result": PANEL, "error": ERR}[kind])
        d = ImageDraw.Draw(im)
        y = 7
        for ln in lines:
            d.text((12, y), ln, font=font, fill=FG if kind != "result" else DIM)
            y += lh
        if img:
            small = img.resize((img.width // 2, img.height // 2))
            im.paste(small, (12, y + 4))
        return im

    def render(self, t):
        visible = [it for it in self.items if it[0] <= t]
        key = len(visible)
        if key in self.cache:
            return self.cache[key]
        panel = Image.new("RGB", (CHAT_W, H), BG)
        d = ImageDraw.Draw(panel)
        d.text((PAD, 14), "Claude Code  ·  microduck-mcp", font=F_TITLE, fill=ACCENT)
        d.text((PAD, 42), "headless `claude -p`, tools over MCP, DUCK_TRANSPORT=sim", font=F_SMALL, fill=DIM)
        bubbles = [self.bubble(k, txt, img) for _, k, txt, img in visible]
        total = sum(b.height + 8 for b in bubbles)
        y = 70
        top = max(0, total - (H - y - PAD))
        for b in bubbles:
            if y - top + b.height > 66:
                panel.paste(b, (PAD, y - top)) if y - top >= 66 else None
            y += b.height + 8
        # header mask so scrolled bubbles don't bleed into the title
        d.rectangle((0, 0, CHAT_W, 66), fill=BG)
        d.text((PAD, 14), "Claude Code  ·  microduck-mcp", font=F_TITLE, fill=ACCENT)
        d.text((PAD, 42), "headless `claude -p`, tools over MCP, DUCK_TRANSPORT=sim", font=F_SMALL, fill=DIM)
        self.cache[key] = panel
        return panel


def main():
    rec = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else rec / "demo.mp4"
    events, times, frames = load(rec)
    ev_times = [e["t"] for e in events if e["type"] != "end"]
    t_start = min(ev_times[0], times[0]) - LEAD_IN_S
    t_end = max(ev_times[-1], times[-1]) + TAIL_S
    chat = Chat(events, t_start)
    n = int((t_end - t_start) * FPS)
    print(f"{len(frames)} sim frames, {len(events)} events, {n} output frames ({n / FPS:.1f}s)")

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
         "-movflags", "+faststart", str(out)],
        stdin=subprocess.PIPE,
    )
    sim_x, sim_y, sim_w, sim_h = CHAT_W + PAD, 70, W - CHAT_W - 2 * PAD, int((W - CHAT_W - 2 * PAD) * 3 / 4)
    fi = 0
    last_frame_img = None
    waiting = Image.new("RGB", (sim_w, sim_h), PANEL)
    ImageDraw.Draw(waiting).text((sim_w // 2 - 90, sim_h // 2 - 10), "starting MuJoCo…", font=F_TEXT, fill=DIM)
    for i in range(n):
        t = t_start + i / FPS
        while fi + 1 < len(times) and times[fi + 1] <= t:
            fi += 1
        canvas = Image.new("RGB", (W, H), BG)
        canvas.paste(chat.render(t - t_start), (0, 0))
        if times[fi] <= t:
            if last_frame_img is None or last_frame_img[0] != fi:
                last_frame_img = (fi, Image.open(frames[fi]).convert("RGB").resize((sim_w, sim_h)))
            canvas.paste(last_frame_img[1], (sim_x, sim_y))
        else:
            canvas.paste(waiting, (sim_x, sim_y))
        d = ImageDraw.Draw(canvas)
        d.text((sim_x, 14), "MuJoCo  ·  Pollen's official ONNX policies  ·  50 Hz", font=F_TITLE, fill=ACCENT)
        d.text((sim_x, 42), "microduck_rl scene · robotd control chain ported in sim/duck_sim.py · live, 30 fps", font=F_SMALL, fill=DIM)
        d.text((sim_x, sim_y + sim_h + 14), f"t = {t - t_start:5.1f} s", font=F_MONO, fill=DIM)
        d.text((sim_x + 140, sim_y + sim_h + 14), "github.com/joeynyc/microduck-mcp  ·  microduckhub.com", font=F_MONO, fill=DIM)
        ff.stdin.write(canvas.tobytes())
    ff.stdin.close()
    ff.wait()
    print(f"→ {out}")


if __name__ == "__main__":
    main()
