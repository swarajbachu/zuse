import { Effect } from "effect";

import type { SponsorCategory, SponsorLine } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

/**
 * Holds the single sponsored line (ADtention) shown in the composer footer.
 * State lives here, not in `SponsorBar`, because the shell remounts that
 * component frequently (boot/render churn, StrictMode) — keeping the line and
 * the serve bookkeeping in a module-level store means a remount neither loses
 * the ad nor re-serves.
 *
 * `refresh(key, category)` serves at most once per unique `key` (session id +
 * latest prompt id). A Set — not just the last key — because while a turn is in
 * flight `messagesBySession` reconciles the optimistic and streamed user
 * message, so the "latest prompt id" thrashes between recent prompts. Tracking
 * only the last key would serve on every flip (a loop); the Set serves once per
 * distinct prompt and ignores the oscillation. The server dwell-gates per
 * install on top of this.
 */
type SponsorState = {
  readonly line: SponsorLine | null;
  readonly refresh: (key: string, category: SponsorCategory) => void;
};

// Module-level (not React state) so remounts don't reset it.
const servedKeys = new Set<string>();

export const useSponsorStore = create<SponsorState>((set) => ({
  line: null,
  refresh: (key, category) => {
    if (servedKeys.has(key)) return;
    servedKeys.add(key);
    void (async () => {
      try {
        const client = await getRpcClient();
        const line = await Effect.runPromise(
          client["sponsor.next"]({ category }),
        );
        set({ line });
      } catch {
        // Serving never hard-fails server-side; ignore transport blips and
        // keep showing the last line (if any).
      }
    })();
  },
}));
