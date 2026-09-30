#!/usr/bin/env bash
# Build a music bed from bar-aligned segments of one track, with 8 ms de-click fades at each join
# and a 1.2 s fade-out at the end.
# Usage: splice-music.sh <source.mp3> <out.wav> <start-end> [<start-end> ...]
# Example (Minimal Techno 01, 120 BPM, first beat 0.01): film opens on the breakdown, drop at 16 s:
#   splice-music.sh 201.mp3 bed.wav 24.01-40.01 40.01-56.01 98.01-104.01 104.01-114.01
set -euo pipefail
src=$1; out=$2; shift 2
filters=""; labels=""; total=0; i=0
for seg in "$@"; do
	a=${seg%-*}; b=${seg#*-}
	len=$(python3 -c "print($b - $a)")
	filters+="[0:a]atrim=$a:$b,asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st=$(python3 -c "print($len - 0.008)"):d=0.008[s$i];"
	labels+="[s$i]"; total=$(python3 -c "print($total + $len)"); i=$((i + 1))
done
ffmpeg -v error -y -i "$src" -filter_complex "${filters}${labels}concat=n=$i:v=0:a=1,afade=t=out:st=$(python3 -c "print($total - 1.2)"):d=1.2[o]" -map "[o]" -ar 48000 -ac 2 "$out"
echo "$out: ${total}s"
