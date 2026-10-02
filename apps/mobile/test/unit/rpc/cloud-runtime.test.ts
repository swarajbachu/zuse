import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cloudControlClientForWorkspace } from "../../../src/rpc/api-client";
import { summary, workspace } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	resume: vi.fn(),
	connect: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.workspaces.get": (input: unknown) =>
			Effect.tryPromise(() => api.get(input)),
		"cloud.workspaces.resume": (input: unknown) =>
			Effect.tryPromise(() => api.resume(input)),
		"cloud.workspaces.connect": (input: unknown) =>
			Effect.tryPromise(() => api.connect(input)),
	})),
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
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";

describe("mobile direct cloud gateway lifecycle", () => {
	beforeEach(() => {
		vi.mocked(cloudControlClientForWorkspace).mockClear();
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
	test("connects using the chat's organization instead of Personal", async () => {
		const scope = { kind: "organization", organizationId: "org_a" } as const;
		registerCloudSummary({ ...summary(), workspaceScope: scope });
		requestCloudRuntimeWake("workspace-1");
		await connectCloudRuntime("workspace-1");
		expect(cloudControlClientForWorkspace).toHaveBeenCalledWith(scope);
		expect(api.connect).toHaveBeenCalledOnce();
	});
	test("refuses unknown workspace IDs without making a Personal request", async () => {
		await expect(connectCloudRuntime("unknown")).rejects.toThrow();
		expect(cloudControlClientForWorkspace).not.toHaveBeenCalled();
		expect(api.get).not.toHaveBeenCalled();
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
	test("returning to the same workspace cannot reuse a previous selection's ticket flight", async () => {
		const ready = workspace({
			state: "ready",
			desiredState: "ready",
			runtimeState: "online",
		});
		api.get.mockResolvedValue(ready);
		const oldTicket = Promise.withResolvers<unknown>();
		const newTicket = Promise.withResolvers<unknown>();
		api.connect
			.mockReturnValueOnce(oldTicket.promise)
			.mockReturnValueOnce(newTicket.promise);
		const old = connectCloudRuntime("workspace-1");
		const rejected = expect(old).rejects.toThrow("account changed");
		await vi.waitFor(() => expect(api.connect).toHaveBeenCalledTimes(1));
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		setCloudCatalogWorkspace({ kind: "personal" });
		registerCloudSummary(summary());
		const current = connectCloudRuntime("workspace-1");
		expect(current).not.toBe(old);
		await vi.waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2));
		oldTicket.resolve({ workspaceId: "workspace-1", credential: "obsolete" });
		await rejected;
		// Finishing the old flight must not remove the new flight's deduplication entry.
		expect(connectCloudRuntime("workspace-1")).toBe(current);
		newTicket.resolve({ workspaceId: "workspace-1", credential: "current" });
		await expect(current).resolves.toMatchObject({ credential: "current" });
	});
	test("a stale workspace lookup cannot resume a runtime after selection changes", async () => {
		const lookup = Promise.withResolvers<unknown>();
		api.get.mockReturnValueOnce(lookup.promise);
		requestCloudRuntimeWake("workspace-1");
		const request = connectCloudRuntime("workspace-1");
		const rejected = expect(request).rejects.toThrow("account changed");
		await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		setCloudCatalogWorkspace({ kind: "personal" });
		registerCloudSummary(summary());
		lookup.resolve(workspace());
		await rejected;
		expect(api.resume).not.toHaveBeenCalled();
		expect(api.connect).not.toHaveBeenCalled();
	});
});
