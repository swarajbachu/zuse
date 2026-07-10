import { Context, type Effect } from "effect";

import type { ProviderId, Skill } from "@zuse/contracts";

/**
 * Per-provider skill discovery on disk.
 *
 * The active provider's CLI owns the format and directory layout for skills;
 * this service mirrors what each tool would surface when the user types `/`
 * inside it directly. See the amendment in
 * `specs/0.03-MVP/decisions/0011-skills-via-provider.md` for why we read
 * disk instead of routing through the SDK API for 0.03.
 *
 * Returns a flat `Skill[]` with project-scoped entries first (popover
 * precedence): project skills shadow globals with the same name.
 */
export interface SkillDiscoveryServiceShape {
  readonly discover: (
    providerId: ProviderId,
    projectCwd: string,
  ) => Effect.Effect<ReadonlyArray<Skill>>;
}

export class SkillDiscoveryService extends Context.Service<SkillDiscoveryService, SkillDiscoveryServiceShape>()(
  "memoize/SkillDiscoveryService",
) {}
