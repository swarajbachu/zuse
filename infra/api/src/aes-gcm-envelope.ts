export interface AesGcmEnvelope {
	readonly version: 1;
	readonly keyId?: string;
	readonly iv: string;
	readonly ciphertext: string;
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;

export const importAesGcmKey = async (
	encodedKey: string,
): Promise<CryptoKey> => {
	const bytes = base64UrlToBytes(encodedKey);
	if (bytes.byteLength !== 32) throw new Error("invalid AES-256 key");
	return crypto.subtle.importKey(
		"raw",
		ownedBuffer(bytes),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
};

export const encryptAesGcmEnvelope = async (input: {
	readonly key: CryptoKey;
	readonly keyId?: string;
	readonly additionalData: Uint8Array;
	readonly plaintext: Uint8Array;
}): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: ownedBuffer(iv),
			additionalData: ownedBuffer(input.additionalData),
		},
		input.key,
		ownedBuffer(input.plaintext),
	);
	return JSON.stringify({
		version: 1,
		...(input.keyId === undefined ? {} : { keyId: input.keyId }),
		iv: bytesToBase64Url(iv),
		ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
	});
};

export const decryptAesGcmEnvelope = async (input: {
	readonly key: CryptoKey;
	readonly additionalData: Uint8Array;
	readonly envelope: AesGcmEnvelope;
}): Promise<Uint8Array> => {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: ownedBuffer(base64UrlToBytes(input.envelope.iv)),
			additionalData: ownedBuffer(input.additionalData),
		},
		input.key,
		ownedBuffer(base64UrlToBytes(input.envelope.ciphertext)),
	);
	return new Uint8Array(plaintext);
};
