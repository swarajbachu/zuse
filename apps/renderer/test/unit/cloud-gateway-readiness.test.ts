import { EnvironmentId } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	client: false,
	phase: "connecting",
	listener: undefined as (() => void) | undefined,
	unsubscribe: vi.fn(),
}));
vi.mock("../../src/lib/session-timeline-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-client-bus.ts")
	>()),
	getRendererClientBus: () => ({
		client: () => (state.client ? {} : null),
		connection: () => ({ phase: state.phase, error: null }),
		subscribe: (_key: unknown, listener: () => void) => {
			state.listener = listener;
			return state.unsubscribe;
		},
	}),
}));

import {
	environmentShellResourceKey,
	waitForEnvironmentGateway,
} from "../../src/lib/environment-shell-client-bus.ts";

const environmentId = EnvironmentId.make("early-cloud-runtime");
const key = environmentShellResourceKey({ environmentId });
beforeEach(() => {
	state.client = false;
	state.phase = "connecting";
	state.listener = undefined;
	state.unsubscribe.mockClear();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("connection-first cloud gateway readiness", () => {
	it("does not open on a ticket or connecting frame; opens on the live runtime client", async () => {
		let opened = false;
		const ready = waitForEnvironmentGateway(environmentId, key).then(() => {
			opened = true;
		});
		state.listener?.();
		await Promise.resolve();
		expect(opened).toBe(false);
		state.client = true;
		state.phase = "connected";
		state.listener?.();
		await ready;
		expect(opened).toBe(true);
		expect(state.unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops waiting on authentication failure and cleans its listener", async () => {
		const ready = waitForEnvironmentGateway(environmentId, key);
		const failed = expect(ready).rejects.toThrow("gateway is not available");
		state.phase = "blocked-auth";
		state.listener?.();
		await failed;
		expect(state.unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases its observer when the runtime never becomes reachable", async () => {
		const ready = waitForEnvironmentGateway(environmentId, key, 100);
		const failed = expect(ready).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(100);
		await failed;
		expect(state.unsubscribe).toHaveBeenCalledOnce();
	});
});
