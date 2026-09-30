#!/usr/bin/env bash
# Renders every Blender sequence for the film (Cycles, 810px, 30fps) into renders/<shot>/.
set -e
cd "$(dirname "$0")"
for shot in land hibernate wake fork; do
  mkdir -p renders/$shot
  blender -b -P anim.py -- $shot renders/$shot --res 810 > renders/$shot.log 2>&1
  echo "done $shot $(ls renders/$shot | wc -l) frames"
done
mkdir -p renders/sizes
for s in small standard large; do
  blender -b -P anim.py -- size-$s renders/sizes --res 540 > renders/size-$s.log 2>&1
done
echo "done sizes"
