# Music and sound

## Taste

- **Minimal techno / deep house, ~120 BPM** — clean kick, restrained, no vocals, no cinematic risers.
  120 BPM makes the maths easy: 1 beat = 0.5s, 1 bar = 2s, so every event lands on a half second.
- The track needs a **drop** and a **quiet breakdown** with a clean **beat return**. Structure is
  more important than the exact vibe; you will cut it to fit.
- Music + on-screen text, no voiceover (feeds autoplay muted; the text must carry the story alone).
- Proven pick: Mixkit "Minimal Techno 01" (`https://assets.mixkit.co/music/201/201.mp3`, 120.0 BPM,
  first beat 0.01s; breakdown 24–40s, drop at 40s, short breakdown 96–104s, second drop at 104s).
  Other decent 120s from the same pass: "Dance Zero" (#836). Mixkit is free for commercial use.

## Finding a track

Mixkit listing pages (`https://mixkit.co/free-stock-music/house/`, `/electronic/`, `/tech-house/`)
embed preview URLs `https://assets.mixkit.co/music/<id>/<id>.mp3`. Download 6–10 candidates and run
`templates/scripts/analyze-music.py *.mp3` — it prints tempo, beat phase and a 1-second energy strip.
Drops are a jump to full blocks; breakdowns are runs of low blocks.

## Mapping the film to the music

| Film moment | Music |
| --- | --- |
| Open / brand lock-up | a breakdown or intro (sparse, lets the wordmark breathe) |
| First big product moment (the zoom into the feature) | **the drop** — land the camera punch exactly on it |
| How-to steps | full groove |
| The quiet/"step away" beat | the breakdown |
| Payoff ("back in 1–2 seconds") | **the beat return** |
| Close + loop | groove, 1.2s fade out |

## Editing

`templates/scripts/splice-music.sh src.mp3 bed.wav a-b c-d …` joins bar-aligned segments with 8ms
de-click fades and a 1.2s tail fade. Splice only on bar lines (`first_beat + k × 2s` at 120 BPM).
Make one bed per variant (e.g. with/without a removable 2-bar beat). Put the bed in the index as a
single `<audio id>` with `data-volume ≈ 0.8`.

## SFX

- One real sound per real event (click, pop, whoosh, chime, typing) — never synthesised.
  Mixkit SFX pages (`/free-sound-effects/click/`, `/whoosh/`, `/pop/`, `/typing/`, `/interface/`)
  embed `https://assets.mixkit.co/active_storage/sfx/<id>/<id>-preview.mp3`.
- The set we used (ids): click 2568, click2 1133, pop 2356, pop2 2357, whoosh 1485, swoosh 1491,
  air 1492, chime 1110, typing 1392 (trimmed 1.6s).
- Place by the **peak**, not the file start: `data-start = event − peak`
  (`templates/scripts/sfx-peaks.py`). Keep volumes 0.35–0.7; quieter in the breakdown.
- SFX live inside each frame's sub-composition (local time) with unique ids and
  `data-hf-media-start-basis="local"` (silences the nested-media lint warning).

## Loudness

Master every deliverable with `templates/scripts/loudnorm.sh in.mp4 out.mp4` → **−17 LUFS integrated,
−1.5 dBTP**. We first shipped at −14 LUFS and it was too loud for the team's taste.
