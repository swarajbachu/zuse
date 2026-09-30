#!/usr/bin/env bash
# Two-pass loudness normalisation of a rendered film's audio (video stream copied untouched).
# House target: -17 LUFS integrated, -1.5 dBTP (the team found -14 too loud for launch films).
# Usage: loudnorm.sh <in.mp4> <out.mp4> [target=-17]
set -euo pipefail
in=$1; out=$2; target=${3:--17}
json=$(ffmpeg -hide_banner -i "$in" -af "loudnorm=I=$target:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/{/,/}/p')
measured=$(printf '%s' "$json" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}\")")
ffmpeg -v error -y -i "$in" -c:v copy -af "loudnorm=I=$target:TP=-1.5:LRA=11:$measured:linear=true,aresample=48000" -c:a aac -b:a 256k -movflags +faststart "$out"
ffmpeg -hide_banner -i "$out" -af ebur128 -f null - 2>&1 | grep -E ' I:' | tail -1
