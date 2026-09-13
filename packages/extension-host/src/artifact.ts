import { ExtensionManifest } from "@zuse/contracts";
import { Schema } from "effect";
import type { CompiledExtension } from "./types.ts";
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export interface ExtensionArtifact {
	schemaVersion: 1;
	manifest: typeof ExtensionManifest.Type;
	compiled: CompiledExtension;
}
/** Data-only envelope: no archive extraction, filenames, links, or package installation. */
export function decodeArtifact(
	bytes: Uint8Array,
	expected?: typeof ExtensionManifest.Type,
): ExtensionArtifact {
	if (bytes.byteLength > MAX_ARTIFACT_BYTES)
		throw new Error("Extension artifact exceeds 16 MiB.");
	const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	if (value.schemaVersion !== 1)
		throw new Error("Unsupported extension artifact version.");
	const manifest = Schema.decodeUnknownSync(ExtensionManifest)(value.manifest);
	if (expected && JSON.stringify(manifest) !== JSON.stringify(expected))
		throw new Error("Artifact manifest does not match the signed catalog.");
	for (const [key, limit] of Object.entries({
		clientBundle: 2 * 1024 * 1024,
		serverBundle: 8 * 1024 * 1024,
		clientCss: 256 * 1024,
	})) {
		if (
			typeof value.compiled?.[key] !== "string" ||
			Buffer.byteLength(value.compiled[key]) > limit
		)
			throw new Error(`Invalid or oversized ${key}.`);
	}
	return {
		schemaVersion: 1,
		manifest,
		compiled: {
			clientBundle: value.compiled.clientBundle,
			serverBundle: value.compiled.serverBundle,
			clientCss: value.compiled.clientCss,
		},
	};
}
export async function fetchBounded(
	fetcher: typeof fetch,
	url: string,
	limit: number,
): Promise<Uint8Array> {
	const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`Download failed (${response.status}).`);
	if (Number(response.headers.get("content-length")) > limit)
		throw new Error("Download exceeds size limit.");
	if (!response.body) throw new Error("Download is empty.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error("Download exceeds size limit.");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
