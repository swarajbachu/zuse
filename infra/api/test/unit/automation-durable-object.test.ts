import { describe, expect, it, vi } from "vitest";
import { AutomationDurableObjectCore } from "../../src/automation-durable-object.ts";
import { testCipher } from "../slack/test-support.ts";
import { automationObjectFixture } from "../support/automation-object.ts";

const now = Date.parse("2026-10-17T12:00:00Z");
const definition = {
	id: "rule",
	revision: 1,
	enabled: true,
	triggers: [{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC" }],
	nextRunAt: new Date(now).toISOString(),
};
const register = (
	f: ReturnType<typeof automationObjectFixture>,
	defs: unknown[] = [definition],
) => f.request("register", { workspaceId: "workspace", definitions: defs });
const pending = async (f: ReturnType<typeof automationObjectFixture>) =>
	(await (await f.request("pending", { workspaceId: "workspace" })).json()) as {
		events: { id: string; eventId: string }[];
	};

describe("automation Durable Object", () => {
	it("persists earliest alarm and deduplicates scheduled occurrences across eviction and registration retries", async () => {
		const f = automationObjectFixture(now);
		await register(f);
		expect(f.alarm).toBe(now + 1);
		await f.core.alarm();
		expect((await pending(f)).events.map((e) => e.eventId)).toEqual([
			new Date(now).toISOString(),
		]);
		expect(f.wake).toHaveBeenCalledWith("workspace", "account-a");
		await register(f);
		const restarted = new AutomationDurableObjectCore(f.state, {
			cipher: testCipher,
			wake: f.wake,
			now: () => now,
		});
		await restarted.alarm();
		expect((await pending(f)).events).toHaveLength(1);
		const [event] = (await pending(f)).events;
		await f.request("ack", { workspaceId: "workspace", id: event?.id });
		expect(f.alarm).toBe(now + 60 * 60_000);
		await restarted.alarm();
		expect((await pending(f)).events).toHaveLength(0);
	});
	it("does no recurring work for idle objects and schedules TTL cleanup after acknowledged deliveries", async () => {
		const f = automationObjectFixture(now);
		await register(f, [
			{ ...definition, triggers: [{ _tag: "webhook" }], nextRunAt: null },
		]);
		expect(f.alarm).toBeNull();
		await f.core.alarm();
		expect(f.wake).not.toHaveBeenCalled();
		expect(f.alarm).toBeNull();
		await f.request("dispatch", {
			event: {
				source: "webhook",
				eventId: "one",
				prompt: "secret",
				context: {},
			},
			workspaceIds: ["workspace"],
		});
		const [event] = (await pending(f)).events;
		await f.request("ack", { workspaceId: "workspace", id: event?.id });
		expect(f.alarm).toBe(now + 7 * 24 * 60 * 60_000);
		f.setTime(now + 7 * 24 * 60 * 60_000);
		await f.core.alarm();
		expect(f.alarm).toBeNull();
	});
	it("retains pending delivery during transient wake failures and removes revoked workspaces", async () => {
		const f = automationObjectFixture(now);
		await register(f);
		f.wake.mockRejectedValueOnce(new Error("temporarily unavailable"));
		await f.core.alarm();
		expect((await pending(f)).events).toHaveLength(1);
		expect(f.alarm).toBe(now + 60_000);
		f.setTime(now + 60_000);
		f.wake.mockResolvedValueOnce(false);
		await f.core.alarm();
		expect((await pending(f)).events).toEqual([]);
		expect(f.alarm).toBeNull();
	});
	it("does not block ACKs while the resume callback is pending", async () => {
		const f = automationObjectFixture(now);
		await register(f);
		let resolve: (active: boolean) => void = () => {};
		const wake = new Promise<boolean>((r) => {
			resolve = r;
		});
		f.wake.mockReturnValueOnce(wake);
		const alarm = f.core.alarm();
		await vi.waitFor(() => expect(f.wake).toHaveBeenCalled());
		const [event] = (await pending(f)).events;
		await f.request("ack", { workspaceId: "workspace", id: event?.id });
		resolve(true);
		await alarm;
		expect((await pending(f)).events).toEqual([]);
	});
	it("preserves hook token and fences stale queued revisions and wrong owners", async () => {
		const f = automationObjectFixture(now);
		const defs = [
			{ ...definition, triggers: [{ _tag: "webhook" }], nextRunAt: null },
		];
		const first = await (await register(f, defs)).json();
		expect(await (await register(f, defs)).json()).toEqual(first);
		await f.request("dispatch", {
			workspaceIds: ["workspace"],
			event: {
				source: "webhook",
				eventId: "delivery",
				prompt: "secret",
				context: {},
			},
		});
		await register(f, [{ ...defs[0], revision: 2 }]);
		expect((await pending(f)).events).toEqual([]);
		expect(
			(
				await f.request("pending", {
					accountId: "wrong",
					workspaceId: "workspace",
				})
			).status,
		).toBe(403);
		expect(JSON.stringify([...f.records.values()])).not.toContain(
			'"prompt":"secret"',
		);
	});
	it("imports once without overwriting newer object registrations", async () => {
		const f = automationObjectFixture(now);
		await register(f);
		expect(await (await f.request("initialized")).json()).toEqual({
			initialized: false,
		});
		const registration = [...f.records.values()].find(
			(v) => typeof v === "object" && v !== null && "automation_id" in v,
		);
		await f.request("import", {
			registrations: [registration],
			events: [],
			notifications: [],
		});
		await register(f, []);
		await f.request("import", {
			registrations: [registration],
			events: [],
			notifications: [],
		});
		expect(await (await f.request("initialized")).json()).toEqual({
			initialized: true,
		});
		expect(f.alarm).toBeNull();
	});
	it("backpressures new deliveries while preserving ACK and completion at capacity", async () => {
		const f = automationObjectFixture(now);
		await register(f, [
			{ ...definition, triggers: [{ _tag: "webhook" }], nextRunAt: null },
		]);
		const event = {
			source: "webhook",
			eventId: "accepted",
			prompt: "evidence",
			context: {},
		};
		await f.request("dispatch", { event, workspaceIds: ["workspace"] });
		const [accepted] = (await pending(f)).events;
		while (f.records.size < 1900) {
			const id = String(f.records.size);
			f.records.set(`n:filler:${id}`, {
				workspace_id: "workspace",
				automation_id: "rule",
				run_id: id,
				destination: "CONE",
				delivered_at: now,
			});
		}
		const rejected = await f.request("dispatch", {
			event: { ...event, eventId: "rejected" },
			workspaceIds: ["workspace"],
		});
		expect(rejected.status).toBe(503);
		expect(await rejected.json()).toMatchObject({ retryable: true });
		expect((await pending(f)).events).toHaveLength(1);
		await f.request("ack", { workspaceId: "workspace", id: accepted?.id });
		await f.request("complete", { workspaceId: "workspace", id: accepted?.id });
		expect((await pending(f)).events).toEqual([]);
		expect(
			(
				await f.request("notification-delivered", {
					workspaceId: "workspace",
					automationId: "rule",
					runId: "final",
					destination: "CONE",
				})
			).status,
		).toBe(200);
	});
	it("preserves a due cursor at capacity and resumes after retained receipts expire", async () => {
		const f = automationObjectFixture(now);
		await register(f);
		while (f.records.size < 1900) {
			const id = String(f.records.size);
			f.records.set(`n:filler:${id}`, {
				workspace_id: "workspace",
				automation_id: "rule",
				run_id: id,
				destination: "CONE",
				delivered_at: now - 7 * 24 * 60 * 60_000 + 60_000,
			});
		}
		await f.core.alarm();
		expect((await pending(f)).events).toEqual([]);
		expect(f.alarm).toBe(now + 60_000);
		f.setTime(now + 60_000);
		await f.core.alarm();
		expect((await pending(f)).events.map((e) => e.eventId)).toEqual([
			new Date(now).toISOString(),
		]);
	});
	it("applies the byte limit before the record limit for large encrypted events", async () => {
		const f = automationObjectFixture(now);
		await register(f, [
			{ ...definition, triggers: [{ _tag: "webhook" }], nextRunAt: null },
		]);
		for (let i = 0; i < 60; i++)
			f.records.set(`e:retained-${i}`, {
				id: `retained-${i}`,
				workspace_id: "workspace",
				automation_id: "rule",
				revision: 1,
				event_id: `retained-${i}`,
				source: "webhook",
				sealed: "x".repeat(104000),
				created_at: now,
				expires_at: now + 7 * 24 * 60 * 60_000,
				acknowledged_at: now,
			});
		const response = await f.request("dispatch", {
			workspaceIds: ["workspace"],
			event: {
				source: "webhook",
				eventId: "large",
				prompt: "x".repeat(60000),
				context: {},
			},
		});
		expect(response.status).toBe(503);
		expect((await pending(f)).events).toEqual([]);
		expect(f.records.size).toBe(62);
	});
});
