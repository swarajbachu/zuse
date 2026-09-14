import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeArtifact } from "../packages/extension-host/src/artifact.ts";
import { MARKETPLACE_PUBLIC_KEY } from "../packages/extension-host/src/catalog-key.ts";
import { compileExtension } from "../packages/extension-host/src/compiler.ts";
import {
	assertApiCompatible,
	compileEntries,
	readExtensionManifest,
} from "../packages/extension-host/src/manifest.ts";
import {
	STAGING_MARKETPLACE_BASE_URL,
	STAGING_MARKETPLACE_PUBLIC_KEY,
} from "../packages/extension-host/src/staging-catalog.ts";

const output = resolve(
	process.env.EXTENSION_OUTPUT ?? ".context/extensions-release",
);
const staging = process.argv.includes("--staging");
const publicKey = staging
	? STAGING_MARKETPLACE_PUBLIC_KEY
	: MARKETPLACE_PUBLIC_KEY;
const base = (
	process.env.EXTENSION_ARTIFACT_BASE_URL ??
	(staging ? STAGING_MARKETPLACE_BASE_URL : "https://zuse.sh/extensions")
).replace(/\/$/, "");
if (new URL(base).protocol !== "https:")
	throw new Error("Artifact hosting requires HTTPS.");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
await mkdir(join(output, "artifacts"), { recursive: true });
const entries = [];
for (const id of ["test-reports", "project-playbook", "code-follow-ups"]) {
	const directory = resolve("extensions", id);
	const manifest = await readExtensionManifest(directory);
	assertApiCompatible(manifest.zuseApi);
	const compiled = await compileExtension(compileEntries(directory, manifest));
	const artifact = Buffer.from(
		JSON.stringify({ schemaVersion: 1, manifest, compiled }),
	);
	decodeArtifact(artifact, manifest);
	const digest = createHash("sha256").update(artifact).digest("hex");
	await writeFile(join(output, "artifacts", `${digest}.json`), artifact);
	entries.push({
		manifest,
		commit,
		archiveUrl: `${base}/artifacts/${digest}.json`,
		sha256: digest,
		changelog: "Initial desktop preview.",
	});
}
const bytes = Buffer.from(
	`${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
);
await writeFile(join(output, "catalog.v1.json"), bytes);
if (process.argv.includes("--sign")) {
	const path = process.env.EXTENSION_SIGNING_KEY_FILE;
	if (!path)
		throw new Error(
			"EXTENSION_SIGNING_KEY_FILE is required. Unsigned artifacts are validation output only.",
		);
	const key = await readFile(path, "utf8");
	const signature = sign(null, bytes, key);
	// Proves that the protected credential matches the trust root shipped in desktop.
	if (
		createPublicKey(key).asymmetricKeyType !== "ed25519" ||
		!verify(null, bytes, publicKey, signature)
	)
		throw new Error(
			"Signing credential does not match the desktop trust root.",
		);
	await writeFile(
		join(output, "catalog.v1.sig"),
		`${signature.toString("base64")}\n`,
	);
}
console.log(
	`Built ${entries.length} validated artifacts in ${output}. ${process.argv.includes("--sign") ? "Signature verified." : "UNSIGNED: not publishable."}`,
);
