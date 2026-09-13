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
			Effect.tryPromise(() => api.get(input)),
		"cloud.workspaces.resume": (input: unknown) =>
			Effect.tryPromise(() => api.resume(input)),
		"cloud.workspaces.connect": (input: unknown) =>
			Effect.tryPromise(() => api.connect(input)),
	},
}));

import {
	connectCloudRuntime,
	markCloudGatewayHealthy,
	recordCloudGatewayClose,
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
	test("reuses the same recovery command after a lost response", async () => {
		api.get.mockResolvedValue(
			workspace({
				desiredState: "ready",
				state: "ready",
				runtimeState: "online",
			}),
		);
		recordCloudGatewayClose("workspace-1", 4100);
		api.resume.mockRejectedValueOnce(new Error("lost response"));
		await expect(connectCloudRuntime("workspace-1")).rejects.toThrow();
		await connectCloudRuntime("workspace-1");
		expect(api.resume.mock.calls[0]?.[0]).toEqual(
			api.resume.mock.calls[1]?.[0],
		);
		expect(api.resume.mock.calls[0]?.[0]).toMatchObject({
			recoverRuntime: true,
		});
	});
	test("one network flap after a healthy handshake does not restart the runtime", async () => {
		api.get.mockResolvedValue(
			workspace({
				desiredState: "ready",
				state: "ready",
				runtimeState: "online",
			}),
		);
		markCloudGatewayHealthy("workspace-1");
		recordCloudGatewayClose("workspace-1", 1006);
		await connectCloudRuntime("workspace-1");
		expect(api.resume).not.toHaveBeenCalled();
		recordCloudGatewayClose("workspace-1", 1006);
		await connectCloudRuntime("workspace-1");
		expect(api.resume).toHaveBeenCalledTimes(1);
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
});
