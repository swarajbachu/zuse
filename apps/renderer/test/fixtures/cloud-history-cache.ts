import { makeSessionTimelineCacheEntry } from "@zuse/client-runtime/session-timeline-cache";
import {
	EnvironmentId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	rememberCloudTimelineHead,
	sessionTimelineCache,
} from "../../src/lib/session-timeline-cache";

export const run = async () => {
	if (!sessionTimelineCache) throw new Error("IndexedDB unavailable");
	const assert = (condition: boolean, label: string) => {
		if (!condition) throw new Error(label);
	};
	const results = [];
	for (const count of [10, 1000, 10000]) {
		const sessionId = SessionId.make(`cache-${count}`);
		const ref = {
			environmentId: EnvironmentId.make(`cloud-${count}`),
			sessionId,
		};
		const cursor = { epoch: "one", version: 5 };
		const messages = Array.from({ length: count }, (_, i) =>
			Message.make({
				id: MessageId.make(`m-${i}`),
				sessionId,
				role: "assistant",
				content: { _tag: "assistant", text: "tool output ".repeat(100) },
				createdAt: new Date(i),
			}),
		);
		const projection = SessionTimelineProjection.make({
			messages,
			status: "idle",
			currentTurn: null,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});
		const entry = makeSessionTimelineCacheEntry({ ref, cursor, projection });
		await sessionTimelineCache.save(entry);
		const before = performance.now();
		const baseline = await sessionTimelineCache.load(ref);
		const fullLoadMs = performance.now() - before;
		assert(
			baseline?.projection.messages.length === count,
			"legacy complete cache remains readable",
		);
		const head = SessionTimelineProjection.make({
			...projection,
			messages: messages.slice(-100),
			olderMessageSequence: count > 100 ? count - 100 : null,
		});
		rememberCloudTimelineHead(ref, head, cursor);
		if (count > 100)
			await sessionTimelineCache.saveHistoryPage(ref, cursor, count - 100, {
				messages: messages.slice(0, 100),
				olderMessageSequence: null,
			});
		await sessionTimelineCache.save(entry);
		const after = performance.now();
		const cached = await sessionTimelineCache.load(ref);
		const headLoadMs = performance.now() - after;
		assert(
			cached?.projection.messages.length === Math.min(count, 100),
			"head remains bounded after full history merges",
		);
		assert(
			cached?.projection.olderMessageSequence === head.olderMessageSequence,
			"continuation retained",
		);
		if (count > 100) {
			assert(
				(await sessionTimelineCache.loadHistoryPage(ref, cursor, count - 100))
					?.messages.length === 100,
				"page matches authoritative checkpoint",
			);
			assert(
				(await sessionTimelineCache.loadHistoryPage(
					ref,
					{ ...cursor, version: 6 },
					count - 100,
				)) === null,
				"new checkpoint cannot reuse stale history",
			);
			assert(
				(await sessionTimelineCache.loadHistoryPage(
					ref,
					{ ...cursor, epoch: "restored" },
					count - 100,
				)) === null,
				"restored epoch cannot read stale history",
			);
		}
		await sessionTimelineCache.remove(ref);
		assert((await sessionTimelineCache.load(ref)) === null, "head removed");
		assert(
			(await sessionTimelineCache.loadHistoryPage(ref, cursor, count - 100)) ===
				null,
			"pages removed with resource",
		);
		results.push({ count, fullLoadMs, headLoadMs });
	}
	return results;
};
