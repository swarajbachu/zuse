import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";
import { routeUsageProfileRequest } from "../../src/usage-profile-routes.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const input = {
	handle: "sample-dev",
	displayName: "Sample Developer",
	github: "sample-dev",
	year: 2026,
	generatedAt: "2026-01-03T12:00:00.000Z",
	sessionCount: 3,
	days: [
		{ date: "2026-01-01", tokens: 20 },
		{ date: "2026-01-02", tokens: 10 },
	],
	models: [{ name: "Model A", tokens: 30 }],
	breakdown: {
		input: 10,
		output: 10,
		cacheRead: 5,
		cacheWrite: 3,
		reasoning: 2,
	},
	sources: [{ id: "claude", label: "Claude Code", tokens: 30 }],
	months: [{ month: 1, models: [{ name: "Model A", tokens: 30 }] }],
	projectCount: 2,
	sessionMinutes: { median: 5, longest: 40 },
	cost: null,
	hours: null,
};
describe("public usage profiles", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	const makeRuntime = () =>
		ManagedRuntime.make(Layer.mergeAll(ApiStoreMemory, WorkosVerifierTest));
	beforeEach(() => {
		runtime = makeRuntime();
	});
	afterEach(async () => {
		await runtime.dispose();
	});
	const call = (
		method = "GET",
		account: string | null = "alice",
		body?: unknown,
		path = "/v1/usage-profile",
		extraHeaders: Record<string, string> = {},
	) =>
		runtime.runPromise(
			routeUsageProfileRequest(
				new Request(`https://api.test${path}`, {
					method,
					headers: {
						...extraHeaders,
						...(account
							? { authorization: `Bearer test-token:${account}` }
							: {}),
						"content-type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			),
		);
	const publicGet = async () => {
		const response = await call(
			"GET",
			null,
			undefined,
			"/v1/public/usage-profiles/sample-dev",
		);
		if (response?.status === 404) {
			expect(response.headers.get("cache-control")).toBe("no-store");
			throw { code: "usage_profile_not_found" };
		}
		return response;
	};
	const errorCode = (task: Promise<unknown>) =>
		task.catch((error) => error.code ?? String(error));
	it("is private by default and requires authentication for management", async () => {
		expect(await (await call())?.json()).toEqual({
			profile: null,
			published: false,
		});
		expect(await errorCode(call("PUT", null, input))).toContain(
			"missing_bearer",
		);
		expect(await errorCode(publicGet())).toContain("usage_profile_not_found");
	});
	it("publishes opt-in cost and hours only when present", async () => {
		await call("PUT", "alice", input);
		expect(await (await publicGet())?.json()).toMatchObject({
			cost: null,
			hours: null,
		});
		const hours = Array.from({ length: 24 }, (_, hour) =>
			hour === 9 ? 30 : 0,
		);
		await call("PUT", "alice", {
			...input,
			cost: { usd: 12.5, complete: false },
			hours,
		});
		expect(await (await publicGet())?.json()).toMatchObject({
			cost: { usd: 12.5, complete: false },
			hours,
			sources: [{ id: "claude", label: "Claude Code", tokens: 30 }],
		});
	});
	it("publishes only the allowlisted aggregates without an account id or private data", async () => {
		await call("PUT", "alice", {
			...input,
			records: [{ prompt: "private" }],
			byProject: [{ label: "private-project" }],
			days: [{ ...input.days[0], tokens: 30, projectPath: "/private/path" }],
		});
		const response = await publicGet();
		const profile = await response?.json();
		expect(profile).toMatchObject({
			handle: input.handle,
			displayName: input.displayName,
			days: [{ date: "2026-01-01", tokens: 30 }],
		});
		expect(JSON.stringify(profile)).not.toMatch(
			/private|accountId|records|byProject/,
		);
		expect(response?.headers.get("cache-control")).toBe("no-store");
	});
	it("saves an If-Match refresh only while the profile is unchanged and published", async () => {
		await call("PUT", "alice", input);
		const revision = async () => {
			const response = await call();
			if (!response) throw new Error("profile route did not match");
			return (await response.json()).profile.updatedAt as number;
		};
		const refresh = (updatedAt: number | string, body = input) =>
			call("PUT", "alice", body, undefined, { "if-match": String(updatedAt) });

		const current = await revision();
		expect(
			await errorCode(refresh(current - 1, { ...input, displayName: "Stale" })),
		).toBe("usage_profile_changed");
		expect(await (await publicGet())?.json()).toMatchObject({
			displayName: input.displayName,
		});

		await refresh(current, { ...input, displayName: "Refreshed" });
		expect(await (await publicGet())?.json()).toMatchObject({
			displayName: "Refreshed",
		});

		const afterRefresh = await revision();
		await call("DELETE");
		expect(await errorCode(refresh(afterRefresh))).toBe(
			"usage_profile_changed",
		);
		expect(await errorCode(publicGet())).toBe("usage_profile_not_found");
		expect(await errorCode(refresh("not-a-revision"))).toBe(
			"invalid_usage_profile_revision",
		);
	});
	it("updates the same URL, unpublishes immediately, and keeps the handle reserved", async () => {
		await call("PUT", "alice", input);
		const first = await (await publicGet())?.json();
		await call("PUT", "alice", { ...input, displayName: "Updated name" });
		expect(await (await publicGet())?.json()).toMatchObject({
			displayName: "Updated name",
			publishedAt: first.publishedAt,
		});
		expect(await errorCode(call("DELETE", "bob"))).not.toContain("Error");
		expect(await (await publicGet())?.json()).toMatchObject({
			handle: input.handle,
		});
		expect(await (await call("DELETE"))?.json()).toMatchObject({
			published: false,
		});
		expect(await errorCode(publicGet())).toContain("usage_profile_not_found");
		expect(await errorCode(call("PUT", "bob", input))).toContain(
			"usage_profile_handle_unavailable",
		);
		await call("PUT", "alice", input);
		expect(await (await publicGet())?.json()).toMatchObject({
			handle: input.handle,
		});
	});
	it("allows only one account to claim a handle, including simultaneous claims", async () => {
		const results = await Promise.allSettled([
			call("PUT", "alice", input),
			call("PUT", "bob", input),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
	});
	it("keeps handles immutable and isolates account management state", async () => {
		await call("PUT", "alice", input);
		expect(await (await call("GET", "bob"))?.json()).toEqual({
			profile: null,
			published: false,
		});
		expect(
			await errorCode(
				call("PUT", "alice", { ...input, handle: "different-handle" }),
			),
		).toContain("usage_profile_handle_unavailable");
	});
	it.each([
		{ ...input, days: [{ date: "2026-02-30", tokens: 30 }] },
		{ ...input, days: [{ date: "2026-01-04", tokens: 30 }] },
		{ ...input, days: [{ date: "2025-01-01", tokens: 30 }] },
		{
			...input,
			days: [
				{ date: "2026-01-01", tokens: 15 },
				{ date: "2026-01-01", tokens: 15 },
			],
		},
		{ ...input, models: [{ name: "Model A", tokens: 31 }] },
		{ ...input, sessionCount: -1 },
		{ ...input, breakdown: { ...input.breakdown, input: 11 } },
		{ ...input, sources: [{ id: "claude", label: "Claude Code", tokens: 29 }] },
		{
			...input,
			sources: [
				{ id: "claude", label: "Claude Code", tokens: 15 },
				{ id: "claude", label: "Claude Code", tokens: 15 },
			],
		},
		{ ...input, sources: [{ id: "unknown-tool", label: "Tool", tokens: 30 }] },
		{
			...input,
			months: [{ month: 1, models: [{ name: "Model A", tokens: 29 }] }],
		},
		{
			...input,
			months: [{ month: 2, models: [{ name: "Model A", tokens: 30 }] }],
		},
		{ ...input, months: [] },
		{ ...input, sessionMinutes: { median: 41, longest: 40 } },
		{ ...input, hours: Array.from({ length: 23 }, () => 0) },
		{ ...input, hours: Array.from({ length: 24 }, () => 2) },
		{ ...input, cost: { usd: -1, complete: true } },
		{ ...input, models: [{ name: "Model A", tokens: 1.5 }] },
		{ ...input, github: "javascript:alert(1)" },
		{ ...input, displayName: " " },
		{ ...input, models: [{ name: " ", tokens: 30 }] },
		{
			...input,
			models: [
				{ name: "Model A", tokens: 15 },
				{ name: "Model A", tokens: 15 },
			],
		},
		{ ...input, generatedAt: "invalid" },
		{ ...input, generatedAt: "2099-01-03T12:00:00.000Z", year: 2099 },
	])("rejects invalid calendar, totals, identity or coverage %#", async (body) => {
		expect(await errorCode(call("PUT", "alice", body))).toMatch(
			/invalid_usage_profile|invalid_request/,
		);
	});
	it("bounds upload size", async () => {
		expect(
			await errorCode(
				call("PUT", "alice", { ...input, ignored: "x".repeat(70_000) }),
			),
		).toContain("invalid_request");
	});
	it("removes the profile with account deletion", async () => {
		await call("PUT", "alice", input);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* ApiStore).deleteAccountData("alice");
			}),
		);
		expect(await errorCode(publicGet())).toContain("usage_profile_not_found");
	});
});
