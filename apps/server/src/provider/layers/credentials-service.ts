import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";
import { AppPaths } from "../../app-paths.ts";
import { atomicWritePrivateJson } from "../../atomic-private-file.ts";
import { withProcessLock } from "../../process/process-lock.ts";
import {
	openStorage,
	type SecureStorageEnvelope,
	sealStorage,
} from "../../secure-storage-envelope.ts";
import { secureStorageMasterKey } from "../../secure-storage-master-key.ts";
import { CredentialsError } from "../errors.ts";
import {
	CredentialsService,
	ProviderCredential,
} from "../services/credentials-service.ts";

const VAULT_FILENAME = "secure-vault.json";
const VAULT_AAD = Buffer.from("zuse-secure-vault:v1", "utf8");

interface BrowserCredential {
	readonly username: string;
	readonly password: string;
}

interface VaultContents {
	readonly version: 2;
	readonly providers: Partial<Record<ProviderId, ProviderCredential>>;
	readonly browserCredentials: Record<string, BrowserCredential>;
	readonly integrations: Record<string, Record<string, string>>;
	readonly mcpOauth: Record<string, string>;
}

const emptyVault = (): VaultContents => ({
	version: 2,
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

const ProviderCredentialRecord = Schema.Record(
	Schema.String,
	ProviderCredential,
);

const parseVaultContents = (value: unknown): VaultContents => {
	if (value === null || typeof value !== "object")
		throw new Error("Secure storage is corrupt.");
	const raw = value as {
		readonly version?: unknown;
		readonly providers?: unknown;
		readonly browserCredentials?: unknown;
		readonly integrations?: unknown;
		readonly mcpOauth?: unknown;
	};
	const currentProviders = Schema.decodeUnknownOption(ProviderCredentialRecord)(
		raw.providers,
	);
	const legacyProviders = isStringRecord(raw.providers)
		? Object.fromEntries(
				Object.entries(raw.providers).map(([providerId, secret]) => [
					providerId,
					ProviderCredential.make({
						kind: "api-key",
						secret,
						updatedAt: 0,
					}),
				]),
			)
		: null;
	if (
		(raw.version !== 1 && raw.version !== 2) ||
		(currentProviders._tag === "None" && legacyProviders === null) ||
		!isBrowserCredentialRecord(raw.browserCredentials) ||
		!isIntegrationRecord(raw.integrations) ||
		!isStringRecord(raw.mcpOauth)
	) {
		throw new Error("Secure storage uses an unsupported format.");
	}
	return {
		version: 2,
		providers:
			currentProviders._tag === "Some"
				? { ...currentProviders.value }
				: { ...legacyProviders },
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

const encryptVault = (
	contents: VaultContents,
	key: Buffer,
): SecureStorageEnvelope =>
	sealStorage(JSON.stringify(contents), key, VAULT_AAD);
const decryptVault = (envelope: unknown, key: Buffer): VaultContents =>
	parseVaultContents(JSON.parse(openStorage(envelope, key, VAULT_AAD)));

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
		JSON.parse(raw),
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
		let writeTail = Promise.resolve();
		let cached: { stamp: string; contents: VaultContents } | undefined;

		const load = async (): Promise<VaultContents> => {
			let raw: string;
			try {
				const metadata = await stat(vaultPath, { bigint: true });
				const stamp = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
				if (cached?.stamp === stamp) return cached.contents;
				raw = await readFile(vaultPath, "utf8");
				const contents = decryptVault(
					JSON.parse(raw),
					await secureStorageMasterKey(false),
				);
				// Cache under the pre-read identity. An atomic replacement during the
				// read will miss next time, never pin an old vault to a new identity.
				cached = { stamp, contents };
				return contents;
			} catch (cause) {
				if (
					typeof cause === "object" &&
					cause !== null &&
					(cause as { code?: unknown }).code === "ENOENT"
				) {
					cached = undefined;
					return emptyVault();
				}
				throw cause;
			}
		};

		const persist = async (contents: VaultContents): Promise<void> => {
			cached = undefined;
			const key = await secureStorageMasterKey();
			await atomicWritePrivateJson(vaultPath, encryptVault(contents, key));
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
						await withProcessLock(`${vaultPath}.lock.sqlite`, async () => {
							await persist(update(await load()));
						});
					});
					writeTail = operation.catch(() => {});
					await operation;
				},
				catch: toCredentialsError,
			});

		return CredentialsService.of({
			encryptedAtRest: true,
			getProviderCredential: (providerId) =>
				read((contents) => contents.providers[providerId] ?? null),
			setProviderCredential: (providerId, credential) =>
				mutate((contents) => ({
					...contents,
					providers: {
						...contents.providers,
						[providerId]: ProviderCredential.make({
							...credential,
							updatedAt: Date.now(),
						}),
					},
				})),
			get: (providerId) =>
				read((contents) => contents.providers[providerId]?.secret ?? null),
			set: (providerId, apiKey) =>
				mutate((contents) => ({
					...contents,
					providers: {
						...contents.providers,
						[providerId]: ProviderCredential.make({
							kind: "api-key",
							secret: apiKey,
							updatedAt: Date.now(),
						}),
					},
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
								contents.providers[providerId as ProviderId] !== undefined,
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
