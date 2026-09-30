#!/usr/bin/env bash
# Encode a rendered PNG sequence to transparent VP9 WebM (+ first/last frame PNGs) in ../assets/blender/.
set -e
cd "$(dirname "$0")"
shot=$1
out=../assets/blender
mkdir -p "$out"
ffmpeg -v error -y -framerate 30 -i "renders/$shot/%04d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 22 -row-mt 1 -auto-alt-ref 0 "$out/$shot.webm"
first=$(ls renders/$shot | head -1); last=$(ls renders/$shot | tail -1)
cp "renders/$shot/$first" "$out/$shot-first.png"; cp "renders/$shot/$last" "$out/$shot-last.png"
echo "$shot: $(ffprobe -v error -show_entries format=duration -of csv=p=0 $out/$shot.webm)s"
