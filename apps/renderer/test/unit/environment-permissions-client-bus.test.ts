import { EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { decideEnvironmentPermission } from "../../src/lib/environment-permissions-client-bus.ts";
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
});
