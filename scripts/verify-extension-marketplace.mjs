import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeArtifact } from "../packages/extension-host/src/artifact.ts";
import { MARKETPLACE_PUBLIC_KEY } from "../packages/extension-host/src/catalog-key.ts";

import { STAGING_MARKETPLACE_PUBLIC_KEY } from "../packages/extension-host/src/staging-catalog.ts";

const staging = process.argv.includes("--staging");
const publicKey = staging
	? STAGING_MARKETPLACE_PUBLIC_KEY
	: MARKETPLACE_PUBLIC_KEY;
const directory = staging ? "extensions/staging" : "extensions";
const catalogPath = new URL(
	`../apps/web/public/${directory}/catalog.v1.json`,
	import.meta.url,
);
const catalogBytes = await readFile(catalogPath);
const catalog = JSON.parse(catalogBytes.toString("utf8"));
const signature = Buffer.from(
	(
		await readFile(
			new URL(
				`../apps/web/public/${directory}/catalog.v1.sig`,
				import.meta.url,
			),
			"utf8",
		)
	).trim(),
	"base64",
);
if (!verify(null, catalogBytes, publicKey, signature)) {
	throw new Error("Extension marketplace signature is invalid.");
}
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) {
	throw new Error("Invalid extension marketplace catalog.");
}
const ids = new Set();
for (const entry of catalog.entries) {
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(entry?.manifest?.id ?? "")) {
		throw new Error(
			`Invalid extension id: ${entry?.manifest?.id ?? "missing"}`,
		);
	}
	if (ids.has(entry.manifest.id))
		throw new Error(`Duplicate extension id: ${entry.manifest.id}`);
	ids.add(entry.manifest.id);
	if (!/^[0-9a-f]{40}$/.test(entry.commit ?? "")) {
		throw new Error(
			`${entry.manifest.id}: commit must be an immutable 40-character SHA.`,
		);
	}
	if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
		throw new Error(`${entry.manifest.id}: sha256 is invalid.`);
	}
	const artifactPath = new URL(
		`../apps/web/public/${directory}/artifacts/${entry.sha256}.json`,
		import.meta.url,
	);
	const artifact = await readFile(artifactPath);
	decodeArtifact(artifact, entry.manifest);
	const digest = createHash("sha256").update(artifact).digest("hex");
	if (digest !== entry.sha256)
		throw new Error(`${entry.manifest.id}: artifact digest mismatch.`);
	if (
		!String(entry.archiveUrl).endsWith(
			`/${directory}/artifacts/${entry.sha256}.json`,
		)
	) {
		throw new Error(
			`${entry.manifest.id}: archive URL is not content-addressed.`,
		);
	}
}
console.log(
	`Verified ${catalog.entries.length} extension marketplace entries.`,
);
