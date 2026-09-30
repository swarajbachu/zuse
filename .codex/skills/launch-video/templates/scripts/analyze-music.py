#!/usr/bin/env python3
"""Tempo, beat phase and a 1-second energy map for candidate tracks (stdlib only; needs ffmpeg).

Usage: python3 analyze-music.py track1.mp3 [track2.mp3 ...]

Read the energy bar like a waveform: drops are a jump to full blocks, breakdowns are a run of
low blocks. Splice only on bar lines: bar k starts at  first_beat + k * 4 * 60 / bpm.
"""
import array
import subprocess
import sys

BLOCKS = " ▁▂▃▄▅▆▇█"


def envelope(path, sr=8000, hop=80):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    a = array.array("h")
    a.frombytes(raw)
    env = []
    for i in range(0, len(a) - hop, hop):
        s = sum(v * v for v in a[i : i + hop : 4])
        env.append((s / (hop / 4)) ** 0.5)
    return env, sr / hop


def tempo(onsets, fps):
    best = (0.0, 0.0)
    for bpm10 in range(900, 1500, 5):
        bpm = bpm10 / 10
        lag = 60 / bpm * fps
        lo, fr = int(lag), lag - int(lag)
        n = min(len(onsets) - lo - 2, 6000)
        score = sum(onsets[i] * (onsets[i + lo] * (1 - fr) + onsets[i + lo + 1] * fr) for i in range(n))
        best = max(best, (score, bpm))
    return best[1]


def phase(onsets, fps, bpm):
    per = 60 / bpm * fps
    count = int(len(onsets) / per) - 2
    candidates = [x * 0.5 for x in range(int(per * 2))]
    score = lambda ph: sum(onsets[int(round(ph + k * per))] for k in range(count))  # noqa: E731
    return max(candidates, key=score) / fps


def bar(values):
    top = max(values) or 1
    return "".join(BLOCKS[min(8, int(v / top * 8.99))] for v in values)


for path in sys.argv[1:]:
    env, fps = envelope(path)
    onsets = [0.0] + [max(0.0, env[i] - env[i - 1]) for i in range(1, len(env))]
    bpm = tempo(onsets, fps)
    first = phase(onsets, fps, bpm)
    per_second = [sum(env[int(i * fps) : int((i + 1) * fps)]) / fps for i in range(int(len(env) / fps))]
    print(f"{path}: ≈{bpm:.1f} BPM · first beat {first:.3f}s · {len(per_second)}s")
    print("  " + bar(per_second))
    print("  " + "".join(str((i // 10) % 10) if i % 10 == 0 else " " for i in range(len(per_second))))
