import { Context, type Effect } from "effect";

import type { ProviderId } from "@zuse/wire";

import type { ProviderRegistryError } from "../errors.ts";
import type { ProviderAdapterShape } from "./provider-adapter.ts";

/**
 * Map from `providerId` to live adapter binding. Populated at boot by
 * `ProviderAdapterRegistryLive` (PR 5/6) merging the per-provider Layers it
 * was given. `ProviderService` consults this to route session-lifecycle
 * RPCs to the right adapter.
 */
export interface ProviderRegistryShape {
  readonly get: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderAdapterShape, ProviderRegistryError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderAdapterShape>>;
}

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  ProviderRegistryShape
>()("memoize/ProviderRegistry") {}
