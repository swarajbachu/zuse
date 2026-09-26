import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import { AgentItemId, EnvironmentId, SessionId } from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { EnvironmentQuestionAttachmentsData } from "../../src/lib/environment-question-attachments-client-bus.ts";
import "../../src/lib/environment-question-attachments-client-bus.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

describe("environment question attachments ClientBus adapter", () => {
	afterEach(() => {
		resetSessionTimelineClientBusForTest();
	});

	it("registers one retained environment stream and applies its snapshot", async () => {
		const environmentId = EnvironmentId.make("question-attachment-environment");
		const sessionId = SessionId.make("question-attachment-session");
		const itemId = AgentItemId.make("question-attachment-item");
		const changes = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.questionAttachments": () => {
						streamStarts += 1;
						return Stream.fromQueue(changes);
					},
				}) as never,
		);
		const key = makeResourceKey<EnvironmentQuestionAttachmentsData>(
			"environment-question-attachments",
			{ environmentId },
		);
		const bus = getRendererClientBus();
		const first = bus.retain(key, { activation: "connect" });
		const second = bus.retain(key, { activation: "connect" });
		await waitUntil(() => streamStarts === 1);

		Queue.offerUnsafe(changes, {
			_tag: "snapshot",
			attachments: [{ sessionId, itemId }],
		});
		await waitUntil(
			() =>
				Object.values(bus.snapshot(key).data?.attachmentsByKey ?? {}).length ===
				1,
		);

		expect(
			Object.values(bus.snapshot(key).data?.attachmentsByKey ?? {}),
		).toEqual([{ sessionId, itemId }]);
		expect(streamStarts).toBe(1);
		first.release();
		second.release();
	});
});
