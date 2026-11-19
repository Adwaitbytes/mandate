"""WCAG 2.x contrast ratios for the text pairs each direction uses. Usage: python3 design/contrast.py"""
import re, sys
from pathlib import Path

PAIRS = [("ink", "paper"), ("ink-2", "paper"), ("ink-3", "paper"), ("SEAL", "paper"), ("SEAL_INK", "SEAL"), ("ink", "SHEET"), ("ink-2", "SHEET"), ("SEAL", "WASH")]
NAMES = {
    "a-reporter": {"SEAL": "seal", "SEAL_INK": "seal-ink", "SHEET": "leaf", "WASH": "seal-wash"},
    "b-order-paper": {"SEAL": "green", "SEAL_INK": "green-ink", "SHEET": "sheet", "WASH": "wash"},
    "c-deed": {"SEAL": "stamp", "SEAL_INK": "stamp-ink", "SHEET": "sheet", "WASH": "stamp-wash"},
}

def lum(hex_):
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

def tokens(block):
    return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", block))

for d, names in NAMES.items():
    css = (Path(__file__).parent / "directions" / d / "style.css").read_text()
    light = tokens(css.split("@media (prefers-color-scheme: dark)")[0])
    dark = {**light, **tokens(css.split(':root[data-theme="dark"]')[1].split("}")[0])}
    print(f"\n{d}")
    for mode, t in (("light", light), ("dark", dark)):
        for fg, bg in PAIRS:
            fg_n, bg_n = names.get(fg, fg), names.get(bg, bg)
            r = ratio(t[fg_n], t[bg_n])
            flag = "AA" if r >= 4.5 else ("AA large" if r >= 3 else "FAIL")
            print(f"  {mode:5} --{fg_n:10} on --{bg_n:10} {t[fg_n]} / {t[bg_n]}  {r:5.2f}:1  {flag}")
