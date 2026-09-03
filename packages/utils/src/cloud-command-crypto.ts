import {
	base64UrlToBytes,
	bytesToBase64Url,
	importCloudTranscriptKey,
} from "./cloud-transcript-crypto.js";

type CommandAadEnvelope = Readonly<{
	workspaceId: string;
	sessionId: string;
	commandId: string;
	kind: string;
	fingerprint: string;
	schemaVersion: number;
	keyVersion: number;
	destructionFence: number;
	createdAt: number;
	dependencies: ReadonlyArray<unknown>;
}>;

const owned = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;

export const cloudCommandAdditionalData = (
	envelope: CommandAadEnvelope,
): Uint8Array =>
	new TextEncoder().encode(
		JSON.stringify([
			"zuse-cloud-command-v3",
			envelope.workspaceId,
			envelope.sessionId,
			envelope.commandId,
			envelope.kind,
			envelope.fingerprint,
			envelope.schemaVersion,
			envelope.keyVersion,
			envelope.destructionFence,
			envelope.createdAt,
			envelope.dependencies,
		]),
	);

export const keyedCloudCommandFingerprint = async (input: {
	readonly encodedKey: string;
	readonly canonicalPlaintext: Uint8Array;
}): Promise<string> => {
	const raw = base64UrlToBytes(input.encodedKey);
	const key = await crypto.subtle.importKey(
		"raw",
		owned(raw),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return `hmac-sha256:${bytesToBase64Url(
		new Uint8Array(
			await crypto.subtle.sign("HMAC", key, owned(input.canonicalPlaintext)),
		),
	)}`;
};

export const encryptCloudCommandBody = async (input: {
	readonly encodedKey: string;
	readonly additionalData: Uint8Array;
	readonly plaintext: Uint8Array;
}): Promise<{ readonly iv: string; readonly ciphertext: string }> => {
	const key = await importCloudTranscriptKey(input.encodedKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: owned(iv),
			additionalData: owned(input.additionalData),
		},
		key,
		owned(input.plaintext),
	);
	return {
		iv: bytesToBase64Url(iv),
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
	};
};

export const decryptCloudCommandBody = async (input: {
	readonly encodedKey: string;
	readonly additionalData: Uint8Array;
	readonly iv: string;
	readonly ciphertext: string;
}): Promise<Uint8Array> => {
	const key = await importCloudTranscriptKey(input.encodedKey);
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: owned(base64UrlToBytes(input.iv)),
				additionalData: owned(input.additionalData),
			},
			key,
			owned(base64UrlToBytes(input.ciphertext)),
		),
	);
};
