import { afterEach, describe, expect, it, vi } from "vitest";
import { billingPollRequest } from "../../src/cloud-billing-usage-source.ts";
import { BoxBillingUsageSourceModule } from "../../src/cloud-billing-usage-sources/box.ts";
import { E2bBillingUsageSourceModule } from "../../src/cloud-billing-usage-sources/e2b.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const api = () => ({
	hasFinalizedProviderBillingEvent: vi.fn(async () => false),
	ingestProviderBillingEvents: vi.fn(async () => 0),
});
describe("credentialed billing polls", () => {
	it.each([
		BoxBillingUsageSourceModule,
		E2bBillingUsageSourceModule,
	])("rejects insecure $provider endpoints before sending credentials", async (module) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const prefix = module.provider.toUpperCase();
		for (const endpoint of [
			"http://example.com",
			"not a URL",
			"https://user:pass@example.com",
		]) {
			await expect(
				module.poll?.({
					env: {
						[`${prefix}_API_KEY`]: "secret",
						[`${prefix}_API_BASE_URL`]: endpoint,
						CLOUD_BILLING_CUTOVER_AT: "2026-08-17T00:00:00Z",
					},
					api: api(),
					nowMs: Date.now(),
				}),
			).rejects.toBeDefined();
		}
		expect(fetch).not.toHaveBeenCalled();
	});
	it("uses a timeout signal and rejects redirects", async () => {
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(init.redirect).toBe("error");
			return new Response("{}");
		});
		vi.stubGlobal("fetch", fetch);
		await billingPollRequest("https://api.test", {
			authorization: "Bearer token",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each([
		"BOX_API_KEY",
		"BOAT_API_KEY",
	])("only synthesizes validated Boat closes using %s", async (keyName) => {
		const updatedAt = "2026-08-17T12:00:00Z";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					sandboxes: [
						null,
						{},
						{ id: "missing-state", updatedAt },
						{ id: "running", state: "ready", updatedAt },
						{ id: "missing-time", state: "archived" },
						{ id: "invalid-time", state: "error", updatedAt: "invalid" },
						{ id: "valid", state: "archived", updatedAt },
					],
				}),
			),
		);
		const recovery = api();
		await BoxBillingUsageSourceModule.poll?.({
			env: { [keyName]: "secret", CLOUD_BILLING_CUTOVER_AT: updatedAt },
			api: recovery,
			nowMs: Date.parse(updatedAt),
		});
		expect(recovery.ingestProviderBillingEvents).toHaveBeenCalledWith(
			"box",
			[
				expect.objectContaining({
					type: "box.archived",
					createdAt: updatedAt,
					data: { box: { id: "valid", name: null }, state: "archived" },
				}),
			],
			Date.parse(updatedAt),
		);
	});
});

it("aborts a stalled poll after the request budget", async () => {
	vi.useFakeTimers();
	const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(
			() => controller.abort(new Error("request budget exceeded")),
			ms,
		);
		return controller.signal;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		),
	);
	const outcome = billingPollRequest("https://api.test", {}).catch(
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(await outcome).toEqual(new Error("request budget exceeded"));
	expect(timeout).toHaveBeenCalledWith(30_000);
});
