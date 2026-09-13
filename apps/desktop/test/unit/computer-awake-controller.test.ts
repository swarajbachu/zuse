import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CAFFEINATE_RETRY_BASE_MS,
	CAFFEINATE_RETRY_MAX_MS,
	ComputerAwakeController,
} from "../../src/computer-awake-controller.ts";

const makeBlocker = () => {
	const active = new Set<number>();
	let nextId = 1;
	return {
		active,
		start: vi.fn(() => {
			const id = nextId++;
			active.add(id);
			return id;
		}),
		stop: vi.fn((id: number) => active.delete(id)),
		isStarted: vi.fn((id: number) => active.has(id)),
	};
};

class FakeCaffeinate extends EventEmitter {
	readonly kill = vi.fn(() => true);
}

const makeResumeSource = () => {
	const listeners = new Set<() => void>();
	return {
		on: vi.fn((_event: "resume", listener: () => void) =>
			listeners.add(listener),
		),
		off: vi.fn((_event: "resume", listener: () => void) =>
			listeners.delete(listener),
		),
		resume: () => {
			for (const listener of listeners) listener();
		},
	};
};

const makeHarness = (overrides: Record<string, unknown> = {}) => {
	const blocker = makeBlocker();
	const children: FakeCaffeinate[] = [];
	const spawn = vi.fn(() => {
		const child = new FakeCaffeinate();
		children.push(child);
		return child;
	});
	const powerMonitor = makeResumeSource();
	const controller = new ComputerAwakeController({
		blocker,
		platform: "darwin",
		powerMonitor,
		spawn,
		logger: { debug: vi.fn(), warn: vi.fn() },
		...overrides,
	});
	return { blocker, children, controller, powerMonitor, spawn };
};

describe("ComputerAwakeController", () => {
	afterEach(() => vi.useRealTimers());

	it("is idle in Auto until a local agent or remote client is active", () => {
		const { blocker, children, controller, spawn } = makeHarness();
		expect(controller.getStatus()).toMatchObject({
			mode: "auto",
			active: false,
		});

		controller.setActiveAgents(1);
		expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
		expect(spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-s"], {
			stdio: "ignore",
			windowsHide: true,
		});
		expect(controller.getStatus()).toMatchObject({
			active: true,
			activeAgents: 1,
			electronBlockerActive: true,
			caffeinateActive: true,
		});

		controller.setRemoteClients(1);
		controller.setRemoteClients(1);
		controller.setActiveAgents(1);
		expect(blocker.start).toHaveBeenCalledOnce();
		expect(spawn).toHaveBeenCalledOnce();
		controller.setActiveAgents(0);
		expect(children[0]?.kill).not.toHaveBeenCalled();
		controller.setRemoteClients(0);
		expect(children[0]?.kill).toHaveBeenCalledOnce();
		expect(blocker.stop).toHaveBeenCalledOnce();
		expect(controller.getStatus().active).toBe(false);
	});

	it("supports Always and releases immediately when switched Off", () => {
		const { blocker, children, controller } = makeHarness({
			initialMode: "always",
		});
		expect(controller.getStatus().active).toBe(true);

		controller.setMode("off");
		expect(blocker.stop).toHaveBeenCalledOnce();
		expect(children[0]?.kill).toHaveBeenCalledOnce();
		expect(controller.getStatus()).toMatchObject({
			mode: "off",
			active: false,
		});
	});

	it("does nothing on unsupported platforms", () => {
		const blocker = makeBlocker();
		const spawn = vi.fn();
		const controller = new ComputerAwakeController({
			blocker,
			platform: "linux",
			initialMode: "always",
			spawn,
		});

		expect(controller.getStatus()).toMatchObject({
			supported: false,
			active: false,
		});
		expect(blocker.start).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("reconciles a lost Electron assertion after resume", () => {
		const { blocker, powerMonitor } = makeHarness({
			initialMode: "always",
		});
		blocker.active.clear();

		powerMonitor.resume();

		expect(blocker.start).toHaveBeenCalledTimes(2);
	});

	it("keeps caffeinate active when the Electron assertion fails", () => {
		const blocker = makeBlocker();
		blocker.start.mockImplementation(() => {
			throw new Error("blocker failed");
		});
		const { controller, spawn } = makeHarness({
			blocker,
			initialMode: "always",
		});

		expect(spawn).toHaveBeenCalledOnce();
		expect(controller.getStatus()).toMatchObject({
			active: true,
			electronBlockerActive: false,
			caffeinateActive: true,
		});
		expect(controller.getStatus().warning).toContain("Electron");
	});

	it("keeps Electron active and retries an unexpected caffeinate failure", () => {
		vi.useFakeTimers();
		const { blocker, children, controller, spawn } = makeHarness({
			initialMode: "always",
		});
		children[0]?.emit("error", new Error("caffeinate failed"));

		expect(controller.getStatus()).toMatchObject({
			active: true,
			electronBlockerActive: true,
			caffeinateActive: false,
		});
		expect(controller.getStatus().warning).toContain("Closed-lid");
		vi.advanceTimersByTime(CAFFEINATE_RETRY_BASE_MS);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(blocker.start).toHaveBeenCalledOnce();
	});

	it("backs off repeated caffeinate failures up to a bounded delay", () => {
		vi.useFakeTimers();
		const { children, spawn } = makeHarness({ initialMode: "always" });
		const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

		for (const [index, delay] of delays.entries()) {
			children[index]?.emit("error", new Error(`failure ${index}`));
			vi.advanceTimersByTime(delay - 1);
			expect(spawn).toHaveBeenCalledTimes(index + 1);
			vi.advanceTimersByTime(1);
			expect(spawn).toHaveBeenCalledTimes(index + 2);
		}

		expect(delays.at(-1)).toBe(CAFFEINATE_RETRY_MAX_MS);
	});

	it("disposes listeners, assertions, and retry timers once", () => {
		vi.useFakeTimers();
		const { children, controller, powerMonitor, spawn } = makeHarness({
			initialMode: "always",
		});
		children[0]?.emit("exit", 1, null);

		controller.dispose();
		controller.dispose();
		vi.advanceTimersByTime(CAFFEINATE_RETRY_BASE_MS);

		expect(powerMonitor.off).toHaveBeenCalledOnce();
		expect(spawn).toHaveBeenCalledOnce();
	});
});
