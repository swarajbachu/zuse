import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createHostedEndpointLease,
	hostedAccessToken,
	hostedAccountUser,
	hostedAuthTokenEndpoint,
	isHostedProduct,
	removeHostedComputer,
	resolveHostedWorkosClientId,
} from "../../src/lib/hosted-connect.ts";

const sessionKey = "zuse.hosted.session.v1";
const storageMock = (entries: [string, string][] = []) => {
	const values = new Map(entries);
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
};
beforeEach(() => {
	vi.stubGlobal("localStorage", storageMock());
	vi.stubGlobal("sessionStorage", storageMock());
});
const STAGING_CLIENT_ID = "client_01KW6ZEZKVMZ0G429A89XZD83Q";
const PRODUCTION_CLIENT_ID = "client_01KWGQ818571ARFATQ3G9AR2Y2";

describe("hosted authentication", () => {
	it("exchanges browser tokens through the configured api", () => {
		expect(hostedAuthTokenEndpoint("http://127.0.0.1:8790/")).toBe(
			"http://127.0.0.1:8790/v1/auth/token",
		);
	});

	it("recognizes the canonical hosted product domain", () => {
		expect(isHostedProduct("https://code.zuse.sh")).toBe(true);
		expect(isHostedProduct("https://app.zuse.sh")).toBe(false);
	});

	it("uses the staging AuthKit client during development", () => {
		expect(resolveHostedWorkosClientId(undefined, true)).toBe(
			STAGING_CLIENT_ID,
		);
		expect(resolveHostedWorkosClientId(undefined, false)).toBe(
			PRODUCTION_CLIENT_ID,
		);
		expect(resolveHostedWorkosClientId("client_override", true)).toBe(
			"client_override",
		);
	});

	it("uses each connect grant once and refreshes it for reconnects", async () => {
		const lease = createHostedEndpointLease();
		const refresh = vi.fn(async (environmentId: string) => {
			lease.set(environmentId, "wss://host.example/rpc?token=fresh");
		});

		lease.set("env-1", "wss://host.example/rpc?token=initial");

		await expect(lease.next(refresh)).resolves.toBe(
			"wss://host.example/rpc?token=initial",
		);
		await expect(lease.next(refresh)).resolves.toBe(
			"wss://host.example/rpc?token=fresh",
		);
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith("env-1");
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("shares one refresh-token exchange between concurrent cloud requests", async () => {
	const storage = new Map([
		[
			"zuse.hosted.session.v1",
			JSON.stringify({
				accessToken: "expired",
				refreshToken: "rotate-once",
				expiresAt: 0,
			}),
		],
	]);
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	const fetch = vi.fn(async () =>
		Response.json({
			access_token: "fresh-token",
			refresh_token: "rotated",
			user: {
				id: "account-1",
				email: "person@example.com",
				firstName: "Test",
				lastName: "Person",
				profilePictureUrl: "https://example.com/avatar.png",
			},
		}),
	);
	vi.stubGlobal("fetch", fetch);
	expect(
		await Promise.all([
			hostedAccessToken(),
			hostedAccessToken(),
			hostedAccessToken(),
		]),
	).toEqual(["fresh-token", "fresh-token", "fresh-token"]);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(hostedAccountUser()).toEqual({
		id: "account-1",
		email: "person@example.com",
		firstName: "Test",
		lastName: "Person",
		profilePictureUrl: "https://example.com/avatar.png",
	});
	expect(
		JSON.parse(localStorage.getItem(sessionKey) ?? "null").refreshToken,
	).toBe("rotated");
});

it("keeps a login when a tab closes and a new visit starts", async () => {
	sessionStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "persisted",
			refreshToken: "refresh",
			expiresAt: Date.now() + 300000,
			user: null,
		}),
	);
	expect(await hostedAccessToken()).toBe("persisted");
	vi.stubGlobal("sessionStorage", storageMock());
	expect(await hostedAccessToken()).toBe("persisted");
});
it("keeps the refresh credential through a temporary network failure", async () => {
	sessionStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "expired",
			refreshToken: "retry-me",
			expiresAt: 0,
			user: null,
		}),
	);
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockRejectedValueOnce(new TypeError("offline"))
			.mockResolvedValueOnce(
				Response.json({
					access_token: "recovered",
					refresh_token: "rotated",
					user: null,
				}),
			),
	);
	await expect(hostedAccessToken()).rejects.toThrow("offline");
	expect(await hostedAccessToken()).toBe("recovered");
});
it("does not resurrect an old tab's login after shared sign-out", async () => {
	sessionStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "old",
			refreshToken: "old-refresh",
			expiresAt: Date.now() + 300000,
			user: null,
		}),
	);
	localStorage.setItem(sessionKey, "null");
	expect(await hostedAccessToken()).toBeNull();
});

it("uses a token another tab refreshed while waiting for the refresh lock", async () => {
	localStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "expired",
			refreshToken: "old",
			expiresAt: 0,
			user: null,
		}),
	);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const request = vi.fn(
		async (_name: string, run: () => Promise<string | null>) => {
			localStorage.setItem(
				sessionKey,
				JSON.stringify({
					accessToken: "other-tab-token",
					refreshToken: "rotated",
					expiresAt: Date.now() + 300000,
					user: null,
				}),
			);
			return run();
		},
	);
	vi.stubGlobal("navigator", { locks: { request } });
	expect(await hostedAccessToken()).toBe("other-tab-token");
	expect(fetch).not.toHaveBeenCalled();
	expect(request).toHaveBeenCalledOnce();
});
it.each([429, 500, 503])("preserves credentials on HTTP %s", async (status) => {
	const stored = JSON.stringify({
		accessToken: "expired",
		refreshToken: "retry",
		expiresAt: 0,
		user: null,
	});
	localStorage.setItem(sessionKey, stored);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ error: "unavailable" }, { status })),
	);
	await expect(hostedAccessToken()).rejects.toThrow("unavailable");
	expect(localStorage.getItem(sessionKey)).toBe(stored);
});
it("clears a refresh credential only when the server rejects it", async () => {
	localStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "expired",
			refreshToken: "revoked",
			expiresAt: 0,
			user: null,
		}),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ error: "invalid_grant" }, { status: 400 }),
		),
	);
	expect(await hostedAccessToken()).toBeNull();
	expect(localStorage.getItem(sessionKey)).toBe("null");
});
it("does not restore a login when another tab signs out during refresh", async () => {
	localStorage.setItem(
		sessionKey,
		JSON.stringify({
			accessToken: "expired",
			refreshToken: "old",
			expiresAt: 0,
			user: null,
		}),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			localStorage.setItem(sessionKey, "null");
			return Response.json({
				access_token: "late-token",
				refresh_token: "late-refresh",
				user: null,
			});
		}),
	);
	expect(await hostedAccessToken()).toBeNull();
	expect(localStorage.getItem(sessionKey)).toBe("null");
});

describe("removing hosted computers", () => {
	it.each([
		200, 404,
	])("accepts successful and already removed registrations (%s)", async (status) => {
		localStorage.setItem(
			sessionKey,
			JSON.stringify({
				accessToken: "account-token",
				user: {
					id: "account-a",
					email: "test@example.com",
					firstName: null,
					lastName: null,
					profilePictureUrl: null,
				},
				refreshToken: "refresh",
				expiresAt: Date.now() + 3600000,
			}),
		);
		const fetch = vi.fn(async () => Response.json({}, { status }));
		vi.stubGlobal("fetch", fetch);
		await removeHostedComputer("computer-one");
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("/v1/client/environment-unlink"),
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bearer account-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ environmentId: "computer-one" }),
			}),
		);
	});
	it("surfaces a failed removal for retry", async () => {
		localStorage.setItem(
			sessionKey,
			JSON.stringify({
				accessToken: "account-token",
				user: {
					id: "account-a",
					email: "test@example.com",
					firstName: null,
					lastName: null,
					profilePictureUrl: null,
				},
				refreshToken: "refresh",
				expiresAt: Date.now() + 3600000,
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({}, { status: 503 })),
		);
		await expect(removeHostedComputer("computer-one")).rejects.toThrow(
			"api_unlink_503",
		);
	});
	it("does not issue unauthenticated removal requests", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(removeHostedComputer("computer-one")).rejects.toThrow(
			"hosted_signed_out",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
