import type {
  CompletionSoundPreset,
  SessionId,
  SessionStatus,
} from "@zuse/contracts";

import { useSettingsStore } from "../store/settings.ts";

export const COMPLETION_SOUND_PRESETS: ReadonlyArray<{
  readonly value: CompletionSoundPreset;
  readonly label: string;
}> = [
  { value: "chime", label: "Chime" },
  { value: "soft", label: "Soft" },
  { value: "pop", label: "Pop" },
  { value: "bell", label: "Bell" },
  { value: "rise", label: "Rise" },
  { value: "bloom", label: "Bloom" },
];

let audioContext: AudioContext | null = null;
const lastStatusBySession = new Map<SessionId, SessionStatus>();

const getAudioContext = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  const AudioContextCtor = window.AudioContext;
  if (AudioContextCtor === undefined) return null;
  audioContext ??= new AudioContextCtor();
  return audioContext;
};

const tone = (
  ctx: AudioContext,
  start: number,
  frequency: number,
  duration: number,
  gain: number,
  type: OscillatorType = "sine",
) => {
  const osc = ctx.createOscillator();
  const envelope = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(envelope);
  envelope.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
};

export const playCompletionSound = async (
  preset: CompletionSoundPreset,
): Promise<void> => {
  try {
    const ctx = getAudioContext();
    if (ctx === null) return;
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    if (preset === "soft") {
      tone(ctx, now, 523.25, 0.24, 0.048);
      tone(ctx, now + 0.12, 659.25, 0.32, 0.04);
      return;
    }
    if (preset === "pop") {
      tone(ctx, now, 740, 0.12, 0.06, "triangle");
      tone(ctx, now + 0.08, 987.77, 0.14, 0.034, "triangle");
      return;
    }
    if (preset === "bell") {
      tone(ctx, now, 880, 0.22, 0.052);
      tone(ctx, now + 0.04, 1320, 0.42, 0.024);
      return;
    }
    if (preset === "rise") {
      tone(ctx, now, 440, 0.16, 0.04);
      tone(ctx, now + 0.11, 554.37, 0.18, 0.044);
      tone(ctx, now + 0.23, 659.25, 0.24, 0.04);
      return;
    }
    if (preset === "bloom") {
      tone(ctx, now, 392, 0.34, 0.034);
      tone(ctx, now + 0.04, 493.88, 0.38, 0.035);
      tone(ctx, now + 0.11, 659.25, 0.34, 0.032);
      return;
    }
    tone(ctx, now, 587.33, 0.18, 0.055);
    tone(ctx, now + 0.12, 783.99, 0.28, 0.046);
  } catch {
    // Audio can be blocked until a user gesture; completion sounds are best-effort.
  }
};

export const prepareCompletionSound = async (): Promise<void> => {
  try {
    const ctx = getAudioContext();
    if (ctx === null) return;
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    // Best-effort unlock; preview/completion playback will retry later.
  }
};

export const noteSessionStatusForCompletionSound = (
  sessionId: SessionId,
  status: SessionStatus,
): void => {
  const prev = lastStatusBySession.get(sessionId);
  lastStatusBySession.set(sessionId, status);
  if (prev !== "running" || status === "running") return;
  const settings = useSettingsStore.getState();
  if (!settings.completionSoundEnabled) return;
  void playCompletionSound(settings.completionSoundPreset);
};
