import {
	createCipheriv,
	createDecipheriv,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
} from "node:crypto";

import type {
	AccountAccessPreparedImport,
	AccountAccessSealedCredential,
	EnvironmentId,
} from "@zuse/contracts";
import { Schema } from "effect";
import { importJWK, jwtVerify, SignJWT } from "jose";

const TRANSFER_INFO = "zuse-account-access-v1";
const TRANSFER_PROOF_TYPE = "zuse-account-access-import+jwt";
const MAX_TRANSFER_BYTES = 16_384;
const MAX_CIPHERTEXT_CHARS = 24_000;

const CredentialTransferPayload = Schema.Struct({
	providerId: Schema.Literal("claude"),
	kind: Schema.Literal("oauth-token"),
	secret: Schema.String,
});
export type CredentialTransferPayload = typeof CredentialTransferPayload.Type;

export interface CredentialTransferBinding {
	readonly accountId: string;
	readonly environmentId: EnvironmentId;
	readonly transferId: string;
	readonly expiresAt: number;
}

export interface PreparedCredentialTransfer extends CredentialTransferBinding {
	readonly recipientPublicKey: string;
	readonly recipientPrivateKey: string;
}

const transferAad = (binding: CredentialTransferBinding): Buffer =>
	Buffer.from(
		[
			TRANSFER_INFO,
			binding.accountId,
			binding.environmentId,
			binding.transferId,
			String(binding.expiresAt),
		].join("\n"),
		"utf8",
	);

const deriveKey = (shared: Buffer): Buffer =>
	Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), TRANSFER_INFO, 32));

export const prepareCredentialTransfer = (
	binding: CredentialTransferBinding,
): PreparedCredentialTransfer => {
	const pair = generateKeyPairSync("x25519");
	const publicJwk = pair.publicKey.export({ format: "jwk" });
	if (publicJwk.x === undefined) throw new Error("transfer_key_failed");
	return {
		...binding,
		recipientPublicKey: publicJwk.x,
		recipientPrivateKey: JSON.stringify(
			pair.privateKey.export({ format: "jwk" }),
		),
	};
};

export const publicPreparedImport = (
	prepared: PreparedCredentialTransfer,
	environmentProof: string,
): AccountAccessPreparedImport => ({
	transferId: prepared.transferId,
	accountId: prepared.accountId,
	environmentId: prepared.environmentId,
	recipientPublicKey: prepared.recipientPublicKey,
	expiresAt: prepared.expiresAt,
	environmentProof,
});

export const signPreparedImport = async (
	prepared: PreparedCredentialTransfer,
	privateJwk: string,
	relayIssuer: string,
): Promise<string> => {
	const key = await importJWK(
		JSON.parse(privateJwk) as Record<string, unknown>,
		"EdDSA",
	);
	return new SignJWT({
		accountId: prepared.accountId,
		environmentId: prepared.environmentId,
		transferId: prepared.transferId,
		recipientPublicKey: prepared.recipientPublicKey,
	})
		.setProtectedHeader({ alg: "EdDSA", typ: TRANSFER_PROOF_TYPE })
		.setAudience(relayIssuer)
		.setIssuedAt()
		.setExpirationTime(Math.floor(prepared.expiresAt / 1_000))
		.sign(key);
};

export const verifyPreparedImport = async (
	prepared: AccountAccessPreparedImport,
	publicJwk: string,
	relayIssuer: string,
): Promise<void> => {
	const key = await importJWK(
		JSON.parse(publicJwk) as Record<string, unknown>,
		"EdDSA",
	);
	const { payload, protectedHeader } = await jwtVerify(
		prepared.environmentProof,
		key,
		{
			algorithms: ["EdDSA"],
			audience: relayIssuer,
			typ: TRANSFER_PROOF_TYPE,
		},
	);
	if (
		protectedHeader.typ !== TRANSFER_PROOF_TYPE ||
		payload.accountId !== prepared.accountId ||
		payload.environmentId !== prepared.environmentId ||
		payload.transferId !== prepared.transferId ||
		payload.recipientPublicKey !== prepared.recipientPublicKey ||
		payload.exp !== Math.floor(prepared.expiresAt / 1_000)
	) {
		throw new Error("transfer_rejected");
	}
};

export const sealCredentialTransfer = (
	prepared:
		| AccountAccessPreparedImport
		| (CredentialTransferBinding & {
				readonly recipientPublicKey: string;
		  }),
	payload: CredentialTransferPayload,
): AccountAccessSealedCredential => {
	const plaintext = Buffer.from(
		JSON.stringify(Schema.encodeSync(CredentialTransferPayload)(payload)),
		"utf8",
	);
	if (plaintext.byteLength > MAX_TRANSFER_BYTES) {
		throw new Error("transfer_too_large");
	}
	try {
		const recipient = createPublicKey({
			key: {
				kty: "OKP",
				crv: "X25519",
				x: prepared.recipientPublicKey,
			},
			format: "jwk",
		});
		const ephemeral = generateKeyPairSync("x25519");
		const shared = diffieHellman({
			privateKey: ephemeral.privateKey,
			publicKey: recipient,
		});
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", deriveKey(shared), nonce);
		cipher.setAAD(transferAad(prepared));
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" });
		if (ephemeralJwk.x === undefined) throw new Error("missing_ephemeral_key");
		return {
			ephemeralPublicKey: ephemeralJwk.x,
			nonce: nonce.toString("base64url"),
			ciphertext: ciphertext.toString("base64url"),
		};
	} catch (cause) {
		if (cause instanceof Error && cause.message === "transfer_too_large") {
			throw cause;
		}
		throw new Error("transfer_rejected", { cause });
	}
};

export const openCredentialTransfer = (
	prepared: PreparedCredentialTransfer,
	sealed: AccountAccessSealedCredential,
	nowMs: number,
): CredentialTransferPayload => {
	if (nowMs > prepared.expiresAt) throw new Error("transfer_expired");
	if (sealed.ciphertext.length > MAX_CIPHERTEXT_CHARS) {
		throw new Error("transfer_rejected");
	}
	try {
		const privateKey = createPrivateKey({
			key: JSON.parse(prepared.recipientPrivateKey),
			format: "jwk",
		});
		const sender = createPublicKey({
			key: {
				kty: "OKP",
				crv: "X25519",
				x: sealed.ephemeralPublicKey,
			},
			format: "jwk",
		});
		const shared = diffieHellman({ privateKey, publicKey: sender });
		const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
		if (ciphertext.byteLength <= 16) throw new Error("ciphertext_too_short");
		const body = ciphertext.subarray(0, -16);
		const tag = ciphertext.subarray(-16);
		const decipher = createDecipheriv(
			"aes-256-gcm",
			deriveKey(shared),
			Buffer.from(sealed.nonce, "base64url"),
		);
		decipher.setAAD(transferAad(prepared));
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
		if (plaintext.byteLength > MAX_TRANSFER_BYTES) {
			throw new Error("plaintext_too_large");
		}
		return Schema.decodeUnknownSync(CredentialTransferPayload)(
			JSON.parse(plaintext.toString("utf8")) as unknown,
		);
	} catch (cause) {
		throw new Error("transfer_rejected", { cause });
	}
};
