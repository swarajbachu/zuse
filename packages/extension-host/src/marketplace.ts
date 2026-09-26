import { createHash, verify } from "node:crypto";
import type { MarketplaceExtension } from "@zuse/contracts";
import { ExtensionManifest } from "@zuse/contracts";
import { extensionInstallState } from "@zuse/extension-sdk";
import { Schema } from "effect";
import { fetchBounded } from "./artifact.ts";

const MarketplaceCatalogSchema = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	generatedAt: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			manifest: ExtensionManifest,
			commit: Schema.String,
			archiveUrl: Schema.String,
			sha256: Schema.String,
			changelog: Schema.String,
		}),
	),
});

export type MarketplaceCatalog = typeof MarketplaceCatalogSchema.Type;

export const sha256 = (value: Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

export const verifyMarketplaceCatalog = (input: {
	readonly catalogBytes: Uint8Array;
	readonly signatureBase64: string;
	readonly publicKeyPem: string;
}): MarketplaceCatalog => {
	const valid = verify(
		null,
		input.catalogBytes,
		input.publicKeyPem,
		Buffer.from(input.signatureBase64.trim(), "base64"),
	);
	if (!valid) throw new Error("Extension marketplace signature is invalid.");
	const catalog = Schema.decodeUnknownSync(MarketplaceCatalogSchema)(
		JSON.parse(Buffer.from(input.catalogBytes).toString("utf8")),
	);
	const ids = new Set<string>();
	for (const entry of catalog.entries) {
		if (
			ids.has(entry.manifest.id) ||
			!/^[a-f0-9]{40}$/.test(entry.commit) ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			!entry.archiveUrl.startsWith("https://")
		)
			throw new Error("Invalid marketplace entry.");
		ids.add(entry.manifest.id);
	}
	return catalog;
};

export const fetchMarketplaceCatalog = async (input: {
	readonly catalogUrl: string;
	readonly signatureUrl: string;
	readonly publicKeyPem: string;
	readonly fetch: typeof globalThis.fetch;
}): Promise<MarketplaceCatalog> => {
	const [catalogBytes, signatureBytes] = await Promise.all([
		fetchBounded(input.fetch, input.catalogUrl, 1024 * 1024),
		fetchBounded(input.fetch, input.signatureUrl, 1024),
	]);
	return verifyMarketplaceCatalog({
		catalogBytes,
		signatureBase64: Buffer.from(signatureBytes).toString("utf8"),
		publicKeyPem: input.publicKeyPem,
	});
};

export const marketplaceItems = (
	catalog: MarketplaceCatalog,
	installed: ReadonlyMap<
		string,
		{ readonly version: string; readonly commit: string | null }
	>,
): ReadonlyArray<MarketplaceExtension> =>
	catalog.entries.map((entry) => {
		const current = installed.get(entry.manifest.id);
		return {
			id: entry.manifest.id,
			manifest: entry.manifest,
			commit: entry.commit,
			archiveUrl: entry.archiveUrl,
			sha256: entry.sha256,
			changelog: entry.changelog,
			...extensionInstallState(
				{ version: entry.manifest.version, commit: entry.commit },
				current,
			),
		};
	});
