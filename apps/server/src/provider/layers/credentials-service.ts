import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { ProviderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { AppPaths } from "../../app-paths.ts";
import { secureStorageMasterKey } from "../../secure-storage-master-key.ts";
import { CredentialsError } from "../errors.ts";
import { CredentialsService } from "../services/credentials-service.ts";

const VAULT_FILENAME = "secure-vault.json";
const VAULT_AAD = Buffer.from("zuse-secure-vault:v1", "utf8");

interface BrowserCredential {
	readonly username: string;
	readonly password: string;
}

interface VaultContents {
	readonly version: 1;
	readonly providers: Partial<Record<ProviderId, string>>;
	readonly browserCredentials: Record<string, BrowserCredential>;
	readonly integrations: Record<string, Record<string, string>>;
	readonly mcpOauth: Record<string, string>;
}

interface VaultEnvelope {
	readonly version: 1;
	readonly iv: string;
	readonly ciphertext: string;
	readonly tag: string;
}

const emptyVault = (): VaultContents => ({
	version: 1,
	providers: {},
	browserCredentials: {},
	integrations: {},
	mcpOauth: {},
});

const normalizeOrigin = (input: string): string => {
	try {
		return new URL(input).origin;
	} catch {
		return input.trim().replace(/\/.*$/u, "").toLowerCase();
	}
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
	value !== null &&
	typeof value === "object" &&
	Object.values(value).every((item) => typeof item === "string");

const isBrowserCredentialRecord = (
	value: unknown,
): value is Record<string, BrowserCredential> =>
	value !== null &&
	typeof value === "object" &&
	Object.values(value).every(
		(item) =>
			item !== null &&
			typeof item === "object" &&
			typeof (item as Partial<BrowserCredential>).username === "string" &&
			typeof (item as Partial<BrowserCredential>).password === "string",
	);

const isIntegrationRecord = (
	value: unknown,
): value is Record<string, Record<string, string>> =>
	value !== null &&
	typeof value === "object" &&
	Object.values(value).every(isStringRecord);

const parseVaultContents = (value: unknown): VaultContents => {
	if (value === null || typeof value !== "object")
		throw new Error("Secure storage is corrupt.");
	const raw = value as Partial<VaultContents>;
	if (
		raw.version !== 1 ||
		!isStringRecord(raw.providers) ||
		!isBrowserCredentialRecord(raw.browserCredentials) ||
		!isIntegrationRecord(raw.integrations) ||
		!isStringRecord(raw.mcpOauth)
	) {
		throw new Error("Secure storage uses an unsupported format.");
	}
	return {
		version: 1,
		providers: { ...raw.providers },
		browserCredentials: { ...raw.browserCredentials },
		integrations: Object.fromEntries(
			Object.entries(raw.integrations).map(([name, accounts]) => [
				name,
				{ ...accounts },
			]),
		),
		mcpOauth: { ...raw.mcpOauth },
	};
};

const decodeEnvelope = (raw: string): VaultEnvelope => {
	const value = JSON.parse(raw) as Partial<VaultEnvelope>;
	if (
		value.version !== 1 ||
		typeof value.iv !== "string" ||
		typeof value.ciphertext !== "string" ||
		typeof value.tag !== "string"
	) {
		throw new Error("Secure storage is corrupt.");
	}
	return value as VaultEnvelope;
};

const encryptVault = (contents: VaultContents, key: Buffer): VaultEnvelope => {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(VAULT_AAD);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(contents), "utf8"),
		cipher.final(),
	]);
	return {
		version: 1,
		iv: iv.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
	};
};

const decryptVault = (envelope: VaultEnvelope, key: Buffer): VaultContents => {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "base64url"),
	);
	decipher.setAAD(VAULT_AAD);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf8");
	return parseVaultContents(JSON.parse(plaintext) as unknown);
};

export const readBrowserCredentialFromVault = async (
	userData: string,
	origin: string,
): Promise<BrowserCredential | null> => {
	let raw: string;
	try {
		raw = await readFile(join(userData, VAULT_FILENAME), "utf8");
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			(cause as { code?: unknown }).code === "ENOENT"
		)
			return null;
		throw cause;
	}
	const contents = decryptVault(
		decodeEnvelope(raw),
		await secureStorageMasterKey(false),
	);
	return contents.browserCredentials[normalizeOrigin(origin)] ?? null;
};

const toCredentialsError = (cause: unknown): CredentialsError =>
	new CredentialsError({
		providerId: "",
		reason: cause instanceof Error ? cause.message : String(cause),
		cause,
	});

export const CredentialsServiceLive = Layer.effect(
	CredentialsService,
	Effect.gen(function* () {
		const { userData } = yield* AppPaths;
		const vaultPath = join(userData, VAULT_FILENAME);
		let cachedVault: VaultContents | null = null;
		let writeTail = Promise.resolve();

		const load = async (): Promise<VaultContents> => {
			if (cachedVault !== null) return cachedVault;
			let raw: string;
			try {
				raw = await readFile(vaultPath, "utf8");
			} catch (cause) {
				if (
					typeof cause === "object" &&
					cause !== null &&
					(cause as { code?: unknown }).code === "ENOENT"
				) {
					cachedVault = emptyVault();
					return cachedVault;
				}
				throw cause;
			}
			const key = await secureStorageMasterKey(false);
			cachedVault = decryptVault(decodeEnvelope(raw), key);
			return cachedVault;
		};

		const persist = async (contents: VaultContents): Promise<void> => {
			const key = await secureStorageMasterKey();
			await mkdir(userData, { recursive: true, mode: 0o700 });
			const tmp = `${vaultPath}.tmp.${process.pid}.${Date.now()}`;
			try {
				await writeFile(tmp, JSON.stringify(encryptVault(contents, key)), {
					mode: 0o600,
				});
				await chmod(tmp, 0o600);
				await rename(tmp, vaultPath);
				await chmod(vaultPath, 0o600);
				cachedVault = contents;
			} finally {
				await rm(tmp, { force: true }).catch(() => {});
			}
		};

		const read = <A>(
			select: (contents: VaultContents) => A,
		): Effect.Effect<A, CredentialsError> =>
			Effect.tryPromise({
				try: async () => select(await load()),
				catch: toCredentialsError,
			});

		const mutate = (
			update: (contents: VaultContents) => VaultContents,
		): Effect.Effect<void, CredentialsError> =>
			Effect.tryPromise({
				try: async () => {
					const operation = writeTail.then(async () => {
						const current = await load();
						await persist(update(current));
					});
					writeTail = operation.catch(() => {});
					await operation;
				},
				catch: toCredentialsError,
			});

		return CredentialsService.of({
			get: (providerId) =>
				read((contents) => contents.providers[providerId] ?? null),
			set: (providerId, apiKey) =>
				mutate((contents) => ({
					...contents,
					providers: { ...contents.providers, [providerId]: apiKey },
				})),
			remove: (providerId) =>
				mutate((contents) => {
					const providers = { ...contents.providers };
					delete providers[providerId];
					return { ...contents, providers };
				}),
			listConfigured: () =>
				read(
					(contents) =>
						Object.keys(contents.providers).filter(
							(providerId): providerId is ProviderId =>
								typeof contents.providers[providerId as ProviderId] ===
								"string",
						) as ReadonlyArray<ProviderId>,
				),
			setBrowser: (origin, username, password) =>
				mutate((contents) => ({
					...contents,
					browserCredentials: {
						...contents.browserCredentials,
						[normalizeOrigin(origin)]: { username, password },
					},
				})),
			getBrowser: (origin) =>
				read(
					(contents) =>
						contents.browserCredentials[normalizeOrigin(origin)] ?? null,
				),
			removeBrowser: (origin) =>
				mutate((contents) => {
					const browserCredentials = { ...contents.browserCredentials };
					delete browserCredentials[normalizeOrigin(origin)];
					return { ...contents, browserCredentials };
				}),
			listBrowser: () =>
				read((contents) =>
					Object.entries(contents.browserCredentials)
						.map(([origin, credential]) => ({
							origin,
							username: credential.username,
						}))
						.sort((a, b) => a.origin.localeCompare(b.origin)),
				),
			// WorkOS sessions already use SessionStore. Deliberately do not touch
			// legacy Keychain entries during startup migration.
			getWorkosSession: () => Effect.succeed(null),
			setWorkosSession: () => Effect.void,
			removeWorkosSession: () => Effect.void,
			getIntegration: (integration, accountId) =>
				read(
					(contents) => contents.integrations[integration]?.[accountId] ?? null,
				),
			setIntegration: (integration, accountId, value) =>
				mutate((contents) => ({
					...contents,
					integrations: {
						...contents.integrations,
						[integration]: {
							...contents.integrations[integration],
							[accountId]: value,
						},
					},
				})),
			removeIntegration: (integration, accountId) =>
				mutate((contents) => {
					const accounts = { ...contents.integrations[integration] };
					delete accounts[accountId];
					const integrations = { ...contents.integrations };
					if (Object.keys(accounts).length === 0)
						delete integrations[integration];
					else integrations[integration] = accounts;
					return { ...contents, integrations };
				}),
			listIntegrationAccounts: (integration) =>
				read((contents) =>
					Object.keys(contents.integrations[integration] ?? {}).sort(),
				),
			getMcpOauth: (serverKey) =>
				read((contents) => contents.mcpOauth[serverKey] ?? null),
			setMcpOauth: (serverKey, bundleJson) =>
				mutate((contents) => ({
					...contents,
					mcpOauth: { ...contents.mcpOauth, [serverKey]: bundleJson },
				})),
			removeMcpOauth: (serverKey) =>
				mutate((contents) => {
					const mcpOauth = { ...contents.mcpOauth };
					delete mcpOauth[serverKey];
					return { ...contents, mcpOauth };
				}),
		});
	}),
);
