import { bytesToBase64Url } from "./cloud-transcript-crypto.ts";

export const sealCloudAuthSecret = async (
	publicJwk: string,
	secret: string,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"jwk",
		JSON.parse(publicJwk) as JsonWebKey,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	return bytesToBase64Url(
		new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "RSA-OAEP" },
				key,
				new TextEncoder().encode(secret),
			),
		),
	);
};
