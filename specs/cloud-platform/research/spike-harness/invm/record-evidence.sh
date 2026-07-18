#!/usr/bin/env bash
# Records the protocol's 90-second evidence artifact from the Xvfb display:
# 1440x900, 24 fps, H.264 → /opt/spike/evidence.mp4. While recording, drives
# the Electron window's live clock so the video shows real motion. Ship the
# file off the box with the provider's download API afterwards.
set -euo pipefail
SPIKE=/opt/spike
DURATION=${1:-90}

ffmpeg -y -f x11grab -video_size 1440x900 -framerate 24 -i :99 \
  -t "$DURATION" -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  "$SPIKE/evidence.mp4"

ls -la "$SPIKE/evidence.mp4"
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$SPIKE/evidence.mp4"
echo "record upload time, integrity (ffprobe on the shipped copy), and egress cost in the result sheet"
