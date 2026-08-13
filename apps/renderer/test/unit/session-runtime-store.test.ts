import { SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
	resetSessionRuntimeForTest,
	subscribeSessionTerminals,
	useSessionRuntimeStore,
} from "../../src/store/session-runtime.ts";

const sessionId = SessionId.make("session-runtime");

describe("session runtime summary fallback", () => {
	beforeEach(resetSessionRuntimeForTest);

	it("publishes changed summaries in one update", () => {
		let updates = 0;
		const unsubscribe = useSessionRuntimeStore.subscribe(() => {
			updates += 1;
		});
		const secondSessionId = SessionId.make("session-runtime-2");

		useSessionRuntimeStore.getState().observeSummaries([
			{ sessionId, status: "booting" },
			{ sessionId: secondSessionId, status: "idle" },
		]);
		expect(useSessionRuntimeStore.getState().bySession).toEqual({
			[sessionId]: "starting",
			[secondSessionId]: "idle",
		});
		expect(updates).toBe(1);

		useSessionRuntimeStore.getState().observeSummaries([
			{ sessionId, status: "booting" },
			{ sessionId: secondSessionId, status: "idle" },
		]);
		expect(updates).toBe(1);
		unsubscribe();
	});

	it("emits one completion after each durable running transition", () => {
		const outcomes: Array<"idle" | "failed"> = [];
		const unsubscribe = subscribeSessionTerminals((_id, outcome) => {
			outcomes.push(outcome);
		});
		const runtime = useSessionRuntimeStore.getState();

		runtime.observeSummary(sessionId, "idle");
		runtime.observeSummary(sessionId, "running");
		runtime.observeSummary(sessionId, "idle");
		runtime.observeSummary(sessionId, "idle");
		runtime.observeSummary(sessionId, "running");
		runtime.observeSummary(sessionId, "error");

		expect(outcomes).toEqual(["idle", "failed"]);
		unsubscribe();
	});

	it("removes fallback state without reporting completion", () => {
		const outcomes: string[] = [];
		const unsubscribe = subscribeSessionTerminals((_id, outcome) => {
			outcomes.push(outcome);
		});
		const runtime = useSessionRuntimeStore.getState();

		runtime.observeSummary(sessionId, "running");
		runtime.remove(sessionId);

		expect(
			useSessionRuntimeStore.getState().bySession[sessionId],
		).toBeUndefined();
		expect(outcomes).toEqual([]);
		unsubscribe();
	});
});
