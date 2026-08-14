export interface CloudTranscriptCiphertext {
	readonly version: 1;
	readonly compression: "gzip";
	readonly iv: string;
	readonly ciphertext: string;
}

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;

export const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
};

export const base64UrlToBytes = (value: string): Uint8Array => {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const transform = async (
	bytes: Uint8Array,
	stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> => {
	const writer = stream.writable.getWriter();
	await writer.write(new Uint8Array(ownedBuffer(bytes)));
	await writer.close();
	return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

export const importCloudTranscriptKey = async (encodedKey: string) => {
	const bytes = base64UrlToBytes(encodedKey);
	if (bytes.byteLength !== 32) throw new Error("invalid transcript key");
	return crypto.subtle.importKey(
		"raw",
		ownedBuffer(bytes),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
};

export const cloudTranscriptAdditionalData = (input: {
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly epoch: string;
	readonly version: number;
	readonly schemaVersion: number;
	readonly pageBeforeSequence?: number;
}): Uint8Array =>
	new TextEncoder().encode(
		`zuse-cloud-transcript-v1\n${input.workspaceId}\n${input.sessionId}\n${input.epoch}\n${input.version}\n${input.schemaVersion}\n${input.pageBeforeSequence === undefined ? "head" : `page:${input.pageBeforeSequence}`}`,
	);

export const encryptCloudTranscript = async (input: {
	readonly encodedKey: string;
	readonly additionalData: Uint8Array;
	readonly plaintext: Uint8Array;
}): Promise<string> => {
	const key = await importCloudTranscriptKey(input.encodedKey);
	const compressed = await transform(
		input.plaintext,
		new CompressionStream("gzip"),
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: ownedBuffer(iv),
			additionalData: ownedBuffer(input.additionalData),
		},
		key,
		ownedBuffer(compressed),
	);
	return JSON.stringify({
		version: 1,
		compression: "gzip",
		iv: bytesToBase64Url(iv),
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
	} satisfies CloudTranscriptCiphertext);
};

export const decryptCloudTranscript = async (input: {
	readonly encodedKey: string;
	readonly additionalData: Uint8Array;
	readonly ciphertext: string;
}): Promise<Uint8Array> => {
	const envelope = JSON.parse(input.ciphertext) as CloudTranscriptCiphertext;
	if (envelope.version !== 1 || envelope.compression !== "gzip") {
		throw new Error("unsupported transcript ciphertext");
	}
	const key = await importCloudTranscriptKey(input.encodedKey);
	const compressed = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: ownedBuffer(base64UrlToBytes(envelope.iv)),
			additionalData: ownedBuffer(input.additionalData),
		},
		key,
		ownedBuffer(base64UrlToBytes(envelope.ciphertext)),
	);
	return transform(new Uint8Array(compressed), new DecompressionStream("gzip"));
};

export const sha256Base64Url = async (
	value: Uint8Array | string,
): Promise<string> =>
	bytesToBase64Url(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				ownedBuffer(
					typeof value === "string" ? new TextEncoder().encode(value) : value,
				),
			),
		),
	);
