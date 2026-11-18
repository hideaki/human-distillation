#!/usr/bin/env python3
"""Build the one file that gets published inside Claude.

Takes page.html and puts styles.css, llm.js and app.js inside it, so the
published page has no files of its own to load. Fonts stay as a link.

Run:  python3 live/build.py      writes live/dist/human-distillation.html
"""

import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "dist" / "human-distillation.html"


def local(path):
    return "://" not in path and not path.startswith("/")


def style(match):
    href = match.group(1)
    if not local(href):
        return match.group(0)
    return "<style>\n" + (HERE / href).read_text("utf-8") + "</style>"


def script(match):
    src = match.group(1)
    if not local(src):
        return match.group(0)
    code = (HERE / src).read_text("utf-8").replace("</script", "<\\/script")
    return "<script>\n" + code + "</script>"


page = (HERE / "page.html").read_text("utf-8")
page = re.sub(r'<link rel="stylesheet" href="([^"]+)">', style, page)
page = re.sub(r'<script src="([^"]+)"></script>', script, page)

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(page, "utf-8")
print(f"{OUT.relative_to(HERE.parent)}  {len(page.encode('utf-8')) / 1024:.0f} KB")
