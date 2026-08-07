import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ProviderId } from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";

import { CredentialsError } from "../errors.ts";
import {
	CredentialsService,
	ProviderCredential,
} from "../services/credentials-service.ts";

const CredentialValues = Schema.Record(Schema.String, Schema.String);
const ProviderCredentials = Schema.Record(Schema.String, ProviderCredential);
const CredentialFileV2 = Schema.Struct({
	version: Schema.Literal(2),
	values: CredentialValues,
	providers: ProviderCredentials,
});
type CredentialFileV2 = typeof CredentialFileV2.Type;
const LegacyCredentialFile = Schema.Record(Schema.String, Schema.String);

const browserKey = (origin: string): string =>
	`browserCred:${new URL(origin).origin}`;
const integrationPrefix = (integration: string): string =>
	`integration:${integration}:`;
const integrationKey = (integration: string, accountId: string): string =>
	`${integrationPrefix(integration)}${accountId}`;
const mcpKey = (serverKey: string): string => `mcpOAuth:${serverKey}`;
const WORKOS_KEY = "workos:session";

const knownProviders: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"cursor",
];

const asError = (cause: unknown, providerId = "") =>
	new CredentialsError({
		providerId,
		reason: cause instanceof Error ? cause.message : String(cause),
		cause,
	});

const emptyCredentialFile = (): CredentialFileV2 => ({
	version: 2,
	values: {},
	providers: {},
});

const normalizeCredentialFile = (parsed: unknown): CredentialFileV2 => {
	const current = Schema.decodeUnknownOption(CredentialFileV2)(parsed);
	if (current._tag === "Some") return current.value;
	const legacy = Schema.decodeUnknownSync(LegacyCredentialFile)(parsed);
	const values: Record<string, string> = {};
	const providers: Record<string, ProviderCredential> = {};
	for (const [key, value] of Object.entries(legacy)) {
		if (key.startsWith("apiKey:")) {
			const candidate = key.slice("apiKey:".length);
			const provider = Schema.decodeUnknownOption(ProviderId)(candidate);
			if (provider._tag === "Some") {
				providers[provider.value] = ProviderCredential.make({
					kind: "api-key",
					secret: value,
					updatedAt: 0,
				});
				continue;
			}
		}
		values[key] = value;
	}
	return { version: 2, values, providers };
};

/**
 * File-backed secret storage for unprivileged Linux hosts. The containing
 * directory is mode 0700 and every atomically replaced file is mode 0600.
 */
export const makeFileCredentialsService = (
	userData: string,
): Layer.Layer<CredentialsService> =>
	Layer.sync(CredentialsService, () => {
		const filePath = join(userData, "secrets", "credentials.json");
		let tail: Promise<void> = Promise.resolve();

		const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
			const result = tail.then(operation, operation);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};

		const read = async (): Promise<CredentialFileV2> => {
			try {
				const raw = await readFile(filePath, "utf8");
				return normalizeCredentialFile(JSON.parse(raw) as unknown);
			} catch (cause) {
				if (
					cause instanceof Error &&
					"code" in cause &&
					cause.code === "ENOENT"
				) {
					return emptyCredentialFile();
				}
				throw cause;
			}
		};

		const write = async (contents: CredentialFileV2): Promise<void> => {
			const directory = dirname(filePath);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			const temporary = `${filePath}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(contents)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await chmod(temporary, 0o600);
			await rename(temporary, filePath);
			await chmod(filePath, 0o600);
		};

		const operation = <A>(
			run: () => Promise<A>,
			providerId = "",
		): Effect.Effect<A, CredentialsError> =>
			Effect.tryPromise({
				try: () => exclusive(run),
				catch: (cause) => asError(cause, providerId),
			});

		const get = (key: string, providerId = "") =>
			operation(async () => (await read()).values[key] ?? null, providerId);
		const set = (key: string, value: string, providerId = "") =>
			operation(async () => {
				const contents = await read();
				await write({
					...contents,
					values: { ...contents.values, [key]: value },
				});
			}, providerId);
		const remove = (key: string, providerId = "") =>
			operation(async () => {
				const contents = await read();
				const values = { ...contents.values };
				delete values[key];
				await write({ ...contents, values });
			}, providerId);

		return CredentialsService.of({
			getProviderCredential: (providerId) =>
				operation(
					async () => (await read()).providers[providerId] ?? null,
					providerId,
				),
			setProviderCredential: (providerId, credential) =>
				operation(async () => {
					const contents = await read();
					await write({
						...contents,
						providers: {
							...contents.providers,
							[providerId]: ProviderCredential.make({
								...credential,
								updatedAt: Date.now(),
							}),
						},
					});
				}, providerId),
			get: (providerId) =>
				operation(
					async () => (await read()).providers[providerId]?.secret ?? null,
					providerId,
				),
			set: (providerId, apiKey) =>
				operation(async () => {
					const contents = await read();
					await write({
						...contents,
						providers: {
							...contents.providers,
							[providerId]: ProviderCredential.make({
								kind: "api-key",
								secret: apiKey,
								updatedAt: Date.now(),
							}),
						},
					});
				}, providerId),
			remove: (providerId) =>
				operation(async () => {
					const contents = await read();
					const providers = { ...contents.providers };
					delete providers[providerId];
					await write({ ...contents, providers });
				}, providerId),
			listConfigured: () =>
				operation(async () => {
					const contents = await read();
					return knownProviders.filter(
						(providerId) => contents.providers[providerId] !== undefined,
					);
				}),
			setBrowser: (origin, username, password) =>
				set(browserKey(origin), JSON.stringify({ username, password })),
			getBrowser: (origin) =>
				get(browserKey(origin)).pipe(
					Effect.map((raw) => {
						if (raw === null) return null;
						const parsed = JSON.parse(raw) as {
							readonly username: string;
							readonly password: string;
						};
						return parsed;
					}),
					Effect.mapError((error) => error),
				),
			removeBrowser: (origin) => remove(browserKey(origin)),
			listBrowser: () =>
				operation(async () => {
					const contents = await read();
					return Object.entries(contents.values).flatMap(([key, value]) => {
						if (!key.startsWith("browserCred:")) return [];
						const parsed = JSON.parse(value) as { readonly username: string };
						return [
							{
								origin: key.slice("browserCred:".length),
								username: parsed.username,
							},
						];
					});
				}),
			getWorkosSession: () => get(WORKOS_KEY),
			setWorkosSession: (bundleJson) => set(WORKOS_KEY, bundleJson),
			removeWorkosSession: () => remove(WORKOS_KEY),
			getIntegration: (integration, accountId) =>
				get(integrationKey(integration, accountId)),
			setIntegration: (integration, accountId, value) =>
				set(integrationKey(integration, accountId), value),
			removeIntegration: (integration, accountId) =>
				remove(integrationKey(integration, accountId)),
			listIntegrationAccounts: (integration) =>
				operation(async () => {
					const prefix = integrationPrefix(integration);
					return Object.keys((await read()).values)
						.filter((key) => key.startsWith(prefix))
						.map((key) => key.slice(prefix.length));
				}),
			getMcpOauth: (serverKey) => get(mcpKey(serverKey)),
			setMcpOauth: (serverKey, bundleJson) =>
				set(mcpKey(serverKey), bundleJson),
			removeMcpOauth: (serverKey) => remove(mcpKey(serverKey)),
		});
	});
