import type { ProviderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import keytar from "keytar";

import { CredentialsError } from "../errors.ts";
import { CredentialsService } from "../services/credentials-service.ts";

const SERVICE_NAME = "zuse";
const LEGACY_SERVICE_NAME = "memoize";

/**
 * Keychain entries are namespaced as `apiKey:<providerId>` under the
 * `zuse` service. Listing uses `findCredentials(SERVICE_NAME)` and filters
 * to the `apiKey:` prefix — keeps room for future credential kinds (refresh
 * tokens, OAuth state) without colliding with API keys.
 */
const accountFor = (providerId: ProviderId): string => `apiKey:${providerId}`;

/**
 * Browser credentials share the `zuse` keychain service but use a separate
 * `browserCred:` prefix so they never collide with `apiKey:` entries. The
 * origin is normalized (scheme + host[:port]) so `https://x.com/login` and
 * `https://x.com/` resolve to the same saved credential.
 */
const BROWSER_PREFIX = "browserCred:";
const browserAccountFor = (origin: string): string =>
	`${BROWSER_PREFIX}${normalizeOrigin(origin)}`;

/**
 * Single keychain account holding the WorkOS session bundle (JSON). One per
 * installation — signing in overwrites it, signing out deletes it.
 */
const WORKOS_SESSION_ACCOUNT = "workos:session";

const normalizeOrigin = (input: string): string => {
	try {
		return new URL(input).origin;
	} catch {
		// Not a full URL — best effort: strip any path/query and lowercase host.
		return input.trim().replace(/\/.*$/, "").toLowerCase();
	}
};

interface BrowserCred {
	readonly username: string;
	readonly password: string;
}

const parseBrowserCred = (raw: string | null): BrowserCred | null => {
	if (raw === null) return null;
	try {
		const obj = JSON.parse(raw) as Partial<BrowserCred>;
		if (typeof obj.username === "string" && typeof obj.password === "string") {
			return { username: obj.username, password: obj.password };
		}
	} catch {
		// Corrupt entry — treat as absent.
	}
	return null;
};

const KNOWN_PROVIDERS: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"cursor",
];

const isKnownProvider = (id: string): id is ProviderId =>
	(KNOWN_PROVIDERS as ReadonlyArray<string>).includes(id);

const providerCache = new Map<ProviderId, string | null>();
const browserCache = new Map<string, BrowserCred | null>();
let configuredCache: ReadonlyArray<ProviderId> | null = null;
let browserListCache: ReadonlyArray<{
	origin: string;
	username: string;
}> | null = null;

const invalidateProviderList = (): void => {
	configuredCache = null;
};

const invalidateBrowserList = (): void => {
	browserListCache = null;
};

const collectConfigured = (
	entries: ReadonlyArray<{ account: string }>,
): ProviderId[] => {
	const out: ProviderId[] = [];
	for (const { account } of entries) {
		const idx = account.indexOf(":");
		if (idx === -1 || account.slice(0, idx) !== "apiKey") continue;
		const id = account.slice(idx + 1);
		if (isKnownProvider(id) && !out.includes(id)) out.push(id);
	}
	return out;
};

const collectBrowser = (
	entries: ReadonlyArray<{ account: string; password: string }>,
): Array<{ origin: string; username: string }> => {
	const out: Array<{ origin: string; username: string }> = [];
	for (const { account, password } of entries) {
		if (!account.startsWith(BROWSER_PREFIX)) continue;
		const origin = account.slice(BROWSER_PREFIX.length);
		const cred = parseBrowserCred(password);
		out.push({ origin, username: cred?.username ?? "" });
	}
	return out;
};

const tryKeychain = <A>(
	providerId: ProviderId | "*",
	thunk: () => Promise<A>,
): Effect.Effect<A, CredentialsError> =>
	Effect.tryPromise({
		try: thunk,
		catch: (cause) =>
			new CredentialsError({
				providerId: providerId === "*" ? "" : providerId,
				reason: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
	});

const getPasswordWithLegacyPromotion = async (
	account: string,
): Promise<string | null> => {
	const current = await keytar.getPassword(SERVICE_NAME, account);
	if (current !== null) return current;

	const legacy = await keytar.getPassword(LEGACY_SERVICE_NAME, account);
	if (legacy !== null) {
		await keytar.setPassword(SERVICE_NAME, account, legacy);
	}
	return legacy;
};

export const CredentialsServiceLive = Layer.succeed(
	CredentialsService,
	CredentialsService.of({
		get: (providerId) =>
			providerCache.has(providerId)
				? Effect.succeed(providerCache.get(providerId) ?? null)
				: tryKeychain(providerId, () =>
						getPasswordWithLegacyPromotion(accountFor(providerId)),
					).pipe(
						Effect.tap((value) =>
							Effect.sync(() => {
								providerCache.set(providerId, value);
							}),
						),
					),
		set: (providerId, apiKey) =>
			tryKeychain(providerId, () =>
				keytar.setPassword(SERVICE_NAME, accountFor(providerId), apiKey),
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						providerCache.set(providerId, apiKey);
						invalidateProviderList();
					}),
				),
			),
		remove: (providerId) =>
			tryKeychain(
				providerId,
				async () =>
					(await keytar.deletePassword(SERVICE_NAME, accountFor(providerId))) ||
					(await keytar.deletePassword(
						LEGACY_SERVICE_NAME,
						accountFor(providerId),
					)),
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						providerCache.delete(providerId);
						invalidateProviderList();
					}),
				),
				Effect.asVoid,
			),
		listConfigured: () =>
			configuredCache !== null
				? Effect.succeed(configuredCache)
				: tryKeychain("*", async () => {
						const current = collectConfigured(
							await keytar.findCredentials(SERVICE_NAME),
						);
						if (current.length > 0) return current;
						return collectConfigured(
							await keytar.findCredentials(LEGACY_SERVICE_NAME),
						);
					}).pipe(
						Effect.tap((value) =>
							Effect.sync(() => {
								configuredCache = value;
							}),
						),
					),
		setBrowser: (origin, username, password) =>
			tryKeychain("*", () =>
				keytar.setPassword(
					SERVICE_NAME,
					browserAccountFor(origin),
					JSON.stringify({ username, password }),
				),
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						browserCache.set(normalizeOrigin(origin), { username, password });
						invalidateBrowserList();
					}),
				),
			),
		getBrowser: (origin) =>
			browserCache.has(normalizeOrigin(origin))
				? Effect.succeed(browserCache.get(normalizeOrigin(origin)) ?? null)
				: tryKeychain("*", () =>
						getPasswordWithLegacyPromotion(browserAccountFor(origin)),
					).pipe(
						Effect.map(parseBrowserCred),
						Effect.tap((value) =>
							Effect.sync(() => {
								browserCache.set(normalizeOrigin(origin), value);
							}),
						),
					),
		removeBrowser: (origin) =>
			tryKeychain(
				"*",
				async () =>
					(await keytar.deletePassword(
						SERVICE_NAME,
						browserAccountFor(origin),
					)) ||
					(await keytar.deletePassword(
						LEGACY_SERVICE_NAME,
						browserAccountFor(origin),
					)),
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						browserCache.delete(normalizeOrigin(origin));
						invalidateBrowserList();
					}),
				),
				Effect.asVoid,
			),
		listBrowser: () =>
			browserListCache !== null
				? Effect.succeed(browserListCache)
				: tryKeychain("*", async () => {
						const current = collectBrowser(
							await keytar.findCredentials(SERVICE_NAME),
						);
						if (current.length > 0) return current;
						return collectBrowser(
							await keytar.findCredentials(LEGACY_SERVICE_NAME),
						);
					}).pipe(
						Effect.tap((value) =>
							Effect.sync(() => {
								browserListCache = value;
							}),
						),
					),
		getWorkosSession: () =>
			tryKeychain("*", () =>
				keytar.getPassword(SERVICE_NAME, WORKOS_SESSION_ACCOUNT),
			),
		setWorkosSession: (bundleJson) =>
			tryKeychain("*", () =>
				keytar.setPassword(SERVICE_NAME, WORKOS_SESSION_ACCOUNT, bundleJson),
			),
		removeWorkosSession: () =>
			tryKeychain("*", () =>
				keytar.deletePassword(SERVICE_NAME, WORKOS_SESSION_ACCOUNT),
			).pipe(Effect.asVoid),
	}),
);

/**
 * Process-local credential storage for hosts that deliberately run without an
 * OS credential store, such as ephemeral containers and isolated automation.
 * Nothing is persisted and every layer construction receives fresh state.
 */
export const CredentialsServiceEphemeral = Layer.sync(
	CredentialsService,
	() => {
		const providers = new Map<ProviderId, string>();
		const browsers = new Map<string, BrowserCred>();
		let workosSession: string | null = null;
		return CredentialsService.of({
			get: (providerId) => Effect.succeed(providers.get(providerId) ?? null),
			set: (providerId, apiKey) =>
				Effect.sync(() => {
					providers.set(providerId, apiKey);
				}),
			remove: (providerId) =>
				Effect.sync(() => {
					providers.delete(providerId);
				}),
			listConfigured: () => Effect.succeed([...providers.keys()]),
			setBrowser: (origin, username, password) =>
				Effect.sync(() => {
					browsers.set(normalizeOrigin(origin), { username, password });
				}),
			getBrowser: (origin) =>
				Effect.succeed(browsers.get(normalizeOrigin(origin)) ?? null),
			removeBrowser: (origin) =>
				Effect.sync(() => {
					browsers.delete(normalizeOrigin(origin));
				}),
			listBrowser: () =>
				Effect.succeed(
					[...browsers].map(([origin, credential]) => ({
						origin,
						username: credential.username,
					})),
				),
			getWorkosSession: () => Effect.succeed(workosSession),
			setWorkosSession: (bundleJson) =>
				Effect.sync(() => {
					workosSession = bundleJson;
				}),
			removeWorkosSession: () =>
				Effect.sync(() => {
					workosSession = null;
				}),
		});
	},
);
