import { AgentSessionId, ChatId, CloudWorkspace } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	mapRelayErrorCode,
	resolveMachineRelayUrl,
	streamCloudWorkspaceLifecycle,
} from "../../src/machine/machine-control-service.ts";

const workspace = (
	revision: number,
	state: CloudWorkspace["state"] = "setup",
) =>
	CloudWorkspace.make({
		workspaceId: "workspace-1",
		projectId: "project-1",
		buildId: "build-1",
		providerId: "e2b",
		branch: "zuse/realtime",
		baseRef: "main",
		state,
		desiredState: "ready",
		statusCode: state,
		startupPhase: state === "ready" ? "running" : "booting",
		startupTimings: {},
		runtimeState: state === "ready" ? "online" : "connecting",
		revision,
		chatId: ChatId.make("chat-1"),
		initialSessionId: AgentSessionId.make("session-1"),
		createdAt: 1,
		updatedAt: revision,
		lastActivityAt: revision,
	});

describe("machine control relay URL", () => {
	it("preserves actionable cloud conflicts instead of reporting a workspace race", () => {
		expect(
			mapRelayErrorCode(409, "cloud_credential_connection_required").code,
		).toBe("credential-required");
		expect(
			mapRelayErrorCode(409, "cloud_branch_in_use:workspace_123").code,
		).toBe("branch-in-use");
	});

	it("classifies rejected credentials as auth faults, not generic failures", () => {
		expect(mapRelayErrorCode(401, undefined).code).toBe("not-allowed");
		expect(mapRelayErrorCode(403, undefined).code).toBe("not-allowed");
		expect(mapRelayErrorCode(400, undefined).code).toBe("invalid-request");
	});

	it("preserves private-beta access failures", () => {
		expect(mapRelayErrorCode(403, "cloud_beta_access_required").code).toBe(
			"beta-access-required",
		);
		expect(mapRelayErrorCode(503, "cloud_beta_access_unavailable").code).toBe(
			"beta-access-unavailable",
		);
	});

	it("surfaces a managed tunnel that has not become ready", () => {
		expect(mapRelayErrorCode(503, "tunnel_unavailable").code).toBe(
			"tunnel-unavailable",
		);
	});

	it("defaults to production when packaged Electron has no runtime NODE_ENV", () => {
		expect(resolveMachineRelayUrl({ NODE_ENV: "development" })).toBe(
			"https://api.zuse.sh",
		);
	});

	it("uses an explicit Relay override for development and staging", () => {
		expect(resolveMachineRelayUrl({ NODE_ENV: "production" })).toBe(
			"https://api.zuse.sh",
		);
		expect(
			resolveMachineRelayUrl({
				NODE_ENV: "development",
				ZUSE_RELAY_URL: "https://relay.example/",
			}),
		).toBe("https://relay.example");
	});

	it("emits only revisions newer than the subscriber cursor", async () => {
		const responses = [workspace(2), workspace(2), workspace(1), workspace(3)];
		let index = 0;
		const values = await Effect.runPromise(
			streamCloudWorkspaceLifecycle(
				Effect.sync(() => responses[index++] ?? workspace(3)),
				1,
			).pipe(Stream.take(2), Stream.runCollect),
		);

		expect(Array.from(values, (value) => value.revision)).toEqual([2, 3]);
	});

	it("starts each subscription from the requested cursor", async () => {
		const lifecycle = streamCloudWorkspaceLifecycle(
			Effect.succeed(workspace(2)),
			1,
		).pipe(Stream.take(1), Stream.runCollect);

		expect(
			Array.from(await Effect.runPromise(lifecycle), (value) => value.revision),
		).toEqual([2]);
		expect(
			Array.from(await Effect.runPromise(lifecycle), (value) => value.revision),
		).toEqual([2]);
	});
});
