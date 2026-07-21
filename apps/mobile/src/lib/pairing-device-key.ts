import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import * as SecureStore from "expo-secure-store";

const PRIVATE_KEY = "zuse.nearby.x25519.private.v1";
const encoder = new TextEncoder();

const encode = (value: Uint8Array): string => {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
};

const decode = (value: string): Uint8Array => {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const privateKey = async (): Promise<Uint8Array> => {
	const stored = await SecureStore.getItemAsync(PRIVATE_KEY);
	if (stored !== null) return decode(stored);
	const created = x25519.utils.randomSecretKey();
	await SecureStore.setItemAsync(PRIVATE_KEY, encode(created));
	return created;
};

export const pairingDevicePublicKey = async (): Promise<string> =>
	encode(x25519.getPublicKey(await privateKey()));

export const ephemeralPairingPublicKey = (): string =>
	encode(x25519.getPublicKey(x25519.utils.randomSecretKey()));

export type EncryptedPairingCredential = {
	readonly ephemeralPublicKey: string;
	readonly nonce: string;
	readonly ciphertext: string;
};

export const decryptPairingCredential = async (
	envelope: EncryptedPairingCredential,
): Promise<{ readonly token: string; readonly environmentId: string }> => {
	const shared = x25519.getSharedSecret(
		await privateKey(),
		decode(envelope.ephemeralPublicKey),
	);
	const key = hkdf(
		sha256,
		shared,
		undefined,
		encoder.encode("zuse-nearby-credential-v1"),
		32,
	);
	const plaintext = gcm(key, decode(envelope.nonce)).decrypt(
		decode(envelope.ciphertext),
	);
	const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
		token?: unknown;
		environmentId?: unknown;
	};
	if (
		typeof parsed.token !== "string" ||
		typeof parsed.environmentId !== "string"
	) {
		throw new Error("invalid_pairing_credential");
	}
	return { token: parsed.token, environmentId: parsed.environmentId };
};
