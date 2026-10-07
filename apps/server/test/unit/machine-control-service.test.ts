import {
	AgentSessionId,
	ApiPaths,
	ChatId,
	CloudWorkspace,
} from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	MachineControlError,
	MachineControlService,
	MachineControlServiceLive,
	mapApiErrorCode,
	resolveMachineApiUrl,
	streamCloudWorkspaceLifecycle,
} from "../../src/machine/machine-control-service.ts";
import { MachineRuntimeRole } from "../../src/machine/machine-runtime-role.ts";
import { RuntimeCloudControl } from "../../src/machine/runtime-cloud-control.ts";

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

describe("machine control api URL", () => {
	it("does not describe an undeployed organization endpoint as a deleted team", () => {
		expect(mapApiErrorCode(404, "not_found", ApiPaths.organizations).code).toBe(
			"provider-unavailable",
		);
		expect(
			mapApiErrorCode(
				404,
				"organization_resource_not_found",
				ApiPaths.organizationDetails,
			).code,
		).toBe("not-found");
	});
	it("preserves the organization creation cap", () => {
		expect(mapApiErrorCode(409, "organization_member_limit_reached").code).toBe(
			"organization-member-limit-reached",
		);
		expect(mapApiErrorCode(409, "organization_limit_reached").code).toBe(
			"organization-limit-reached",
		);
	});
	it("preserves actionable cloud conflicts instead of reporting a workspace race", () => {
		expect(
			mapApiErrorCode(409, "cloud_credential_connection_required").code,
		).toBe("credential-required");
		expect(mapApiErrorCode(409, "cloud_branch_in_use:workspace_123").code).toBe(
			"branch-in-use",
		);
		expect(mapApiErrorCode(409, "cloud_branch_in_use").code).toBe(
			"branch-in-use",
		);
		expect(mapApiErrorCode(409, "cloud_workspace_unavailable").code).toBe(
			"invalid-state",
		);
	});

	it("classifies rejected credentials as auth faults, not generic failures", () => {
		expect(mapApiErrorCode(401, undefined).code).toBe("not-allowed");
		expect(mapApiErrorCode(403, undefined).code).toBe("access-denied");
		expect(mapApiErrorCode(400, undefined).code).toBe("invalid-request");
	});

	it("retains billing holds and retryable rate limits", () => {
		expect(mapApiErrorCode(403, "cloud_billing_hold").code).toBe(
			"billing-hold",
		);
		expect(mapApiErrorCode(429, "rate_limited").code).toBe(
			"provider-unavailable",
		);
	});

	it("preserves private-beta access failures", () => {
		expect(mapApiErrorCode(403, "cloud_beta_access_required").code).toBe(
			"beta-access-required",
		);
		expect(mapApiErrorCode(503, "cloud_beta_access_unavailable").code).toBe(
			"beta-access-unavailable",
		);
	});

	it("surfaces a managed tunnel that has not become ready", () => {
		expect(mapApiErrorCode(503, "tunnel_unavailable").code).toBe(
			"tunnel-unavailable",
		);
	});

	it("defaults to production when packaged Electron has no runtime NODE_ENV", () => {
		expect(resolveMachineApiUrl({ NODE_ENV: "development" })).toBe(
			"https://api.zuse.sh",
		);
	});

	it("uses an explicit API override for development and staging", () => {
		expect(resolveMachineApiUrl({ NODE_ENV: "production" })).toBe(
			"https://api.zuse.sh",
		);
		expect(
			resolveMachineApiUrl({
				NODE_ENV: "development",
				ZUSE_API_URL: "https://api.example/",
			}),
		).toBe("https://api.example");
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

	it("recovers transient lifecycle outages without replaying already published revisions", async () => {
		let reads = 0;
		const values = await Effect.runPromise(
			streamCloudWorkspaceLifecycle(
				Effect.suspend(() => {
					reads++;
					if (reads === 2)
						return Effect.fail(new MachineControlError("provider-unavailable"));
					return Effect.succeed(workspace(reads < 4 ? 2 : 3));
				}),
				1,
			).pipe(Stream.take(2), Stream.runCollect),
		);
		expect(values.map((value) => value.revision)).toEqual([2, 3]);
		expect(reads).toBe(4);
	});

	it("ends a desktop subscription when membership is revoked", async () => {
		let reads = 0;
		const denied = new MachineControlError("not-allowed");
		const observed: number[] = [];
		const failure = await Effect.runPromise(
			streamCloudWorkspaceLifecycle(
				Effect.suspend(() => {
					reads++;
					return reads === 1
						? Effect.succeed(workspace(2))
						: Effect.fail(denied);
				}),
				1,
			).pipe(
				Stream.tap((value) => Effect.sync(() => observed.push(value.revision))),
				Stream.runDrain,
				Effect.flip,
			),
		);
		expect(observed).toEqual([2]);
		expect(failure).toBe(denied);
		expect(reads).toBe(2);
	});
});

describe("cloud runtime control transport", () => {
	it("uses the enrolled transport without accessing account credentials", async () => {
		const getAccessToken = vi.fn(() => Effect.succeed("must-not-be-used"));
		const request = vi.fn(async () => Response.json({ workspaces: [] }));
		const layer = MachineControlServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(MachineRuntimeRole, "cloud-environment"),
					Layer.succeed(RuntimeCloudControl, { current: { request } }),
					Layer.succeed(AuthService, {
						getAccessToken,
						getSession: () => Effect.succeed({ _tag: "SignedOut" }),
						signIn: () => Effect.succeed({ _tag: "SignedOut" }),
						signOut: () => Effect.void,
						sessionChanges: () => Stream.empty,
					}),
				),
			),
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* MachineControlService;
				return yield* service.cloudWorkspaces();
			}).pipe(Effect.provide(layer)),
		);
		expect(result.workspaces).toEqual([]);
		expect(request).toHaveBeenCalledWith(
			ApiPaths.cloudWorkspaces,
			"GET",
			undefined,
		);
		expect(getAccessToken).not.toHaveBeenCalled();
	});
});
