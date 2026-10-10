import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { type CryptoKey, exportJWK, generateKeyPair, importJWK } from "jose";

export const CLOUD_RUNTIME_IDENTITY_FILE = "cloud-runtime-identity.json";

const BootstrapBinding = Schema.Struct({
	zuseAccountId: Schema.String,
	workspaceId: Schema.String,
	runtimeGeneration: Schema.Number,
});

const StoredIdentity = Schema.Struct({
	version: Schema.Literal(1),
	workspaceId: Schema.String,
	apiUrl: Schema.String,
	storageIncarnationId: Schema.String,
	accountId: Schema.NullOr(Schema.String),
	bootTokenHash: Schema.String,
	generation: Schema.NullOr(Schema.Number),
	credentialPrivateJwk: Schema.String,
	signingPrivateJwk: Schema.String,
	credentialPublicJwk: Schema.String,
	signingPublicJwk: Schema.String,
	bootstrap: Schema.Unknown,
	bootstrapAcknowledged: Schema.Boolean,
	pendingRenewalId: Schema.NullOr(Schema.String),
});
type StoredIdentity = typeof StoredIdentity.Type;

/** The launcher owns the lifetime data lock; this file never creates/moves a database. */
export const openCloudRuntimeIdentity = async (input: {
	readonly directory: string;
	readonly workspaceId: string;
	readonly apiUrl: string;
	readonly storageIncarnationId: string;
	readonly bootToken?: string;
	readonly expectedGeneration?: number;
}) => {
	if (
		input.expectedGeneration !== undefined &&
		(!Number.isSafeInteger(input.expectedGeneration) ||
			input.expectedGeneration < 1)
	)
		throw new Error("workspace_runtime_identity_generation_invalid");
	const path = join(input.directory, CLOUD_RUNTIME_IDENTITY_FILE);
	let stored: StoredIdentity | undefined;
	try {
		stored = Schema.decodeUnknownSync(StoredIdentity)(
			JSON.parse(await readFile(path, "utf8")),
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw new Error("workspace_runtime_identity_unreadable");
	}
	if (
		stored &&
		(stored.workspaceId !== input.workspaceId ||
			stored.apiUrl !== input.apiUrl ||
			stored.storageIncarnationId !== input.storageIncarnationId)
	)
		throw new Error("workspace_runtime_identity_binding_mismatch");
	const hash = input.bootToken
		? createHash("sha256").update(input.bootToken).digest("hex")
		: undefined;
	const newAuthorization = hash !== undefined && hash !== stored?.bootTokenHash;
	if (
		!newAuthorization &&
		stored?.generation !== null &&
		stored?.generation !== undefined &&
		input.expectedGeneration !== undefined &&
		stored.generation !== input.expectedGeneration
	)
		throw new Error("workspace_runtime_identity_generation_mismatch");
	if (!stored && !input.bootToken)
		throw new Error("workspace_runtime_identity_missing");
	if (!stored) {
		const [credential, signing] = await Promise.all([
			generateKeyPair("RSA-OAEP-256", { extractable: true }),
			generateKeyPair("EdDSA", { extractable: true }),
		]);
		stored = {
			version: 1,
			workspaceId: input.workspaceId,
			apiUrl: input.apiUrl,
			storageIncarnationId: input.storageIncarnationId,
			accountId: null,
			bootTokenHash: hash ?? "",
			generation: null,
			bootstrap: null,
			bootstrapAcknowledged: false,
			pendingRenewalId: null,
			credentialPrivateJwk: JSON.stringify(
				await exportJWK(credential.privateKey),
			),
			signingPrivateJwk: JSON.stringify(await exportJWK(signing.privateKey)),
			credentialPublicJwk: JSON.stringify(
				await exportJWK(credential.publicKey),
			),
			signingPublicJwk: JSON.stringify(await exportJWK(signing.publicKey)),
		};
	} else if (newAuthorization) {
		// New API-authorized launch supersedes the old bearer, never the durable keys/data.
		stored = {
			...stored,
			bootTokenHash: hash,
			generation: null,
			bootstrap: null,
			bootstrapAcknowledged: false,
			pendingRenewalId: null,
		};
	}
	if (stored.bootstrap !== null) {
		const binding = Schema.decodeUnknownSync(BootstrapBinding)(
			stored.bootstrap,
		);
		if (
			binding.workspaceId !== stored.workspaceId ||
			binding.zuseAccountId !== stored.accountId ||
			binding.runtimeGeneration !== stored.generation
		)
			throw new Error("workspace_runtime_identity_binding_mismatch");
	}
	let current = stored;
	let writes = Promise.resolve();
	const save = (update: (identity: StoredIdentity) => StoredIdentity) => {
		const write = writes.then(async () => {
			const next = update(current);
			const temporary = `${path}.${randomUUID()}.next`;
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(`${JSON.stringify(next)}\n`);
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, path);
				const directory = await open(input.directory, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
				current = next;
			} finally {
				await unlink(temporary).catch(() => {});
			}
		});
		writes = write.catch(() => {});
		return write;
	};
	const [credentialPrivateKey, signingPrivateKey] = await Promise.all([
		importJWK(JSON.parse(current.credentialPrivateJwk), "RSA-OAEP-256"),
		importJWK(JSON.parse(current.signingPrivateJwk), "EdDSA"),
	]);
	if (
		credentialPrivateKey instanceof Uint8Array ||
		signingPrivateKey instanceof Uint8Array
	)
		throw new Error("workspace_runtime_identity_invalid_key");
	// Key material is durable BEFORE the first enrollment request (including response loss).
	await save((value) => value);
	return {
		credentialPrivateKey: credentialPrivateKey as CryptoKey,
		signingPrivateKey: signingPrivateKey as CryptoKey,
		credentialPublicJwk: current.credentialPublicJwk,
		signingPublicJwk: current.signingPublicJwk,
		bootstrap: current.bootstrap,
		get bootstrapAcknowledged() {
			return current.bootstrapAcknowledged;
		},
		acknowledgeBootstrap: () =>
			save((value) => ({ ...value, bootstrapAcknowledged: true })),
		get pendingRenewalId() {
			return current.pendingRenewalId;
		},
		commitBootstrap: async (bootstrap: {
			readonly zuseAccountId?: string;
			readonly workspaceId: string;
			readonly runtimeGeneration: number;
		}) => {
			if (
				bootstrap.workspaceId !== input.workspaceId ||
				!bootstrap.zuseAccountId ||
				(current.accountId !== null &&
					current.accountId !== bootstrap.zuseAccountId) ||
				(input.expectedGeneration !== undefined &&
					bootstrap.runtimeGeneration !== input.expectedGeneration)
			)
				throw new Error("workspace_runtime_identity_binding_mismatch");
			const accountId = bootstrap.zuseAccountId;
			await save((value) => ({
				...value,
				accountId,
				generation: bootstrap.runtimeGeneration,
				bootstrap,
				pendingRenewalId: null,
			}));
		},
		beginRenewal: async (requestId: string) => {
			if (current.pendingRenewalId !== null) return current.pendingRenewalId;
			let selected = requestId;
			await save((value) => {
				selected = value.pendingRenewalId ?? requestId;
				return { ...value, pendingRenewalId: selected };
			});
			return selected;
		},
		commitRenewal: async (bootstrap: unknown) => {
			const binding = Schema.decodeUnknownSync(BootstrapBinding)(bootstrap);
			if (
				binding.workspaceId !== current.workspaceId ||
				binding.zuseAccountId !== current.accountId ||
				binding.runtimeGeneration !== current.generation
			)
				throw new Error("workspace_runtime_identity_binding_mismatch");
			await save((value) => ({ ...value, bootstrap, pendingRenewalId: null }));
		},
	};
};
export type CloudRuntimeIdentity = Awaited<
	ReturnType<typeof openCloudRuntimeIdentity>
>;
