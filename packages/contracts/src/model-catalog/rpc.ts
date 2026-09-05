import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ResolvedModelCatalog } from "./resolved.ts";

/**
 * Resolved model catalog for the picker. Returns instantly from the
 * server's in-memory copy; `refresh: true` forces a remote + live refresh
 * (bounded by a server-side timeout, falling back to the current value).
 */
export const ModelCatalogRpc = Rpc.make("model.catalog", {
	payload: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
	success: ResolvedModelCatalog,
});

/**
 * Emits the current resolved catalog on subscribe, then again whenever the
 * curated document or any live inventory changes.
 */
export const ModelCatalogStreamRpc = Rpc.make("model.catalog.stream", {
	payload: Schema.Struct({}),
	success: ResolvedModelCatalog,
	stream: true,
});
