import type { ProviderId } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AuthServiceLive } from "../../src/auth/layers/auth-service.ts";
import type { SessionBundle } from "../../src/auth/layers/workos.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { AuthShell } from "../../src/auth/services/auth-shell.ts";
import { SessionStore } from "../../src/auth/services/session-store.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const jwtWithExp = (expMs: number): string => {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({ exp: Math.floor(expMs / 1000) }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
};

const makeBundle = (overrides: Partial<SessionBundle> = {}): SessionBundle => ({
	accessToken: jwtWithExp(Date.now() + 15 * 60_000),
	refreshToken: "refresh-token",
	expiresAt: Date.now() + 15 * 60_000,
	refreshedAt: Date.now(),
	organizationId: null,
	user: {
		id: "user_123",
		email: "user@example.com",
		firstName: "User",
		lastName: "One",
		profilePictureUrl: null,
	},
	...overrides,
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> => {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition.");
		}
		await delay(10);
	}
};

interface Harness {
	readonly run: <A>(
		effect: Effect.Effect<A, unknown, AuthService>,
	) => Promise<A>;
	readonly readStored: () => SessionBundle | null;
	readonly dispose: () => Promise<void>;
}

const makeHarness = (
	initial: SessionBundle | null,
	options: {
		readonly onRead?: (
			stored: SessionBundle | null,
			readCount: number,
		) => SessionBundle | null;
	} = {},
): Harness => {
	let stored: SessionBundle | null = initial;
	let readCount = 0;
	const CredentialsLayer = Layer.succeed(
		CredentialsService,
		CredentialsService.of({
			get: (_providerId: ProviderId) => Effect.succeed(null),
			set: (_providerId: ProviderId, _apiKey: string) => Effect.void,
			remove: (_providerId: ProviderId) => Effect.void,
			listConfigured: () => Effect.succeed([]),
			setBrowser: (_origin: string, _username: string, _password: string) =>
				Effect.void,
			getBrowser: (_origin: string) => Effect.succeed(null),
			removeBrowser: (_origin: string) => Effect.void,
			listBrowser: () => Effect.succeed([]),
			getWorkosSession: () => Effect.succeed(null),
			setWorkosSession: (bundleJson: string) =>
				Effect.sync(() => {
					stored = JSON.parse(bundleJson) as SessionBundle;
				}),
			removeWorkosSession: () =>
				Effect.sync(() => {
					stored = null;
				}),
			getIntegration: () => Effect.succeed(null),
			setIntegration: () => Effect.void,
			removeIntegration: () => Effect.void,
			listIntegrationAccounts: () => Effect.succeed([]),
		}),
	);
	const AuthShellLayer = Layer.succeed(
		AuthShell,
		AuthShell.of({
			redirectUri: "zuse://auth/callback",
			open: (_url: string) => Effect.void,
			onCallbackUrl: (_handler: (url: string) => void) => Effect.void,
		}),
	);
	const SessionStoreLayer = Layer.succeed(
		SessionStore,
		SessionStore.of({
			read: () =>
				Effect.sync(() => {
					readCount += 1;
					return options.onRead?.(stored, readCount) ?? stored;
				}),
			write: (bundle) =>
				Effect.sync(() => {
					if (stored !== null && stored.refreshedAt > bundle.refreshedAt) {
						return stored;
					}
					stored = bundle;
					return bundle;
				}),
			clear: () =>
				Effect.sync(() => {
					stored = null;
				}),
			withLock: (effect) => effect,
		}),
	);
	const runtime = ManagedRuntime.make(
		AuthServiceLive.pipe(
			Layer.provide(CredentialsLayer),
			Layer.provide(SessionStoreLayer),
			Layer.provide(AuthShellLayer),
		),
	);
	return {
		run: <A>(effect: Effect.Effect<A, unknown, AuthService>) =>
			runtime.runPromise(effect as Effect.Effect<A, unknown, never>),
		readStored: () => stored,
		dispose: () => runtime.dispose(),
	};
};

const mockAuthenticate = (
	handler: (body: Record<string, string>) => Response | Promise<Response>,
): Array<Record<string, string>> => {
	const calls: Array<Record<string, string>> = [];
	globalThis.fetch = (async (
		_input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<
			string,
			string
		>;
		calls.push(body);
		return await handler(body);
	}) as typeof fetch;
	return calls;
};

describe("AuthService WorkOS refresh", () => {
	it("refreshes an expired access token and persists the rotated refresh token", async () => {
		const old = makeBundle({
			accessToken: jwtWithExp(Date.now() - 5 * 60_000),
			refreshToken: "old-refresh",
			expiresAt: Date.now() - 5 * 60_000,
		});
		const nextAccessToken = jwtWithExp(Date.now() + 20 * 60_000);
		const calls = mockAuthenticate((body) => {
			expect(body.grant_type).toBe("refresh_token");
			expect(body.refresh_token).toBe("old-refresh");
			return Response.json({
				access_token: nextAccessToken,
				refresh_token: "rotated-refresh",
				organization_id: "org_123",
				user: {
					id: "user_123",
					email: "user@example.com",
					first_name: "User",
					last_name: "One",
				},
			});
		});
		const harness = makeHarness(old);
		try {
			const token = await harness.run(
				Effect.flatMap(AuthService, (svc) => svc.getAccessToken()),
			);
			expect(token).toBe(nextAccessToken);
			expect(calls).toHaveLength(1);
			expect(harness.readStored()).toMatchObject({
				accessToken: nextAccessToken,
				refreshToken: "rotated-refresh",
				organizationId: "org_123",
			});
		} finally {
			await harness.dispose();
		}
	});

	it("serializes concurrent refreshes so the stale refresh token is used once", async () => {
		const old = makeBundle({
			accessToken: jwtWithExp(Date.now() - 5 * 60_000),
			refreshToken: "single-use-refresh",
			expiresAt: Date.now() - 5 * 60_000,
		});
		const nextAccessToken = jwtWithExp(Date.now() + 20 * 60_000);
		const calls = mockAuthenticate(async (body) => {
			expect(body.refresh_token).toBe("single-use-refresh");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return Response.json({
				access_token: nextAccessToken,
				refresh_token: "rotated-once",
				user: { id: "user_123", email: "user@example.com" },
			});
		});
		const harness = makeHarness(old);
		try {
			const [first, second] = await Promise.all([
				harness.run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken())),
				harness.run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken())),
			]);
			expect(first).toBe(nextAccessToken);
			expect(second).toBe(nextAccessToken);
			expect(calls).toHaveLength(1);
			expect(harness.readStored()?.refreshToken).toBe("rotated-once");
		} finally {
			await harness.dispose();
		}
	});

	it("keeps getSession signed in when refresh has a transient failure", async () => {
		const old = makeBundle({
			accessToken: jwtWithExp(Date.now() - 5 * 60_000),
			refreshToken: "temporarily-failing-refresh",
			expiresAt: Date.now() - 5 * 60_000,
		});
		const calls = mockAuthenticate(
			() => new Response("temporary outage", { status: 503 }),
		);
		const harness = makeHarness(old);
		try {
			const state = await harness.run(
				Effect.flatMap(AuthService, (svc) => svc.getSession()),
			);
			expect(state._tag).toBe("SignedIn");
			await waitFor(() => calls.length === 1);
			expect(calls).toHaveLength(1);
			expect(harness.readStored()?.refreshToken).toBe(
				"temporarily-failing-refresh",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("returns a stale signed-in session immediately while refresh runs in the background", async () => {
		const old = makeBundle({
			accessToken: jwtWithExp(Date.now() - 5 * 60_000),
			refreshToken: "expired-refresh",
			expiresAt: Date.now() - 5 * 60_000,
			refreshedAt: Date.now(),
		});
		let releaseRefresh: () => void = () => {};
		const nextAccessToken = jwtWithExp(Date.now() + 20 * 60_000);
		const calls = mockAuthenticate(async () => {
			await new Promise<void>((resolve) => {
				releaseRefresh = resolve;
			});
			return Response.json({
				access_token: nextAccessToken,
				refresh_token: "background-refresh",
				user: { id: "user_123", email: "user@example.com" },
			});
		});
		const harness = makeHarness(old);
		try {
			const state = await harness.run(
				Effect.flatMap(AuthService, (svc) => svc.getSession()),
			);
			expect(state._tag).toBe("SignedIn");
			await waitFor(() => calls.length === 1);
			releaseRefresh();
			await waitFor(
				() => harness.readStored()?.refreshToken === "background-refresh",
			);
		} finally {
			releaseRefresh();
			await harness.dispose();
		}
	});

	it("sessionChanges emits the current auth state before live updates", async () => {
		const signedInHarness = makeHarness(makeBundle());
		try {
			const first = await signedInHarness.run(
				Effect.gen(function* () {
					const svc = yield* AuthService;
					return yield* svc
						.sessionChanges()
						.pipe(Stream.take(1), Stream.runCollect);
				}),
			);
			expect(first[0]?._tag).toBe("SignedIn");
		} finally {
			await signedInHarness.dispose();
		}

		const signedOutHarness = makeHarness(null);
		try {
			const first = await signedOutHarness.run(
				Effect.gen(function* () {
					const svc = yield* AuthService;
					return yield* svc
						.sessionChanges()
						.pipe(Stream.take(1), Stream.runCollect);
				}),
			);
			expect(first).toEqual([{ _tag: "SignedOut" }]);
		} finally {
			await signedOutHarness.dispose();
		}
	});

	it("rejects refresh responses that do not include a new refresh token", async () => {
		const old = makeBundle({
			accessToken: jwtWithExp(Date.now() - 5 * 60_000),
			refreshToken: "old-refresh",
			expiresAt: Date.now() - 5 * 60_000,
		});
		mockAuthenticate(() =>
			Response.json({
				access_token: jwtWithExp(Date.now() + 20 * 60_000),
				user: { id: "user_123", email: "user@example.com" },
			}),
		);
		const harness = makeHarness(old);
		try {
			const result = await harness
				.run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken()))
				.then(
					() => ({ ok: true as const }),
					(err) => ({ ok: false as const, err }),
				);
			expect(result.ok).toBe(false);
			expect(harness.readStored()?.refreshToken).toBe("old-refresh");
		} finally {
			await harness.dispose();
		}
	});
});
