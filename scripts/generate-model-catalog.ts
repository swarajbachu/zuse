#!/usr/bin/env tsx
/**
 * Publish the curated model catalog.
 *
 * Encodes `BUNDLED_MODEL_CATALOG` (packages/contracts/src/model-catalog/
 * bundled.ts) to `apps/web/public/models/v1.json`, which the marketing site
 * serves at https://zuse.sh/models/v1.json. Installed apps fetch that file,
 * so a catalog change ships on merge — no desktop release.
 *
 *   bun run catalog:generate   # write the file
 *   bun run catalog:check      # CI: fail if the committed file is stale
 *
 * The `revision` guard refuses to publish changed content under an
 * unchanged revision: clients keep whichever of remote/bundled carries the
 * higher revision, so an unbumped edit would never reach them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

import {
	BUNDLED_MODEL_CATALOG,
	ModelCatalog,
} from "../packages/contracts/src/model-catalog/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "apps", "web", "public", "models", "v1.json");
const check = process.argv.includes("--check");

const encoded = Schema.encodeSync(ModelCatalog)(BUNDLED_MODEL_CATALOG);
const next = `${JSON.stringify(encoded, null, 2)}\n`;
const current = existsSync(outputPath)
	? readFileSync(outputPath, "utf8")
	: null;

if (current === next) {
	console.log(`Model catalog up to date (revision ${encoded.revision}).`);
	process.exit(0);
}

if (current !== null) {
	let previousRevision: number | null = null;
	try {
		const parsed = JSON.parse(current) as { revision?: unknown };
		previousRevision =
			typeof parsed.revision === "number" ? parsed.revision : null;
	} catch {
		previousRevision = null;
	}
	if (previousRevision !== null && previousRevision >= encoded.revision) {
		console.error(
			`Model catalog content changed but revision ${encoded.revision} is not newer than the published ${previousRevision}.\n` +
				"Bump `revision` in packages/contracts/src/model-catalog/bundled.ts (format YYYYMMDDNN).",
		);
		process.exit(1);
	}
}

if (check) {
	console.error(
		`apps/web/public/models/v1.json is stale. Run \`bun run catalog:generate\` and commit the result.`,
	);
	process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, next);
console.log(
	`Wrote model catalog revision ${encoded.revision} to ${outputPath}`,
);
