import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accessRequests: 0,
	prepareRequests: 0,
	keyRequests: 0,
	keyFailure: null as unknown,
	keyRetry: null as string | null,
	clientReady: true,
	attachRequests: 0,
	accessFailure: null as unknown,
	recoveryRequests: 0,
}));

vi.mock("../../src/lib/bridge.ts", () => ({
	getAppBridge: () => ({
		cloudSshPrepare: async () => {
			mocks.prepareRequests += 1;
			return {
				hostAlias: "zuse-workspace_a",
				sshCommand: "ssh zuse-workspace_a",
				publicKey: "ssh-ed25519 public",
				remotePath: "/home/zuse/workspace",
			};
		},
		openSshTarget: async () => true,
	}),
}));

vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: async (
		operation: (client: unknown) => Effect.Effect<unknown>,
	) =>
		Effect.runPromise(
			operation({
				"cloud.workspaces.sshAccess": () =>
					Effect.promise(async () => {
						mocks.accessRequests += 1;
						if (mocks.accessFailure !== null) {
							const failure = mocks.accessFailure;
							mocks.accessFailure = null;
							throw failure;
						}
						await new Promise((resolve) => setTimeout(resolve, 10));
						return {
							workspaceId: "workspace_a",
							wsUrl: "wss://api.example/ssh",
							ticket: "ticket",
							expiresAt: Date.now() + 60_000,
							user: "zuse",
							workspacePath: "/home/zuse/workspace",
						};
					}),
			}),
		),
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	retainEnvironmentShell: () => ({
		key: "test-key",
		lease: { release: () => undefined },
	}),
	dispatchEnvironmentShellCommand: async (input: { retry?: string }) => {
		mocks.keyRequests += 1;
		mocks.keyRetry = input.retry ?? null;
		if (mocks.keyFailure !== null) throw mocks.keyFailure;
		return {};
	},
}));

vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => ({
		client: () => (mocks.clientReady ? {} : null),
		subscribe: () => () => {},
	}),
}));

vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForEnvironment: () => ({ workspaceId: "workspace_a" }),
}));

vi.mock("../../src/lib/cloud-workspaces.ts", () => ({
	ensureCloudWorkspaceAttached: async () => {
		mocks.attachRequests += 1;
		mocks.clientReady = true;
	},
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	requestCloudWorkspaceRuntimeRecovery: () => {
		mocks.recoveryRequests += 1;
	},
}));

import {
	cloudSshMissingSandboxFailure,
	prepareCloudWorkspaceSsh,
} from "../../src/lib/cloud-ssh-client-bus.ts";

describe("cloud SSH access", () => {
	beforeEach(() => {
		mocks.accessRequests = 0;
		mocks.prepareRequests = 0;
		mocks.keyRequests = 0;
		mocks.keyFailure = null;
		mocks.keyRetry = null;
		mocks.clientReady = true;
		mocks.attachRequests = 0;
		mocks.accessFailure = null;
		mocks.recoveryRequests = 0;
	});

	it("prepares access single-flight per workspace", async () => {
		const [first, second] = await Promise.all([
			prepareCloudWorkspaceSsh("workspace_a"),
			prepareCloudWorkspaceSsh("workspace_a"),
		]);
		expect(second).toEqual(first);
		expect(mocks.accessRequests).toBe(1);
		expect(mocks.prepareRequests).toBe(1);
		expect(mocks.keyRequests).toBe(1);
		expect(mocks.keyRetry).toBe("safe");
	});

	it("reattaches a disconnected workspace before preparing access", async () => {
		mocks.clientReady = false;

		await expect(
			prepareCloudWorkspaceSsh("workspace_a"),
		).resolves.toMatchObject({
			hostAlias: "zuse-workspace_a",
		});
		expect(mocks.attachRequests).toBe(1);
	});

	it("accepts the legacy response-encoding failure after key authorization", async () => {
		mocks.keyFailure =
			'Expected MachineSshKey, got {"fingerprint":"SHA256:test","publicKey":"ssh-ed25519 public"}';

		await expect(
			prepareCloudWorkspaceSsh("workspace_a"),
		).resolves.toMatchObject({
			hostAlias: "zuse-workspace_a",
		});
		expect(mocks.keyRequests).toBe(1);
	});

	it("identifies only missing-sandbox failures for lifecycle recovery", () => {
		expect(
			cloudSshMissingSandboxFailure(new Error("sandbox was not found")),
		).toBe(true);
		expect(cloudSshMissingSandboxFailure({ code: "not-found" })).toBe(true);
		expect(cloudSshMissingSandboxFailure(new Error("502 Bad Gateway"))).toBe(
			false,
		);
		expect(cloudSshMissingSandboxFailure(new Error("request timed out"))).toBe(
			false,
		);
	});

	it("reconciles an explicitly missing sandbox before retrying once", async () => {
		mocks.accessFailure = { code: "not-found" };

		await expect(
			prepareCloudWorkspaceSsh("workspace_a"),
		).resolves.toMatchObject({ hostAlias: "zuse-workspace_a" });
		expect(mocks.accessRequests).toBe(2);
		expect(mocks.recoveryRequests).toBe(1);
		expect(mocks.attachRequests).toBe(1);
	});
});
