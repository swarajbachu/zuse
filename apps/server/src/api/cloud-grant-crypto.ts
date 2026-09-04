import type { SealedCodexGrant, SealedProviderGrant } from "@zuse/contracts";
import type { CryptoKey } from "jose";

type SealedGrant = SealedCodexGrant | SealedProviderGrant;

const webCryptoBytes = (
	value: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> => {
	const bytes = new Uint8Array(value.byteLength);
	bytes.set(value);
	return bytes;
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> =>
	webCryptoBytes(Buffer.from(value, "base64url"));

const additionalData = (sealed: SealedGrant): Uint8Array<ArrayBuffer> =>
	webCryptoBytes(
		new TextEncoder().encode(
			JSON.stringify({
				protocolVersion: sealed.protocolVersion,
				...("providerId" in sealed ? { providerId: sealed.providerId } : {}),
				requestId: sealed.requestId,
				keyThumbprint: sealed.keyThumbprint,
				authorityIncarnationId: sealed.authorityIncarnationId,
				authorityEpoch: sealed.authorityEpoch,
			}),
		),
	);

export const openCloudAuthGrant = async <T>(
	sealed: SealedGrant,
	privateKey: CryptoKey,
	decode: (value: unknown) => T,
): Promise<T> => {
	const rawKey = await crypto.subtle.decrypt(
		{ name: "RSA-OAEP" },
		privateKey,
		fromBase64Url(sealed.wrappedKey),
	);
	const contentKey = await crypto.subtle.importKey(
		"raw",
		rawKey,
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);
	const ciphertext = webCryptoBytes(
		Buffer.concat([
			Buffer.from(sealed.ciphertext, "base64url"),
			Buffer.from(sealed.tag, "base64url"),
		]),
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64Url(sealed.iv),
			additionalData: additionalData(sealed),
			tagLength: 128,
		},
		contentKey,
		ciphertext,
	);
	return decode(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
};
