#!/usr/bin/env python3
"""Render a tmux pane (with colours) to a PNG so the layout can be inspected visually.

usage: tui-shot.py <tmux-session> <out.png> [cols] [rows]
Reads `tmux capture-pane -p -e -t <session>` and paints every cell with its SGR
attributes: bold, dim, underline, reverse, 16/256/truecolour fg and bg.
"""
import re, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

session, out = sys.argv[1], sys.argv[2]
raw = subprocess.run(['tmux', 'capture-pane', '-p', '-e', '-t', session], capture_output=True, text=True).stdout
lines = raw.split('\n')
cols = int(sys.argv[3]) if len(sys.argv) > 3 else max(1, max((len(re.sub(r'\x1b\[[0-9;]*m', '', l)) for l in lines), default=80))
rows = int(sys.argv[4]) if len(sys.argv) > 4 else len(lines)

FONT = '/System/Library/Fonts/Menlo.ttc'
SIZE = 15
font = ImageFont.truetype(FONT, SIZE)
bold = ImageFont.truetype(FONT, SIZE, index=1) if True else font
cw, ch = font.getbbox('M')[2], SIZE + 5
BG = (30, 32, 40); FG = (220, 220, 225)
BASE16 = [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(229,229,229),
          (102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)]
def c256(n):
    if n < 16: return BASE16[n]
    if n < 232:
        n -= 16; r, g, b = n // 36, (n // 6) % 6, n % 6
        return tuple(0 if v == 0 else 55 + 40 * v for v in (r, g, b))
    v = 8 + 10 * (n - 232); return (v, v, v)

img = Image.new('RGB', (cols * cw + 16, rows * ch + 16), BG)
draw = ImageDraw.Draw(img)
sgr = re.compile(r'\x1b\[([0-9;]*)m')

for y, line in enumerate(lines[:rows]):
    fg, bg, b, d, u, rev = None, None, False, False, False, False
    x = 0; i = 0
    for part in sgr.split(line):
        if i % 2 == 1:  # SGR parameter string
            ps = [int(p) if p else 0 for p in part.split(';')] if part else [0]
            k = 0
            while k < len(ps):
                p = ps[k]
                if p == 0: fg, bg, b, d, u, rev = None, None, False, False, False, False
                elif p == 1: b = True
                elif p == 2: d = True
                elif p == 4: u = True
                elif p == 7: rev = True
                elif p == 22: b = d = False
                elif p == 24: u = False
                elif p == 27: rev = False
                elif 30 <= p <= 37: fg = BASE16[p - 30]
                elif 90 <= p <= 97: fg = BASE16[p - 90 + 8]
                elif 40 <= p <= 47: bg = BASE16[p - 40]
                elif 100 <= p <= 107: bg = BASE16[p - 100 + 8]
                elif p == 39: fg = None
                elif p == 49: bg = None
                elif p in (38, 48) and k + 1 < len(ps):
                    mode = ps[k + 1]
                    if mode == 5 and k + 2 < len(ps):
                        col = c256(ps[k + 2]); k += 2
                    elif mode == 2 and k + 4 < len(ps):
                        col = (ps[k + 2], ps[k + 3], ps[k + 4]); k += 4
                    else: col = None
                    if p == 38: fg = col
                    else: bg = col
                k += 1
        else:
            for chv in part:
                if x >= cols: break
                f = fg or FG; g = bg
                if d: f = tuple(int(v * 0.55) for v in f)
                if rev: f, g = (g or BG), (fg or FG)
                px, py = 8 + x * cw, 8 + y * ch
                if g: draw.rectangle([px, py, px + cw, py + ch], fill=g)
                if chv != ' ':
                    draw.text((px, py + 2), chv, font=bold if b else font, fill=f)
                if u: draw.line([px, py + ch - 3, px + cw, py + ch - 3], fill=f)
                x += 1
        i += 1
img.save(out)
print(f'{out}: {cols}x{rows} cells, {img.size[0]}x{img.size[1]} px')
