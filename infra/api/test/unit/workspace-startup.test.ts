import type { DurableObjectState } from "@cloudflare/workers-types";
import { describe, expect, test, vi } from "vitest";
import {
	scheduleWorkspaceStartup,
	type WorkspaceStartupOutcome,
	WorkspaceStartupTask,
} from "../../src/workspace-startup.ts";

const harness = (
	reconcile: (workspaceId: string) => Promise<WorkspaceStartupOutcome>,
	commit: () => Promise<void> = async () => {},
) => {
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const storage = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => {
			values.set(key, value);
		},
		delete: async (key: string) => values.delete(key),
		getAlarm: async () => alarm,
		setAlarm: async (value: number) => {
			alarm = value;
		},
		transaction: async <T>(run: (s: unknown) => Promise<T>) => {
			const result = await run(storage);
			await commit();
			return result;
		},
	};
	const state = { storage } as unknown as DurableObjectState;
	const task = new WorkspaceStartupTask(state, reconcile);
	return {
		task,
		state,
		values,
		alarm: () => alarm,
		fire: async (retryCount = 0) => {
			alarm = null;
			await task.alarm({ retryCount });
		},
		schedule: () =>
			scheduleWorkspaceStartup(
				{ idFromName: (x) => x, get: () => task },
				"workspace-test",
			),
	};
};

describe("durable workspace startup", () => {
	test("does not acknowledge scheduling before the pending request and alarm commit", async () => {
		let release!: () => void;
		let entered!: () => void;
		const committing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const committed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reconcile = vi.fn(async () => ({ kind: "complete" as const }));
		const h = harness(reconcile, async () => {
			entered();
			await committed;
		});
		let acknowledged = false;
		const scheduling = h.schedule().then(() => {
			acknowledged = true;
		});
		await committing;
		expect(acknowledged).toBe(false);
		expect(h.values.has("pending")).toBe(true);
		expect(h.alarm()).not.toBeNull();
		expect(reconcile).not.toHaveBeenCalled();
		release();
		await scheduling;
		expect(acknowledged).toBe(true);
	});
	test("rejects acknowledgement when the durable transaction cannot commit", async () => {
		const reconcile = vi.fn(async () => ({ kind: "complete" as const }));
		const h = harness(reconcile, async () => {
			throw new Error("storage commit failed");
		});
		await expect(h.schedule()).rejects.toThrow("storage commit failed");
		expect(reconcile).not.toHaveBeenCalled();
	});
	test("acknowledges durable scheduling without running startup in the HTTP request", async () => {
		const reconcile = vi.fn(async () => ({ kind: "complete" as const }));
		const h = harness(reconcile);
		await h.schedule();
		expect(h.alarm()).not.toBeNull();
		expect(reconcile).not.toHaveBeenCalled();
		// A new instance can recover the persisted request after eviction.
		await new WorkspaceStartupTask(h.state, reconcile).alarm();
		expect(reconcile).toHaveBeenCalledWith("workspace-test");
		expect(h.values.has("pending")).toBe(false);
	});
	test("retains failed work for alarm retry", async () => {
		const reconcile = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider unavailable"))
			.mockResolvedValue({ kind: "complete" });
		const h = harness(reconcile);
		await h.schedule();
		await expect(h.fire()).rejects.toThrow("provider unavailable");
		expect(h.values.has("pending")).toBe(true);
		await h.fire();
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(h.values.has("pending")).toBe(false);
	});
	test("renews exhausted retries and recovers after repeated outages and eviction", async () => {
		const reconcile = vi.fn().mockRejectedValue(new Error("offline"));
		const h = harness(reconcile);
		await h.schedule();
		for (let cycle = 0; cycle < 2; cycle++) {
			for (let retry = 0; retry < 5; retry++)
				await expect(h.fire(retry)).rejects.toThrow("offline");
			const before = Date.now();
			await h.fire(5);
			expect(h.alarm()).toBeGreaterThanOrEqual(before + 30_000);
			expect(h.alarm()).toBeLessThanOrEqual(Date.now() + 30_000);
			expect(h.values.has("pending")).toBe(true);
		}
		reconcile.mockResolvedValue({ kind: "complete" });
		await new WorkspaceStartupTask(h.state, reconcile).alarm();
		expect(h.values.has("pending")).toBe(false);
	});
	test("keeps a newer wake's alarm when the last automatic retry fails", async () => {
		let fail!: (error: Error) => void;
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness(async () => {
			started();
			await new Promise<void>((_resolve, reject) => {
				fail = reject;
			});
			return { kind: "complete" };
		});
		await h.schedule();
		const firing = h.fire(5);
		await start;
		await h.schedule();
		const alarm = h.alarm();
		const pending = h.values.get("pending");
		fail(new Error("offline"));
		await firing;
		expect(h.alarm()).toBe(alarm);
		expect(h.values.get("pending")).toBe(pending);
	});
	test("does not erase a wake requested while reconciliation is running", async () => {
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		let resolveFinish!: () => void;
		const finish = new Promise<void>((resolve) => {
			resolveFinish = resolve;
		});
		const h = harness(async () => {
			resolveStarted();
			await finish;
			return { kind: "complete" };
		});
		await h.schedule();
		const running = h.fire();
		await started;
		await h.schedule();
		resolveFinish();
		await running;
		expect(h.values.has("pending")).toBe(true);
		expect(h.alarm()).not.toBeNull();
		await h.fire();
		expect(h.values.has("pending")).toBe(false);
	});
	test("retains an active operation beyond an observation window and follows its next due time after eviction", async () => {
		const due = Date.now() + 120_000;
		const reconcile = vi
			.fn()
			.mockResolvedValueOnce({ kind: "due", dueAtMs: due })
			.mockResolvedValueOnce({ kind: "due", dueAtMs: due + 30_000 })
			.mockResolvedValue({ kind: "complete" });
		const h = harness(reconcile);
		await h.schedule();
		await h.fire();
		expect(h.values.has("pending")).toBe(true);
		expect(h.alarm()).toBe(due);
		await new WorkspaceStartupTask(h.state, reconcile).alarm();
		expect(h.values.has("pending")).toBe(true);
		await h.fire();
		expect(h.values.has("pending")).toBe(false);
	});

	test("new demand brings a future continuation forward immediately", async () => {
		const h = harness(async () => ({
			kind: "due",
			dueAtMs: Date.now() + 120_000,
		}));
		await h.schedule();
		await h.fire();
		expect(h.alarm()).toBeGreaterThan(Date.now() + 100_000);
		await h.schedule();
		expect(h.alarm()).toBeLessThanOrEqual(Date.now());
	});

	test("event-blocked work retains its pointer without polling and its named wake resumes it", async () => {
		const reconcile = vi
			.fn()
			.mockResolvedValueOnce({
				kind: "blocked",
				prerequisite: "account-login",
				wakeSource: "workspace-request",
			})
			.mockResolvedValue({ kind: "complete" });
		const h = harness(reconcile);
		await h.schedule();
		await h.fire();
		expect(h.values.has("pending")).toBe(true);
		expect(h.alarm()).toBeNull();
		await h.schedule();
		expect(h.alarm()).not.toBeNull();
		await h.fire();
		expect(h.values.has("pending")).toBe(false);
	});

	test("rejects scheduling failures instead of silently losing startup", async () => {
		await expect(
			scheduleWorkspaceStartup(
				{
					idFromName: (x) => x,
					get: () => ({
						fetch: async () => new Response(null, { status: 503 }),
					}),
				},
				"workspace-test",
			),
		).rejects.toThrow("workspace startup scheduling failed");
	});
});
