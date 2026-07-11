import { useEffect } from "react";

import { useMessagesStore } from "../store/messages.ts";

/**
 * Mirror the number of currently-running agents to the main process.
 *
 * `runningBySession` (fed by the `session.events` subscription) is the
 * renderer's source of truth for which sessions have an in-flight turn. Main
 * needs the *count* for two things it owns: the `before-quit` guard
 * ("N agents are running — quit anyway?") and the "quit/restart when idle"
 * deferrals. We push on every change (and once on mount) over the preload
 * bridge; main just caches the latest value.
 *
 * Mount once, near the app root.
 */
export function useReportRunningAgents(): void {
  useEffect(() => {
    const report = (count: number) => {
      window.zuse?.updates?.reportRunningCount(count);
    };

    const countRunning = (state: {
      runningBySession: Record<string, boolean>;
    }): number => {
      let count = 0;
      for (const running of Object.values(state.runningBySession)) {
        if (running) count += 1;
      }
      return count;
    };

    let last = countRunning(useMessagesStore.getState());
    report(last);

    return useMessagesStore.subscribe((state) => {
      const next = countRunning(state);
      if (next !== last) {
        last = next;
        report(next);
      }
    });
  }, []);
}
