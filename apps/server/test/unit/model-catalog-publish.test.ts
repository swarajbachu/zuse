import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_MODEL_CATALOG, ModelCatalog } from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

/**
 * The published catalog (served at https://zuse.sh/models/v1.json) must be
 * regenerated whenever the bundled snapshot changes; otherwise installed
 * apps keep seeing the old list. `bun run catalog:generate` fixes a failure.
 */
const publishedPath = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"web",
	"public",
	"models",
	"v1.json",
);

describe("published model catalog", () => {
	it("matches the bundled snapshot", () => {
		const raw = readFileSync(publishedPath, "utf8");
		const decoded = Schema.decodeUnknownSync(ModelCatalog)(JSON.parse(raw));
		expect(decoded.revision).toBe(BUNDLED_MODEL_CATALOG.revision);
		expect(JSON.parse(raw)).toEqual(
			Schema.encodeSync(ModelCatalog)(BUNDLED_MODEL_CATALOG),
		);
		expect(raw.endsWith("\n")).toBe(true);
	});
});
