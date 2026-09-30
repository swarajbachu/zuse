#!/usr/bin/env python3
"""Print duration and peak offset of each SFX file. Place an SFX so its PEAK lands on the event:
data-start = event_time - peak.  Usage: python3 sfx-peaks.py assets/sfx/*.wav"""
import array
import subprocess
import sys

for path in sys.argv[1:]:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    a = array.array("h")
    a.frombytes(raw)
    peak = max(range(len(a)), key=lambda k: abs(a[k]))
    print(f"{path.split('/')[-1]:14s} dur={len(a) / 8000:.2f}s  peak={peak / 8000:.3f}s")
