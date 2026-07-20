import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import type { NearbyPairingRequest } from "@zuse/contracts";
import type { EncryptedPairingCredential } from "./pairing-device-key";

const SAFETY_WORDS = [
	"amber",
	"apple",
	"birch",
	"blue",
	"cedar",
	"cloud",
	"coral",
	"dawn",
	"ember",
	"fern",
	"field",
	"gold",
	"harbor",
	"indigo",
	"jade",
	"kite",
	"lake",
	"leaf",
	"lunar",
	"maple",
	"mint",
	"ocean",
	"pearl",
	"pine",
	"river",
	"rose",
	"silver",
	"sky",
	"stone",
	"sun",
	"violet",
	"willow",
] as const;

const digest = (value: string): Uint8Array =>
	sha256(new TextEncoder().encode(value));

const base64Url = (bytes: Uint8Array): string => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const a = bytes[index] ?? 0;
		const b = bytes[index + 1];
		const c = bytes[index + 2];
		output += alphabet.charAt(a >> 2);
		output += alphabet.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
		if (b === undefined) break;
		output += alphabet.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
		if (c === undefined) break;
		output += alphabet.charAt(c & 63);
	}
	return output;
};

const fromBase64Url = (value: string): Uint8Array => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let bits = 0;
	let bitCount = 0;
	const output: number[] = [];
	for (const character of value) {
		const index = alphabet.indexOf(character);
		if (index < 0) throw new Error("invalid_base64url");
		bits = (bits << 6) | index;
		bitCount += 6;
		if (bitCount >= 8) {
			bitCount -= 8;
			output.push((bits >> bitCount) & 0xff);
		}
	}
	return Uint8Array.from(output);
};

export const deriveSafetyPhrase = (input: {
	readonly deviceId: string;
	readonly devicePublicKey: string;
	readonly ephemeralPublicKey: string;
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly environmentPublicKey: string;
	readonly transportCertificatePin?: string;
}): string => {
	const transcript = [
		"zuse-nearby-v1",
		input.deviceId,
		input.devicePublicKey,
		input.ephemeralPublicKey,
		input.clientNonce,
		input.serverNonce,
		input.environmentPublicKey,
		...(input.transportCertificatePin === undefined
			? []
			: [input.transportCertificatePin]),
	].join("|");
	const hash = digest(transcript);
	return [hash[0] ?? 0, hash[1] ?? 0, hash[2] ?? 0]
		.map((value) => SAFETY_WORDS[value % SAFETY_WORDS.length])
		.join("-");
};

export const serverKeyPin = (environmentPublicKey: string): string =>
	`sha256/${base64Url(digest(environmentPublicKey))}`;

export const readLocalServerIdentity = async (input: {
	readonly host: string;
	readonly port: number;
}): Promise<string> => {
	const challengeBytes = new Uint8Array(24);
	globalThis.crypto.getRandomValues(challengeBytes);
	const challenge = base64Url(challengeBytes);
	const response = await fetch(
		`http://${input.host}:${input.port}/pair/identity`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challenge }),
		},
	);
	if (!response.ok) throw new Error("Could not verify this Mac's identity.");
	const body = (await response.json()) as {
		publicKey?: unknown;
		signature?: unknown;
	};
	if (
		typeof body.publicKey !== "string" ||
		typeof body.signature !== "string"
	) {
		throw new Error("The Mac identity proof is invalid.");
	}
	const [encodedHeader, encodedPayload, encodedSignature, extra] =
		body.signature.split(".");
	if (
		encodedHeader === undefined ||
		encodedPayload === undefined ||
		encodedSignature === undefined ||
		extra !== undefined
	) {
		throw new Error("The Mac identity proof is invalid.");
	}
	const header = JSON.parse(
		new TextDecoder().decode(fromBase64Url(encodedHeader)),
	) as { alg?: unknown; typ?: unknown };
	const payload = new TextDecoder().decode(fromBase64Url(encodedPayload));
	const jwk = JSON.parse(body.publicKey) as {
		kty?: unknown;
		crv?: unknown;
		x?: unknown;
	};
	const valid =
		header.alg === "EdDSA" &&
		header.typ === "zuse-local-identity+jws" &&
		payload === `zuse-local-identity-v1|${challenge}` &&
		jwk.kty === "OKP" &&
		jwk.crv === "Ed25519" &&
		typeof jwk.x === "string" &&
		ed25519.verify(
			fromBase64Url(encodedSignature),
			new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
			fromBase64Url(jwk.x),
		);
	if (!valid) throw new Error("The nearby computer is not the paired Mac.");
	return body.publicKey;
};

export const verifyPinnedLocalServer = async (input: {
	readonly host: string;
	readonly port: number;
	readonly publicKey: string;
	readonly pin: string;
}): Promise<void> => {
	if (serverKeyPin(input.publicKey) !== input.pin) {
		throw new Error("The saved Mac identity is damaged.");
	}
	const actual = await readLocalServerIdentity(input);
	if (actual !== input.publicKey) {
		throw new Error("The nearby computer is not the paired Mac.");
	}
};

export type NearbyPairingStart = {
	readonly request: NearbyPairingRequest;
	readonly environmentPublicKey: string;
	readonly safetyPhrase: string;
};

export const nearbyPairingChallenge = async (input: {
	readonly host: string;
	readonly port: number;
}): Promise<{
	readonly serverNonce: string;
	readonly environmentPublicKey: string;
	readonly environmentId: string;
	readonly transportCertificatePin?: string;
}> => {
	const response = await fetch(
		`http://${input.host}:${input.port}/pair/challenge`,
		{ method: "POST" },
	);
	if (!response.ok) throw new Error("The Mac could not start secure pairing.");
	return (await response.json()) as {
		serverNonce: string;
		environmentPublicKey: string;
		environmentId: string;
		transportCertificatePin?: string;
	};
};

export const startNearbyPairing = async (input: {
	readonly host: string;
	readonly port: number;
	readonly deviceId: string;
	readonly deviceLabel: string;
	readonly deviceModel?: string;
	readonly devicePublicKey: string;
	readonly ephemeralPublicKey: string;
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly icloudTrustRecordId?: string;
	readonly icloudTrustProof?: string;
	readonly accountAssertion?: string;
	readonly transportCertificatePin: string;
}): Promise<NearbyPairingStart> => {
	const response = await fetch(
		`http://${input.host}:${input.port}/pair/request`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				deviceId: input.deviceId,
				deviceLabel: input.deviceLabel,
				deviceModel: input.deviceModel,
				devicePublicKey: input.devicePublicKey,
				ephemeralPublicKey: input.ephemeralPublicKey,
				clientNonce: input.clientNonce,
				serverNonce: input.serverNonce,
				icloudTrustRecordId: input.icloudTrustRecordId,
				icloudTrustProof: input.icloudTrustProof,
				accountAssertion: input.accountAssertion,
			}),
		},
	);
	if (!response.ok) {
		if (response.status === 409) {
			throw new Error("Another phone request is already waiting on the Mac.");
		}
		if (response.status === 403) {
			throw new Error("This phone is blocked on the Mac.");
		}
		throw new Error("The Mac could not start nearby pairing.");
	}
	const body = (await response.json()) as {
		request: NearbyPairingRequest;
		environmentPublicKey: string;
	};
	return {
		...body,
		safetyPhrase: deriveSafetyPhrase({
			deviceId: input.deviceId,
			devicePublicKey: input.devicePublicKey,
			ephemeralPublicKey: input.ephemeralPublicKey,
			clientNonce: input.clientNonce,
			serverNonce: body.request.serverNonce,
			environmentPublicKey: body.environmentPublicKey,
			transportCertificatePin: input.transportCertificatePin,
		}),
	};
};

export type NearbyApprovalStatus =
	| { readonly state: "pending" | "denied" | "expired" }
	| {
			readonly state: "approved";
			readonly credential: EncryptedPairingCredential;
	  };

export const nearbyPairingStatus = async (input: {
	readonly host: string;
	readonly port: number;
	readonly requestId: string;
}): Promise<NearbyApprovalStatus> => {
	const response = await fetch(
		`http://${input.host}:${input.port}/pair/status`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: input.requestId }),
		},
	);
	if (!response.ok) throw new Error("Could not read the Mac approval.");
	return (await response.json()) as NearbyApprovalStatus;
};
