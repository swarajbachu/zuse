import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId, PermissionRequest, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	decideEnvironmentPermission,
	denyEnvironmentPermissionAndInterrupt,
	type EnvironmentPermissionsData,
} from "../../src/lib/environment-permissions-client-bus.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

describe("environment permissions ClientBus adapter", () => {
	afterEach(() => {
		resetSessionTimelineClientBusForTest();
	});

	it("routes a cloud decision through the permission request environment", async () => {
		const cloudEnvironmentId = EnvironmentId.make(
			"cloud-permission-environment",
		);
		const resolvedEnvironments: EnvironmentId[] = [];
		let decisions = 0;
		setSessionTimelineRpcClientForTest(async (environmentId) => {
			resolvedEnvironments.push(environmentId);
			return {
				"permission.decide": () => {
					decisions += 1;
					return Effect.succeed(undefined);
				},
			} as never;
		});

		await decideEnvironmentPermission(
			{
				id: "permission-cloud",
				sessionId: SessionId.make("permission-cloud-session"),
			},
			{ _tag: "AllowOnce" },
			cloudEnvironmentId,
		);

		expect(resolvedEnvironments).toEqual([cloudEnvironmentId]);
		expect(decisions).toBe(1);
	});

	it("stops the same session after denying its permission request", async () => {
		const environmentId = EnvironmentId.make("denied-permission-environment");
		const sessionId = SessionId.make("denied-permission-session");
		const calls: string[] = [];
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"permission.decide": () => {
						calls.push("deny");
						return Effect.succeed(undefined);
					},
					"messages.interrupt": () => {
						calls.push("interrupt");
						return Effect.succeed(undefined);
					},
				}) as never,
		);

		await denyEnvironmentPermissionAndInterrupt(
			{ id: "permission-denied", sessionId },
			environmentId,
		);

		expect(calls).toEqual(["deny", "interrupt"]);
	});

	it("keeps a request visible until its authoritative removal arrives", async () => {
		const environmentId = EnvironmentId.make("permission-ack-environment");
		const request = PermissionRequest.make({
			id: "permission-ack",
			sessionId: SessionId.make("permission-session"),
			kind: { _tag: "Bash", command: "bun test" },
			requestedAt: new Date("2026-08-23T00:00:00.000Z"),
			forcePrompt: false,
		});
		const key = makeResourceKey<EnvironmentPermissionsData>(
			"environment-permissions",
			{ environmentId },
		);
		let releaseDecision!: () => void;
		const decisionGate = new Promise<void>((resolve) => {
			releaseDecision = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"permission.decide": () =>
						Effect.sync(markStarted).pipe(
							Effect.andThen(Effect.promise(() => decisionGate)),
						),
				}) as never,
		);
		const bus = getRendererClientBus();
		bus.snapshot(key);
		bus.overlay(key, {
			initialData: {
				requestsById: {},
				decisionsByProject: {},
				loadingDecisionsByProject: {},
			},
			update: (data) => ({
				...data,
				requestsById: { ...data.requestsById, [request.id]: request },
			}),
		});

		const deciding = decideEnvironmentPermission(
			request,
			{ _tag: "AllowOnce" },
			environmentId,
		);
		await started;
		expect(bus.snapshot(key)?.data?.requestsById[request.id]).toEqual(request);
		const timelineKey = makeResourceKey("session-timeline", {
			environmentId,
			sessionId: request.sessionId,
		});
		expect(bus.snapshot(timelineKey)?.pendingCommands[0]?.kind).toBe(
			"permission.decide",
		);
		expect(bus.snapshot(timelineKey)?.pendingCommands[0]?.targetId).toBe(
			request.id,
		);
		releaseDecision();
		await deciding;

		expect(bus.snapshot(key)?.data?.requestsById[request.id]).toEqual(request);
		expect(bus.snapshot(timelineKey)?.pendingCommands).toEqual([]);
	});
});
