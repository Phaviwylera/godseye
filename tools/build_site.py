#!/usr/bin/env python3
"""Copy only files needed by the Netlify static site."""
from pathlib import Path
import shutil
from build_coverage import main as build_coverage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site"
FILES = ("index.html", "manifest.json", "sw.js", "icon.svg", "_redirects")
DIRS = ("assets", "css", "js", "img", "vendor", "data")

build_coverage()

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
for name in FILES:
    shutil.copy2(ROOT / name, OUT / name)
for name in DIRS:
    ignored = ["_cache", "__pycache__", "*.pyc"]
    # liveness.json is an operator-facing resumable probe log. The browser reads
    # liveness.bin instead, so do not ship the 2.7 MB id map in the static site.
    if name == "data":
        ignored.append("liveness.json")
    shutil.copytree(ROOT / name, OUT / name, ignore=shutil.ignore_patterns(*ignored))
print(f"Netlify static output: {OUT}")
