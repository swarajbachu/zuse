import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("~/auth/config", () => ({
	apiBaseUrl: () => "https://staging-api.example",
}));
vi.mock("~/auth/dpop", () => ({
	devicePublicJwk: vi.fn(),
	signDpopProof: vi.fn(),
}));
vi.mock("~/auth/workos", () => ({
	getAccessToken: vi.fn(async () => "account-token"),
}));

import {
	cloudControlClient,
	resetApiAccessToken,
} from "../../../src/rpc/api-client";

describe("mobile account HTTP cloud control", () => {
	beforeEach(() => resetApiAccessToken());
	afterEach(() => vi.unstubAllGlobals());
	test("discovers cloud chats with account Bearer auth, not a device DPoP grant", async () => {
		const fetcher = vi.fn(async () => Response.json({ chats: [] }));
		vi.stubGlobal("fetch", fetcher);
		await Effect.runPromise(
			cloudControlClient["cloud.chats.list"]({ scope: "active" }),
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher).toHaveBeenCalledWith(
			"https://staging-api.example/v1/cloud/chats?scope=active",
			expect.objectContaining({
				method: "GET",
				headers: { authorization: "Bearer account-token" },
			}),
		);
	});
	test("preserves typed billing denial", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ error: "cloud_entitlement_required" }, { status: 403 }),
			),
		);
		const result = await Effect.runPromise(
			Effect.result(cloudControlClient["cloud.chats.list"]({})),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "entitlement-required" },
		});
	});
	test("HTML 401 is sign-in required, not a provider network failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response("<html>unauthorized</html>", { status: 401 }),
			),
		);
		const result = await Effect.runPromise(
			Effect.result(cloudControlClient["cloud.chats.list"]({})),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "not-allowed" },
		});
	});
	test("refuses a response that crosses an account reset", async () => {
		let finish!: (value: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const request = Effect.runPromise(
			Effect.result(cloudControlClient["cloud.chats.list"]({})),
		);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
		resetApiAccessToken();
		finish(Response.json({ chats: [] }));
		expect(await request).toMatchObject({
			_tag: "Failure",
			failure: { code: "not-allowed" },
		});
	});
});
