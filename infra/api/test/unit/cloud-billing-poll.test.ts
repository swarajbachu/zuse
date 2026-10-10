import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	billingPollRequest,
	ingestPolledBillingEvents,
} from "../../src/cloud-billing-usage-source.ts";
import { BoxBillingUsageSourceModule } from "../../src/cloud-billing-usage-sources/box.ts";
import { E2bBillingUsageSourceModule } from "../../src/cloud-billing-usage-sources/e2b.ts";

import { serviceUnavailable } from "../../src/errors.ts";

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
	it("uses a timeout signal with Workers-compatible redirect protection", async () => {
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(init.redirect).toBe("manual");
			return new Response("{}");
		});
		vi.stubGlobal("fetch", fetch);
		await billingPollRequest("https://api.test", {
			authorization: "Bearer token",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each([
		301, 302, 303, 307, 308,
	])("rejects redirect %s without a second credentialed request", async (status) => {
		const fetch = vi.fn(
			async () =>
				new Response(null, {
					status,
					headers: { location: "https://other.test/usage" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(
			billingPollRequest("https://api.test", {
				authorization: "Bearer token",
			}),
		).rejects.toThrow("Billing API redirects are not allowed");
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			"https://api.test",
			expect.objectContaining({ redirect: "manual" }),
		);
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

it("settles later poll events after a failure and retries without duplicating usage", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const settled = new Set<string>();
	const attempts: string[] = [];
	let unavailable = true;
	const poll = () =>
		Effect.runPromise(
			ingestPolledBillingEvents({
				provider: "box",
				events: [null, "failing", "healthy"],
				normalize: (payload) =>
					typeof payload === "string" ? { id: payload } : null,
				ingest: (event) =>
					Effect.gen(function* () {
						attempts.push(event.id);
						if (event.id === "failing" && unavailable)
							return yield* Effect.fail(
								serviceUnavailable("box_usage_unavailable"),
							);
						if (settled.has(event.id)) return { metered: false };
						settled.add(event.id);
						return { metered: true };
					}),
			}),
		);
	expect(await poll()).toBe(1);
	expect(attempts).toEqual(["failing", "healthy"]);
	expect([...settled]).toEqual(["healthy"]);
	expect(warn).toHaveBeenCalledWith(
		"[cloud-billing] polled execution settlement failed",
		{ provider: "box", eventId: "failing", code: "box_usage_unavailable" },
	);
	unavailable = false;
	expect(await poll()).toBe(1);
	expect(await poll()).toBe(0);
	expect([...settled]).toEqual(["healthy", "failing"]);
});

it("does not hide unexpected defects during settlement", async () => {
	await expect(
		Effect.runPromise(
			ingestPolledBillingEvents({
				provider: "box",
				events: ["event"],
				normalize: () => ({ id: "event" }),
				ingest: () => Effect.die(new Error("database defect")),
			}),
		),
	).rejects.toThrow("database defect");
});
