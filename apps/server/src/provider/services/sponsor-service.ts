import { Context, type Effect } from "effect";

import type { SponsorCategory, SponsorLine } from "@zuse/contracts";

/**
 * Serves a sponsor line for a category. Lives in the server (not the renderer)
 * for three reasons: the ad API sends no CORS headers so a browser-origin call
 * is blocked in the packaged app; the install's opaque `subject` id is held and
 * persisted here; and the public `publisher_id` stays out of the renderer
 * bundle's hot path. `next` never fails — no-fill, a missing publisher id, or a
 * transient network error all resolve to `null`.
 */
export interface SponsorServiceShape {
  readonly next: (
    category: SponsorCategory,
  ) => Effect.Effect<SponsorLine | null>;
}

export class SponsorService extends Context.Service<
  SponsorService,
  SponsorServiceShape
>()("memoize/SponsorService") {}
