import type { DurableObjectState } from "@cloudflare/workers-types";
import { describe, expect, test, vi } from "vitest";
import {
	scheduleWorkspaceStartup,
	WorkspaceStartupTask,
} from "../../src/workspace-startup.ts";

const harness = (reconcile: (workspaceId: string) => Promise<void>) => {
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
		transaction: async <T>(run: (s: unknown) => Promise<T>) => run(storage),
	};
	const state = { storage } as unknown as DurableObjectState;
	const task = new WorkspaceStartupTask(state, reconcile);
	return {
		task,
		state,
		values,
		alarm: () => alarm,
		fire: async () => {
			alarm = null;
			await task.alarm();
		},
		schedule: () =>
			scheduleWorkspaceStartup(
				{ idFromName: (x) => x, get: () => task },
				"workspace-test",
			),
	};
};

describe("durable workspace startup", () => {
	test("acknowledges durable scheduling without running startup in the HTTP request", async () => {
		const reconcile = vi.fn(async () => {});
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
			.mockResolvedValue(undefined);
		const h = harness(reconcile);
		await h.schedule();
		await expect(h.fire()).rejects.toThrow("provider unavailable");
		expect(h.values.has("pending")).toBe(true);
		await h.fire();
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(h.values.has("pending")).toBe(false);
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
