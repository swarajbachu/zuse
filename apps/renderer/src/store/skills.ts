import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import type { SessionId, Skill } from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Per-session skill list, fed by `skill.stream`. Mirrors the messages
 * store's Fiber pattern — one live fiber at a time per renderer; switching
 * sessions tears down the previous subscription. The slash popover reads
 * `skillsBySession[activeSessionId]`.
 */
type SkillsState = {
  readonly skillsBySession: Record<string, ReadonlyArray<Skill>>;
  readonly hydrate: (sessionId: SessionId) => Promise<void>;
};

const EMPTY: ReadonlyArray<Skill> = [];

let liveFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
let liveSessionId: SessionId | null = null;

const stopLiveFiber = async (): Promise<void> => {
  if (liveFiber !== null) {
    const f = liveFiber;
    liveFiber = null;
    liveSessionId = null;
    await Effect.runPromise(Fiber.interrupt(f));
  }
};

export const useSkillsStore = create<SkillsState>((set) => ({
  skillsBySession: {},
  hydrate: async (sessionId) => {
    if (liveSessionId === sessionId && liveFiber !== null) return;
    await stopLiveFiber();
    liveSessionId = sessionId;
    set((s) => ({
      skillsBySession: { ...s.skillsBySession, [sessionId]: EMPTY },
    }));
    try {
      const client = await getRpcClient();
      liveFiber = Effect.runFork(
        Stream.runForEach(client.skill.stream({ sessionId }), (list) =>
          Effect.sync(() => {
            set((s) => ({
              skillsBySession: { ...s.skillsBySession, [sessionId]: list },
            }));
          }),
        ),
      );
    } catch {
      // Best-effort: if the stream errors (e.g. session not found), keep
      // the empty list — the slash popover degrades to built-ins only.
    }
  },
}));
