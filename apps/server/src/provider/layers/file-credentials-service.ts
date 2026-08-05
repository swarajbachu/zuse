import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { CredentialsError } from "../errors.ts";
import { CredentialsService } from "../services/credentials-service.ts";

type CredentialFile = Readonly<Record<string, string>>;

const providerKey = (providerId: ProviderId): string => `apiKey:${providerId}`;
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

		const read = async (): Promise<CredentialFile> => {
			try {
				const raw = await readFile(filePath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				if (
					parsed === null ||
					typeof parsed !== "object" ||
					Array.isArray(parsed)
				) {
					throw new Error("Credential file must contain a JSON object");
				}
				return parsed as CredentialFile;
			} catch (cause) {
				if (
					cause instanceof Error &&
					"code" in cause &&
					cause.code === "ENOENT"
				) {
					return {};
				}
				throw cause;
			}
		};

		const write = async (contents: CredentialFile): Promise<void> => {
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
			operation(async () => (await read())[key] ?? null, providerId);
		const set = (key: string, value: string, providerId = "") =>
			operation(async () => {
				const contents = await read();
				await write({ ...contents, [key]: value });
			}, providerId);
		const remove = (key: string, providerId = "") =>
			operation(async () => {
				const contents = { ...(await read()) };
				delete contents[key];
				await write(contents);
			}, providerId);

		return CredentialsService.of({
			get: (providerId) => get(providerKey(providerId), providerId),
			set: (providerId, apiKey) =>
				set(providerKey(providerId), apiKey, providerId),
			remove: (providerId) => remove(providerKey(providerId), providerId),
			listConfigured: () =>
				operation(async () => {
					const contents = await read();
					return knownProviders.filter(
						(providerId) => contents[providerKey(providerId)] !== undefined,
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
					return Object.entries(contents).flatMap(([key, value]) => {
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
					return Object.keys(await read())
						.filter((key) => key.startsWith(prefix))
						.map((key) => key.slice(prefix.length));
				}),
			getMcpOauth: (serverKey) => get(mcpKey(serverKey)),
			setMcpOauth: (serverKey, bundleJson) =>
				set(mcpKey(serverKey), bundleJson),
			removeMcpOauth: (serverKey) => remove(mcpKey(serverKey)),
		});
	});
