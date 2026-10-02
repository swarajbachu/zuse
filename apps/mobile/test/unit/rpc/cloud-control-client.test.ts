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
	cloudControlClientForWorkspace,
	organizationControlClientForAccount,
	resetApiAccessToken,
} from "../../../src/rpc/api-client";

describe("mobile account HTTP cloud control", () => {
	beforeEach(() => resetApiAccessToken());
	afterEach(() => vi.unstubAllGlobals());
	test("organization mutations use account endpoints and retain finance-role payloads", async () => {
		const fetcher = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetcher);
		const input = {
			organizationId: "org_a",
			memberId: "member_a",
			role: "billing" as const,
		};
		await Effect.runPromise(
			organizationControlClientForAccount()["organizations.setRole"](input),
		);
		expect(fetcher).toHaveBeenCalledWith(
			"https://staging-api.example/v1/organizations/set-role",
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bearer account-token",
					"x-zuse-workspace": "personal",
					"content-type": "application/json",
				},
				body: JSON.stringify(input),
			}),
		);
	});
	test.each([
		["organization_limit_reached", "organization-limit-reached"],
		["organization_member_limit_reached", "organization-member-limit-reached"],
	])("preserves organization policy failures: %s", async (code, expected) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: code }, { status: 409 })),
		);
		const result = await Effect.runPromise(
			Effect.result(
				organizationControlClientForAccount()["organizations.invite"]({
					organizationId: "org_a",
					email: "member@example.com",
					role: "member",
				}),
			),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "OrganizationError", code: expected },
		});
	});
	test("organization clients cannot mutate after an account switch", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const client = organizationControlClientForAccount();
		resetApiAccessToken();
		const result = await Effect.runPromise(
			Effect.result(
				client["organizations.removeMember"]({
					organizationId: "org_a",
					memberId: "member_a",
				}),
			),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "OrganizationError", code: "not-allowed" },
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
	test("older organization deployments report unavailable rather than a missing invitation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({}, { status: 404 })),
		);
		const result = await Effect.runPromise(
			Effect.result(
				organizationControlClientForAccount()["organizations.list"]({}),
			),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "unavailable" },
		});
	});
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
				headers: {
					authorization: "Bearer account-token",
					"x-zuse-workspace": "personal",
				},
			}),
		);
	});
	test("pins organization requests to matching URL and scope header", async () => {
		const fetcher = vi.fn(async () => Response.json({ chats: [] }));
		vi.stubGlobal("fetch", fetcher);
		const client = cloudControlClientForWorkspace({
			kind: "organization",
			organizationId: "org_a",
		});
		await Effect.runPromise(client["cloud.chats.list"]({ scope: "active" }));
		expect(fetcher).toHaveBeenCalledWith(
			"https://staging-api.example/v1/organization-workspaces/org_a/v1/cloud/chats?scope=active",
			expect.objectContaining({
				headers: {
					authorization: "Bearer account-token",
					"x-zuse-workspace": "organization:org_a",
				},
			}),
		);
	});
	test("rejects malformed organization scope before any request", () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect(() =>
			cloudControlClientForWorkspace({
				kind: "organization",
				organizationId: "org_a/../org_b",
			}),
		).toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	test("a retained workspace client cannot send under a different account", async () => {
		const client = cloudControlClientForWorkspace({
			kind: "organization",
			organizationId: "org_a",
		});
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		resetApiAccessToken();
		expect(
			await Effect.runPromise(Effect.result(client["cloud.chats.list"]({}))),
		).toMatchObject({ _tag: "Failure", failure: { code: "not-allowed" } });
		expect(fetcher).not.toHaveBeenCalled();
	});
	test.each([
		["cloud_billing_hold", "billing-hold"],
		["billing_hold", "billing-hold"],
		["billing_approval_pending", "billing-hold"],
		["cloud_branch_in_use:workspace_a", "branch-in-use"],
	] as const)("shares actionable error mapping for %s", async (error, code) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error }, { status: 409 })),
		);
		expect(
			await Effect.runPromise(
				Effect.result(cloudControlClient["cloud.chats.list"]({})),
			),
		).toMatchObject({ _tag: "Failure", failure: { code } });
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
	test("also rejects an account change while the response body is arriving", async () => {
		const body = Promise.withResolvers<unknown>();
		const response = Response.json({});
		const read = vi.spyOn(response, "json").mockReturnValue(body.promise);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		const pending = Effect.runPromise(
			Effect.result(cloudControlClient["cloud.chats.list"]({})),
		);
		await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
		resetApiAccessToken();
		body.resolve({ chats: [] });
		expect(await pending).toMatchObject({
			_tag: "Failure",
			failure: { code: "not-allowed" },
		});
	});
});
