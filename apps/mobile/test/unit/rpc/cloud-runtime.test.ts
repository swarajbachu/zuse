import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { summary, workspace } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	resume: vi.fn(),
	connect: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClient: {
		"cloud.workspaces.get": (input: unknown) =>
			Effect.tryPromise({ try: () => api.get(input), catch: (cause) => cause }),
		"cloud.workspaces.resume": (input: unknown) =>
			Effect.tryPromise({
				try: () => api.resume(input),
				catch: (cause) => cause,
			}),
		"cloud.workspaces.connect": (input: unknown) =>
			Effect.tryPromise({
				try: () => api.connect(input),
				catch: (cause) => cause,
			}),
	},
}));

import {
	connectCloudRuntime,
	requestCloudRuntimeWake,
	resetCloudRuntime,
} from "../../../src/rpc/cloud-runtime";
import {
	registerCloudSummary,
	setCloudCatalogAccount,
} from "../../../src/store/cloud-catalog";

describe("mobile direct cloud gateway lifecycle", () => {
	beforeEach(() => {
		resetCloudRuntime();
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-1");
		registerCloudSummary(summary());
		api.get.mockReset().mockResolvedValue(workspace());
		api.resume.mockReset().mockResolvedValue(
			workspace({
				revision: 2,
				state: "ready",
				desiredState: "ready",
				runtimeState: "online",
			}),
		);
		api.connect.mockReset().mockResolvedValue({
			workspaceId: "workspace-1",
			credential: "fresh-ticket",
		});
	});
	test("passive discovery never wakes sleeping compute", async () => {
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow(
			"sleeping",
		);
		expect(api.resume).not.toHaveBeenCalled();
		expect(api.connect).not.toHaveBeenCalled();
	});
	test("explicit wake is single-flight and mints a new ticket on reconnect", async () => {
		requestCloudRuntimeWake("workspace-1");
		await Promise.all([
			connectCloudRuntime("workspace-1"),
			connectCloudRuntime("workspace-1"),
		]);
		expect(api.resume).toHaveBeenCalledTimes(1);
		expect(api.connect).toHaveBeenCalledTimes(1);
		api.get.mockResolvedValue(
			workspace({
				state: "ready",
				runtimeState: "online",
				desiredState: "ready",
			}),
		);
		await connectCloudRuntime("workspace-1");
		expect(api.connect).toHaveBeenCalledTimes(2);
	});
	test("storage loss never requests recovery or replacement", async () => {
		requestCloudRuntimeWake("workspace-1");
		api.get.mockResolvedValue(
			workspace({ state: "failed", statusCode: "runtime-storage-replaced" }),
		);
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow();
		expect(api.resume).not.toHaveBeenCalled();
	});
	test("reuses the explicit wake command after a lost response", async () => {
		requestCloudRuntimeWake("workspace-1");
		api.resume.mockRejectedValueOnce(new Error("lost response"));
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow();
		await connectCloudRuntime("workspace-1");
		expect(api.resume.mock.calls[0]?.[0]).toEqual(
			api.resume.mock.calls[1]?.[0],
		);
		expect(api.resume.mock.calls[0]?.[0]).not.toHaveProperty("recoverRuntime");
	});
	test("repeated attachment failures never request runtime recovery", async () => {
		api.get.mockResolvedValue(
			workspace({
				desiredState: "ready",
				state: "ready",
				runtimeState: "online",
			}),
		);
		api.connect.mockRejectedValue(new Error("gateway unavailable"));
		for (let attempt = 0; attempt < 8; attempt++) {
			await expect(connectCloudRuntime("workspace-1")).rejects.toThrow(
				"gateway unavailable",
			);
		}
		expect(api.resume).not.toHaveBeenCalled();
		expect(api.connect).toHaveBeenCalledTimes(8);
	});
	test("a failed ticket after wake cannot wake sleeping compute again", async () => {
		requestCloudRuntimeWake("workspace-1");
		api.connect.mockRejectedValue(new Error("gateway unavailable"));
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow(
			"gateway unavailable",
		);
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow(
			"sleeping",
		);
		expect(api.resume).toHaveBeenCalledTimes(1);
	});
	test("passive attachment preserves lifecycle failure without resuming", async () => {
		api.get.mockResolvedValue(
			workspace({
				desiredState: "ready",
				state: "failed",
				statusCode: "runtime-connection-timeout",
				runtimeState: "offline",
			}),
		);
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow();
		expect(api.resume).not.toHaveBeenCalled();
		expect(api.connect).not.toHaveBeenCalled();
	});
	test("revoking an account fences a ticket request already in flight", async () => {
		let finish!: (value: unknown) => void;
		api.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const request = connectCloudRuntime("workspace-1");
		const rejected = expect(request).rejects.toThrow("account changed");
		await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
		resetCloudRuntime();
		setCloudCatalogAccount("account-2");
		finish(workspace());
		await rejected;
		expect(api.resume).not.toHaveBeenCalled();
		expect(api.connect).not.toHaveBeenCalled();
	});
	test("acknowledges shared compute intent before gateway ticket failure", async () => {
		const acknowledge = vi.fn();
		requestCloudRuntimeWake("workspace-1", {
			commandId: "shared-wake",
			acknowledge,
		});
		api.connect.mockRejectedValue(new Error("ticket unavailable"));
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow(
			"ticket unavailable",
		);
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(api.resume).toHaveBeenCalledExactlyOnceWith({
			workspaceId: "workspace-1",
			commandId: "shared-wake",
		});
	});
	test("joins a shared wake intent to an in-flight explicit wake", async () => {
		const acknowledged = vi.fn();
		let finish!: (value: unknown) => void;
		api.resume.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		requestCloudRuntimeWake("workspace-1");
		const connecting = connectCloudRuntime("workspace-1");
		await vi.waitFor(() => expect(api.resume).toHaveBeenCalledOnce());
		requestCloudRuntimeWake("workspace-1", {
			commandId: "joined-intent",
			acknowledge: acknowledged,
		});
		finish(
			workspace({
				state: "ready",
				desiredState: "ready",
				runtimeState: "online",
			}),
		);
		await connecting;
		expect(acknowledged).toHaveBeenCalledOnce();
		expect(api.resume).toHaveBeenCalledOnce();
	});
	test("explicit demand cancels an idle pause before the runtime goes offline", async () => {
		api.get.mockResolvedValue(
			workspace({
				state: "ready",
				desiredState: "paused",
				runtimeState: "online",
			}),
		);
		requestCloudRuntimeWake("workspace-1");
		await connectCloudRuntime("workspace-1");
		expect(api.resume).toHaveBeenCalledOnce();
	});
});
