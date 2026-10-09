import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createHostedEndpointLease,
	hostedAccessToken,
	hostedAccountRequest,
	hostedAccountUser,
	hostedAuthState,
	hostedAuthTokenEndpoint,
	hostedSignedIn,
	isHostedProduct,
	listHostedEnvironments,
	removeHostedComputer,
	resolveHostedWorkosClientId,
	subscribeHostedAuth,
} from "../../src/lib/hosted-connect.ts";
import {
	observeRendererAccount,
	rendererAccountSnapshot,
} from "../../src/lib/renderer-account.ts";

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
// Minimal indexedDB stand-in: enough of the API surface for the hosted DPoP
// key store (open / objectStore get+put / deleteDatabase).
const indexedDbMock = () => {
	const data = new Map<string, unknown>();
	const db = {
		objectStoreNames: { contains: () => true },
		createObjectStore: () => ({}),
		close: () => undefined,
		transaction: () => ({
			objectStore: () => ({
				get: (key: string) => {
					const request = {
						result: data.get(key),
						onsuccess: null as null | (() => void),
						onerror: null,
					};
					queueMicrotask(() => request.onsuccess?.());
					return request;
				},
				put: (value: unknown, key: string) => {
					data.set(key, value);
					const request = {
						onsuccess: null as null | (() => void),
						onerror: null,
					};
					queueMicrotask(() => request.onsuccess?.());
					return request;
				},
			}),
		}),
	};
	return {
		open: () => {
			const request = {
				result: db,
				onupgradeneeded: null as null | (() => void),
				onsuccess: null as null | (() => void),
				onerror: null,
			};
			queueMicrotask(() => {
				request.onupgradeneeded?.();
				request.onsuccess?.();
			});
			return request;
		},
		deleteDatabase: () => {
			const request = {
				onsuccess: null as null | (() => void),
				onerror: null,
				onblocked: null,
			};
			queueMicrotask(() => request.onsuccess?.());
			return request;
		},
	};
};
// The hosted DPoP exchange runs before the account call; mints always succeed.
const apiMock = (
	handler: (url: string, init?: RequestInit) => Promise<Response>,
) =>
	vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).endsWith("/v1/client/dpop-token")) {
			return Response.json({ accessToken: "api-token", expiresIn: 60_000 });
		}
		return handler(String(url), init);
	});
beforeEach(() => {
	vi.stubGlobal("localStorage", storageMock());
	vi.stubGlobal("sessionStorage", storageMock());
	vi.stubGlobal("indexedDB", indexedDbMock());
});
const STAGING_CLIENT_ID = "client_01KW6ZEZKVMZ0G429A89XZD83Q";
const PRODUCTION_CLIENT_ID = "client_01KWGQ818571ARFATQ3G9AR2Y2";

describe("hosted account ownership", () => {
	const key = "zuse.hosted.session.v1";
	const user = {
		id: "guest",
		email: "guest@example.test",
		firstName: "Guest",
		lastName: null,
		profilePictureUrl: null,
	};
	const token = `header.${btoa(JSON.stringify({ sub: user.id, exp: 9_999_999_999 }))}.signature`;
	beforeEach(() => {
		const items = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => items.set(key, value),
			removeItem: (key: string) => items.delete(key),
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("routes organization HTTP requests through the versioned namespace and rejects invalid scopes", async () => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				user,
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 9_999_999_999_000,
			}),
		);
		await hostedSignedIn();
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({}));
		await hostedAccountRequest(
			"/v1/cloud/workspaces/workspace/sharing",
			{ audience: "private" },
			{
				method: "PUT",
				workspace: { kind: "organization", organizationId: "org_a" },
			},
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining(
				"/v1/organization-workspaces/org_a/v1/cloud/workspaces/workspace/sharing",
			),
			expect.objectContaining({
				method: "PUT",
				headers: expect.objectContaining({
					"x-zuse-workspace": "organization:org_a",
				}),
				body: JSON.stringify({ audience: "private" }),
			}),
		);
		await expect(
			hostedAccountRequest("/v1/cloud/chats", undefined, {
				workspace: { kind: "organization", organizationId: "../other" },
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("uses the browser profile and publishes its identity without asking the host", async () => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				user,
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 9_999_999_999_000,
			}),
		);
		const fetch = vi.spyOn(globalThis, "fetch");
		const listener = vi.fn();
		const unsubscribe = subscribeHostedAuth(listener);
		await expect(hostedSignedIn()).resolves.toBe(true);
		expect(rendererAccountSnapshot().subject).toBe("guest");
		expect(hostedAuthState()).toMatchObject({
			_tag: "SignedIn",
			session: { user },
		});
		expect(hostedAuthState()).toBe(hostedAuthState());
		expect(fetch).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
	});
	it("refreshes legacy token-only sessions through the existing account endpoint", async () => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 9_999_999_999_000,
			}),
		);
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json({ access_token: token, refresh_token: "rotated", user }),
			);
		await expect(hostedSignedIn()).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		expect(hostedAuthState()).toMatchObject({ session: { user } });
	});
	it("does not adopt a cached host profile for a different token subject", () => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				user: { ...user, id: "owner" },
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 9_999_999_999_000,
			}),
		);
		expect(hostedAuthState()).toEqual({ _tag: "SignedOut" });
	});
	it("does not resurrect a session cleared during refresh", async () => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				user,
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 0,
			}),
		);
		const response = Promise.withResolvers<Response>();
		vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
		const pending = hostedSignedIn();
		localStorage.setItem(key, "null");
		response.resolve(
			Response.json({ access_token: token, refresh_token: "rotated", user }),
		);
		await expect(pending).resolves.toBe(false);
		expect(sessionStorage.getItem(key)).toBeNull();
		expect(rendererAccountSnapshot().subject).toBeNull();
	});
	it.each([
		"headers",
		"body",
	])("discards an environment list when the account changes during %s", async (phase) => {
		sessionStorage.setItem(
			key,
			JSON.stringify({
				user,
				accessToken: token,
				refreshToken: "refresh",
				expiresAt: 9_999_999_999_000,
			}),
		);
		await hostedSignedIn();
		const headers = Promise.withResolvers<Response>();
		const body = Promise.withResolvers<unknown>();
		const response = Response.json({ environments: [] });
		const json = vi.spyOn(response, "json").mockReturnValue(body.promise);
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(apiMock(() => headers.promise));
		const pending = listHostedEnvironments();
		const rejected = expect(pending).rejects.toThrow(
			"The connection account changed",
		);
		// Call 1 mints the DPoP token; call 2 is the environments request.
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		if (phase === "body") {
			headers.resolve(response);
			await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
		}
		// Returning to the same subject must not revive the earlier request.
		observeRendererAccount("another-account");
		observeRendererAccount(user.id);
		headers.resolve(response);
		body.resolve({ environments: [] });
		await rejected;
	});
});

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
		const refresh = vi
			.fn<(environmentId: string) => Promise<string>>()
			.mockResolvedValueOnce("wss://host.example/rpc?token=initial")
			.mockResolvedValue("wss://host.example/rpc?token=fresh");
		const lease = createHostedEndpointLease(refresh);
		await lease.select("env-1");

		await expect(lease.next()).resolves.toBe(
			"wss://host.example/rpc?token=initial",
		);
		await expect(lease.next()).resolves.toBe(
			"wss://host.example/rpc?token=fresh",
		);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenCalledWith("env-1");
	});
	it.each([
		"select",
		"reconnect",
	])("discards a pending %s after selecting another environment", async (phase) => {
		const stale = Promise.withResolvers<string>();
		const refresh = vi
			.fn<(environmentId: string) => Promise<string>>()
			.mockResolvedValueOnce("initial");
		const lease = createHostedEndpointLease(refresh);
		await lease.select("old");
		await lease.next();
		refresh.mockReturnValueOnce(stale.promise).mockResolvedValue("new");
		const pending = phase === "select" ? lease.select("old") : lease.next();
		const rejected = expect(pending).rejects.toThrow(
			"hosted_environment_changed",
		);
		await lease.select("new");
		stale.resolve("stale");
		await rejected;
		await expect(lease.next()).resolves.toBe("new");
	});
	it("does not revive a cleared selection, even when the same environment is selected again", async () => {
		const stale = Promise.withResolvers<string>();
		const refresh = vi
			.fn<(environmentId: string) => Promise<string>>()
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValue("new");
		const lease = createHostedEndpointLease(refresh);
		const pending = lease.select("env-1");
		const rejected = expect(pending).rejects.toThrow(
			"hosted_environment_changed",
		);
		lease.clear();
		await expect(lease.next()).rejects.toThrow(
			"hosted_environment_not_selected",
		);
		await lease.select("env-1");
		stale.resolve("stale");
		await rejected;
		await expect(lease.next()).resolves.toBe("new");
	});
	it("gives simultaneous reconnects distinct one-use grants", async () => {
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const refresh = vi
			.fn<(environmentId: string) => Promise<string>>()
			.mockResolvedValueOnce("initial")
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const lease = createHostedEndpointLease(refresh);
		await lease.select("env-1");
		await lease.next();
		const one = lease.next();
		const two = lease.next();
		second.resolve("second");
		first.resolve("first");
		await expect(Promise.all([one, two])).resolves.toEqual(["first", "second"]);
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
					user: {
						id: "recovered-user",
						email: "test@example.test",
						firstName: null,
						lastName: null,
						profilePictureUrl: null,
					},
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
		const fetch = apiMock(async () => Response.json({}, { status }));
		vi.stubGlobal("fetch", fetch);
		await removeHostedComputer("computer-one");
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("/v1/client/dpop-token"),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer account-token",
				}),
			}),
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("/v1/client/environment-unlink"),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "DPoP api-token",
					dpop: expect.any(String),
					"content-type": "application/json",
				}),
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
			apiMock(async () => Response.json({}, { status: 503 })),
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
