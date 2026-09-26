import { CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCloudControlRequest } from "../../src/cloud-control-request.ts";

const resultSchema = Schema.Struct({ ok: Schema.Boolean });
afterEach(() => vi.unstubAllGlobals());
describe("account-owned cloud HTTP", () => {
	it("authenticates and decodes requests without a runtime connection", async () => {
		const fetch = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetch);
		const request = makeCloudControlRequest({
			token: async () => "account-token",
			url: (path) => `https://api.example${path}`,
		});
		expect(
			await Effect.runPromise(
				request("/v1/cloud/example", resultSchema, "POST", {
					commandId: "stable",
				}),
			),
		).toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledWith(
			"https://api.example/v1/cloud/example",
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bearer account-token",
					"content-type": "application/json",
				},
				body: '{"commandId":"stable"}',
			}),
		);
	});
	it("never fetches with a missing or superseded account", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		let epoch = 0;
		const request = makeCloudControlRequest({
			token: async () => {
				epoch++;
				return "old-token";
			},
			url: (path) => path,
			epoch: () => epoch,
		});
		const failure = await Effect.runPromise(
			Effect.flip(request("/test", resultSchema)),
		);
		expect(failure).toBeInstanceOf(CloudWorkspaceOpError);
		expect(failure.code).toBe("not-allowed");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		[401, "expired", "not-allowed"],
		[409, "cloud_branch_in_use:feature/demo", "branch-in-use"],
		[409, "other_conflict", "conflict"],
		[403, "cloud_entitlement_required", "entitlement-required"],
		[409, "cloud_image_rebuild_required", "project-not-ready"],
		[503, "unavailable", "provider-unavailable"],
	])("preserves actionable failure %s/%s", async (status, error, code) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error }, { status: Number(status) })),
		);
		const request = makeCloudControlRequest({
			token: async () => "token",
			url: (path) => path,
		});
		expect(
			(await Effect.runPromise(Effect.flip(request("/test", resultSchema))))
				.code,
		).toBe(code);
	});
	it("rejects malformed successful responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: "wrong" })),
		);
		const request = makeCloudControlRequest({
			token: async () => "token",
			url: (path) => path,
		});
		expect(
			(await Effect.runPromise(Effect.flip(request("/test", resultSchema))))
				.code,
		).toBe("invalid-request");
	});
});
