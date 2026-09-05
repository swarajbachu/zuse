import { Schema } from "effect";

import { ModelOption } from "../agent.ts";

/**
 * Per-million-token USD pricing used by the renderer to compute the
 * "saved ~$X" line in the per-agent cost footer. Numbers are reference
 * values — keep aligned with vendor pricing pages. The wire stays just
 * numbers; conversion to currency happens renderer-side.
 */
export const ModelPricing = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheCreate: Schema.Number,
});
export type ModelPricing = typeof ModelPricing.Type;

/**
 * Curated entry for one provider: the ordered picker seed plus slug aliases
 * that route retired / shorthand ids to a canonical model id.
 */
export const ModelCatalogProvider = Schema.Struct({
	models: Schema.Array(ModelOption),
	aliases: Schema.Record(Schema.String, Schema.String),
});
export type ModelCatalogProvider = typeof ModelCatalogProvider.Type;

export const MODEL_CATALOG_SCHEMA_VERSION = 1;

/**
 * The curated model catalog document. This exact shape is what
 * `BUNDLED_MODEL_CATALOG` satisfies, what `scripts/generate-model-catalog.ts`
 * publishes to `https://zuse.sh/models/v1.json`, and what the server decodes
 * from the network.
 *
 *   - `schemaVersion` — bump on incompatible shape changes; clients ignore
 *     documents whose version they don't understand.
 *   - `revision` — monotonic integer (`YYYYMMDDNN`). The server keeps whichever
 *     of remote/bundled carries the higher revision so a stale CDN copy can
 *     never downgrade a fresh build.
 *   - `providers` — keyed by `ProviderId`. Keys are strings on the wire so an
 *     older app tolerates providers it doesn't know and a newer app fills in
 *     providers a stale document lacks from its bundled snapshot.
 */
export const ModelCatalog = Schema.Struct({
	schemaVersion: Schema.Literal(MODEL_CATALOG_SCHEMA_VERSION),
	revision: Schema.Number,
	generatedAt: Schema.String,
	providers: Schema.Record(Schema.String, ModelCatalogProvider),
	pricing: Schema.Record(Schema.String, ModelPricing),
});
export type ModelCatalog = typeof ModelCatalog.Type;
