#!/usr/bin/env python3
"""Copy only files needed by the Netlify static site."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site"
FILES = ("index.html", "manifest.json", "sw.js", "icon.svg", "_redirects")
DIRS = ("assets", "css", "js", "img", "vendor", "data")

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
for name in FILES:
    shutil.copy2(ROOT / name, OUT / name)
for name in DIRS:
    shutil.copytree(ROOT / name, OUT / name,
                    ignore=shutil.ignore_patterns("_cache", "__pycache__", "*.pyc"))
print(f"Netlify static output: {OUT}")
