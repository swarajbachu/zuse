import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import {
	CloudWorkspaceOpError,
	CommandId,
	EnvironmentId,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dataKey: vi.fn(),
	workspace: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: async () => ({
		"cloud.commands.dataKey": mocks.dataKey,
		"cloud.workspaces.get": mocks.workspace,
	}),
}));

import { cloudCommandTransport } from "../../src/lib/cloud-command-transport.ts";

const environmentId = EnvironmentId.make("workspace_test");
const sessionId = SessionId.make("session_test");
const command: ClientCommand = {
	kind: "messages.send",
	commandId: CommandId.make("command_test"),
	environmentId,
	resource: {
		kind: "session-timeline",
		ref: { environmentId, sessionId },
	},
	payload: { sessionId, input: { text: "hello" } },
	retry: "safe",
	createdAt: 1,
};

const missing = () =>
	Effect.fail(new CloudWorkspaceOpError({ code: "not-found" }));

const lifecycle = (state: "ready" | "archived" | "deleted") =>
	Effect.succeed({ state, desiredState: state === "ready" ? "ready" : state });

const dispatch = () => {
	const handle = cloudCommandTransport.dispatch({
		command,
		fingerprint: commandFingerprint(command),
	});
	void handle.result.catch(() => undefined);
	void handle.encryptedEnvelope?.catch(() => undefined);
	return handle;
};

describe("cloud command transport rollout compatibility", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.dataKey.mockReturnValue(missing());
	});

	it("falls back to live RPC when an older control plane lacks mailbox routes", async () => {
		mocks.workspace.mockReturnValue(lifecycle("ready"));

		await expect(dispatch().accepted).rejects.toBeInstanceOf(
			CloudCommandTransportUnavailableError,
		);
		expect(mocks.workspace).toHaveBeenCalledWith({
			workspaceId: environmentId,
		});
	});

	it.each([
		"archived",
		"deleted",
	] as const)("reports a confirmed %s lifecycle as terminal", async (state) => {
		mocks.workspace.mockReturnValue(lifecycle(state));

		await expect(dispatch().accepted).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			category: "workspace-deleted",
		});
	});

	it("reports a workspace as terminal only when the existing endpoint also cannot find it", async () => {
		mocks.workspace.mockReturnValue(missing());

		await expect(dispatch().accepted).rejects.toBeInstanceOf(
			CloudCommandTerminalError,
		);
	});
});
