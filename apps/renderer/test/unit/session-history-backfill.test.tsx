import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { OptionalRendererSessionTimeline } from "../../src/lib/session-timeline-hooks.ts";

const state = vi.hoisted(() => ({ status: "idle" }));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	useCloudHistoryStatus: () => state.status,
	requestSessionHistoryPage: vi.fn(),
	retryCloudHistory: vi.fn(),
}));

import { SessionHistoryBackfill } from "../../src/components/session-history-backfill.tsx";

const timeline = (before: number | null) =>
	({
		ref: { environmentId: "environment", sessionId: "session" },
		projection: { olderMessageSequence: before },
		view: { sync: "live", connection: "connected" },
	}) as unknown as OptionalRendererSessionTimeline;

test("marks whole-history panes incomplete until older pages finish", () => {
	state.status = "idle";
	expect(
		renderToStaticMarkup(<SessionHistoryBackfill timeline={timeline(100)} />),
	).toContain("Loading earlier messages");
	expect(
		renderToStaticMarkup(<SessionHistoryBackfill timeline={timeline(null)} />),
	).toBe("");
});

test("offers retry after a whole-history pane's page read fails", () => {
	state.status = "failed";
	const html = renderToStaticMarkup(
		<SessionHistoryBackfill timeline={timeline(100)} />,
	);
	expect(html).toContain("<button");
	expect(html).toContain("Retry");
});
