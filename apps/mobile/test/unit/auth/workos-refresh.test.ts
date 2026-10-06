import { beforeEach, describe, expect, test, vi } from "vitest";

import { getAccessToken, signOut } from "../../../src/auth/workos";

const secureStore = vi.hoisted(() => {
	let stored: string | null = null;
	return {
		getItemAsync: vi.fn(async () => stored),
		setItemAsync: vi.fn(async (_key: string, value: string) => {
			stored = value;
		}),
		deleteItemAsync: vi.fn(async () => {
			stored = null;
		}),
		peek: () => stored,
		seed: (value: string | null) => {
			stored = value;
		},
	};
});

vi.mock("expo-secure-store", () => secureStore);
vi.mock("expo-auth-session", () => ({}));

const expiredSession = {
	accessToken: "old-access",
	refreshToken: "single-use-refresh",
	expiresAtMs: 0,
	account: { id: "user_1", email: "a@example.com" },
};

const refreshResponse = () =>
	new Response(
		JSON.stringify({
			access_token: "new-access",
			refresh_token: "next-refresh",
			user: { id: "user_1", email: "a@example.com" },
		}),
	);

describe("WorkOS token refresh", () => {
	beforeEach(() => {
		secureStore.seed(JSON.stringify(expiredSession));
		secureStore.setItemAsync.mockClear();
	});

	test("concurrent callers share one single-use refresh", async () => {
		const fetchMock = vi.fn(async () => refreshResponse());
		vi.stubGlobal("fetch", fetchMock);

		const tokens = await Promise.all([
			getAccessToken(),
			getAccessToken(),
			getAccessToken(),
			getAccessToken(),
		]);

		expect(tokens).toEqual([
			"new-access",
			"new-access",
			"new-access",
			"new-access",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("a refresh that finishes after sign-out does not restore the session", async () => {
		let resolve: (response: Response) => void = () => undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((done) => {
						resolve = done;
					}),
			),
		);

		const pending = getAccessToken();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		await signOut();
		resolve(refreshResponse());

		await expect(pending).rejects.toThrow("not_signed_in");
		expect(secureStore.peek()).toBeNull();
		expect(secureStore.setItemAsync).not.toHaveBeenCalled();
	});
});
