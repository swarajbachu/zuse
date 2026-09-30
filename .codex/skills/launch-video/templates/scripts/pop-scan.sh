#!/usr/bin/env bash
# Scan a rendered film for single-frame pops: frames whose mean luma change is large.
# Intended punches (a flood, a camera snap on the drop) show up too — every other hit is a seam bug.
# Usage: pop-scan.sh renders/film.mp4 [threshold=25] [fps=60]
set -euo pipefail
video=$1; threshold=${2:-25}; fps=${3:-60}
tmp=$(mktemp)
ffmpeg -v error -i "$video" -vf "scale=240:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=$tmp" -f null -
python3 - "$tmp" "$threshold" "$fps" <<'PY'
import re, sys
values = [float(x) for x in re.findall(r"YAVG=([0-9.]+)", open(sys.argv[1]).read())]
threshold, fps = float(sys.argv[2]), float(sys.argv[3])
hits = [(round((i + 1) / fps, 3), round(v, 1)) for i, v in enumerate(values) if v > threshold]
print(f"{len(values)} frames; frames changing more than {threshold}/255 on average:")
for t, v in hits:
    print(f"  {t:7.3f}s  {v}")
PY
rm -f "$tmp"
