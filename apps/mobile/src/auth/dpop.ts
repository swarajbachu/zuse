import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { calculateJwkThumbprint, type JWK } from "jose";

/**
 * Device DPoP key (RFC 9449). A per-install ES256 keypair proves possession of
 * the key on every relay call; the relay binds minted access tokens to its
 * thumbprint. Requires WebCrypto — provided by react-native-quick-crypto's
 * `install()` in polyfills.ts (Expo Go won't have it; use a dev client).
 */
const PRIVATE_KEY = "zuse.mobile.dpop.private.v1";
const PUBLIC_KEY = "zuse.mobile.dpop.public.v1";

interface DeviceKey {
	readonly privateJwk: JWK & { readonly d: string };
	readonly publicJwk: JWK;
}

let cached: DeviceKey | null = null;

export const clearDeviceKey = async (): Promise<void> => {
	cached = null;
	await Promise.all([
		SecureStore.deleteItemAsync(PRIVATE_KEY),
		SecureStore.deleteItemAsync(PUBLIC_KEY),
	]);
};

const loadOrCreate = async (): Promise<DeviceKey> => {
	if (cached !== null) return cached;
	const [priv, pub] = await Promise.all([
		SecureStore.getItemAsync(PRIVATE_KEY),
		SecureStore.getItemAsync(PUBLIC_KEY),
	]);
	if (priv !== null && pub !== null) {
		const restored = await restoreStoredKey(priv, pub);
		if (restored !== null) {
			cached = restored;
			return cached;
		}
	}
	cached = await createAndStoreKey();
	return cached;
};

const createAndStoreKey = async (): Promise<DeviceKey> => {
	const privateKey = generatePrivateKey();
	const publicJwk = publicJwkFromPrivateKey(privateKey);
	const privateJwk = { ...publicJwk, d: base64UrlBytes(privateKey) };
	await Promise.all([
		SecureStore.setItemAsync(PRIVATE_KEY, JSON.stringify(privateJwk)),
		SecureStore.setItemAsync(PUBLIC_KEY, JSON.stringify(publicJwk)),
	]);
	return { privateJwk, publicJwk };
};

const restoreStoredKey = async (
	privateJson: string,
	publicJson: string,
): Promise<DeviceKey | null> => {
	try {
		const privateJwk = parsePrivateJwk(JSON.parse(privateJson));
		const publicJwk = JSON.parse(publicJson) as JWK;
		const privateKey = base64UrlToBytes(privateJwk.d);
		if (!p256.utils.isValidPrivateKey(privateKey)) {
			throw new Error("mobile_dpop_private_key_invalid");
		}
		const derivedPublicJwk = publicJwkFromPrivateKey(privateKey);
		if (
			derivedPublicJwk.x !== publicJwk.x ||
			derivedPublicJwk.y !== publicJwk.y
		) {
			throw new Error("mobile_dpop_public_key_mismatch");
		}
		return { privateJwk, publicJwk };
	} catch {
		await Promise.all([
			SecureStore.deleteItemAsync(PRIVATE_KEY),
			SecureStore.deleteItemAsync(PUBLIC_KEY),
		]);
		return null;
	}
};

export const devicePublicJwk = async (): Promise<JWK> =>
	(await loadOrCreate()).publicJwk;

export const deviceThumbprint = async (): Promise<string> =>
	calculateJwkThumbprint(await devicePublicJwk());

/**
 * Build a DPoP proof JWS for a specific request. `htm`/`htu` bind it to this
 * method + URL; a fresh `jti` makes it single-use (the relay rejects replays).
 */
export const signDpopProof = async (input: {
	readonly method: string;
	readonly url: string;
}): Promise<string> => {
	const { privateJwk, publicJwk } = await loadOrCreate();
	const protectedHeader = {
		alg: "ES256",
		typ: "dpop+jwt",
		jwk: publicJwk,
	};
	const payload = {
		htm: input.method.toUpperCase(),
		htu: normalizeUrl(input.url),
		jti: cryptoRandomId(),
		iat: Math.floor(Date.now() / 1000),
	};
	const signingInput = `${base64UrlJson(protectedHeader)}.${base64UrlJson(payload)}`;
	const privateKey = base64UrlToBytes(privateJwk.d);
	const signature = p256
		.sign(sha256(new TextEncoder().encode(signingInput)), privateKey, {
			prehash: false,
		})
		.toCompactRawBytes();
	return `${signingInput}.${base64UrlBytes(signature)}`;
};

const generatePrivateKey = (): Uint8Array => {
	for (;;) {
		const privateKey = ExpoCrypto.getRandomBytes(32);
		if (p256.utils.isValidPrivateKey(privateKey)) return privateKey;
	}
};

const publicJwkFromPrivateKey = (privateKey: Uint8Array): JWK => {
	const publicKey = p256.getPublicKey(privateKey, false);
	if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
		throw new Error("mobile_dpop_public_key_invalid");
	}
	return {
		kty: "EC",
		crv: "P-256",
		alg: "ES256",
		key_ops: ["verify"],
		ext: true,
		x: base64UrlBytes(publicKey.slice(1, 33)),
		y: base64UrlBytes(publicKey.slice(33, 65)),
	};
};

const parsePrivateJwk = (value: unknown): JWK & { readonly d: string } => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("d" in value) ||
		typeof value.d !== "string"
	) {
		throw new Error("mobile_dpop_private_jwk_invalid");
	}
	return value as JWK & { readonly d: string };
};

const base64UrlJson = (value: unknown): string =>
	base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));

const base64UrlBytes = (bytes: Uint8Array): string => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let output = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i] ?? 0;
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		output += alphabet.charAt(a >> 2);
		output += alphabet.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
		if (b === undefined) break;
		output += alphabet.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
		if (c === undefined) break;
		output += alphabet.charAt(c & 63);
	}
	return output;
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const clean = value.replace(/=+$/g, "");
	if (clean.length % 4 === 1) {
		throw new Error("mobile_dpop_base64url_invalid_length");
	}
	const bytes: number[] = [];
	for (let index = 0; index < clean.length; index += 4) {
		const chunk = clean.slice(index, index + 4);
		const values = [...chunk].map((char) => alphabet.indexOf(char));
		if (values.some((item) => item < 0)) {
			throw new Error("mobile_dpop_base64url_invalid_character");
		}
		const [a = 0, b = 0, c = 0, d = 0] = values;
		const triple = (a << 18) | (b << 12) | (c << 6) | d;
		bytes.push((triple >> 16) & 0xff);
		if (chunk.length > 2) bytes.push((triple >> 8) & 0xff);
		if (chunk.length > 3) bytes.push(triple & 0xff);
	}
	return new Uint8Array(bytes);
};

const normalizeUrl = (value: string): string => {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return value;
	}
};

const cryptoRandomId = (): string => {
	// crypto.randomUUID is available once react-native-quick-crypto is installed.
	const maybe = (globalThis.crypto as { randomUUID?: () => string } | undefined)
		?.randomUUID;
	if (typeof maybe === "function") return maybe.call(globalThis.crypto);
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};
