import { Effect, Fiber, Stream } from "effect";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import type { Message, SessionId } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

type SidebarMessageStatusState = {
  readonly messagesBySession: Record<string, ReadonlyArray<Message>>;
};

export const useSidebarMessageStatusStore = create<SidebarMessageStatusState>(
  () => ({
    messagesBySession: {},
  }),
);

// Highest envelope `sequence` seen per session; passed as `sinceSequence`
// when a fiber is re-forked for a session we already hold rows for, so the
// server replays only the delta instead of the whole history.
const lastSequenceBySession = new Map<SessionId, number>();

export function useSidebarMessageStatusSubscriptions(
  sessionIds: ReadonlyArray<SessionId>,
) {
  const fibersRef = useRef<
    Map<SessionId, Fiber.RuntimeFiber<unknown, unknown>>
  >(new Map());
  const idsKey = sessionIds.join(",");

  useEffect(() => {
    const tracked = fibersRef.current;
    const incoming = new Set(sessionIds);
    const toAdd = sessionIds.filter((id) => !tracked.has(id));
    const toRemove = Array.from(tracked.keys()).filter(
      (id) => !incoming.has(id),
    );

    for (const id of toRemove) {
      const fiber = tracked.get(id);
      tracked.delete(id);
      if (fiber !== undefined) {
        void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
      }
    }

    if (toAdd.length === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const client = await getRpcClient();
        if (cancelled) return;
        for (const id of toAdd) {
          if (tracked.has(id)) continue;
          const sinceSequence =
            (useSidebarMessageStatusStore.getState().messagesBySession[id]
              ?.length ?? 0) > 0
              ? lastSequenceBySession.get(id)
              : undefined;
          const fiber = Effect.runFork(
            Stream.runForEach(
              client["messages.stream"]({ sessionId: id, sinceSequence }),
              (envelope) =>
                Effect.sync(() => {
                  const { sequence, message } = envelope;
                  const prev = lastSequenceBySession.get(id) ?? 0;
                  if (sequence > prev) lastSequenceBySession.set(id, sequence);
                  useSidebarMessageStatusStore.setState((s) => {
                    const current = s.messagesBySession[id] ?? [];
                    if (current.some((row) => row.id === message.id)) return s;
                    return {
                      messagesBySession: {
                        ...s.messagesBySession,
                        [id]: [...current, message],
                      },
                    };
                  });
                }),
            ),
          );
          tracked.set(id, fiber);
        }
      } catch {
        // Best-effort sidebar signal; the active chat surface remains canonical.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => {
    return () => {
      const tracked = fibersRef.current;
      for (const fiber of tracked.values()) {
        void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
      }
      tracked.clear();
    };
  }, []);
}
