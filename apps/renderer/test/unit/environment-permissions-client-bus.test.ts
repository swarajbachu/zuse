import { EnvironmentId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	decideEnvironmentPermission,
	denyEnvironmentPermissionAndInterrupt,
} from "../../src/lib/environment-permissions-client-bus.ts";
import {
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
			"permission-cloud",
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
});
