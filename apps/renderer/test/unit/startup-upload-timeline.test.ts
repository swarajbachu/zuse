import {
	EnvironmentId,
	SessionId,
	SessionNotFoundError,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadAttachmentBytes } from "../../src/lib/attachments.ts";
import { saveContextText } from "../../src/lib/context-handoff.ts";
import { getActiveEnvironment } from "../../src/lib/rpc-client.ts";
import { pendingSessionCommandError } from "../../src/lib/session-actions.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	retainSessionTimeline,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

beforeEach(() =>
	vi.stubGlobal("location", {
		protocol: "http:",
		host: "localhost",
		pathname: "/",
	}),
);
afterEach(() => {
	resetSessionTimelineClientBusForTest();
	vi.unstubAllGlobals();
});

// A new worktree chat writes its first message's files while the worktree is
// still being created; the server answers "not found" until it exists.
it("keeps startup workspace probes off a provisional chat's timeline", async () => {
	const environmentId = EnvironmentId.make(getActiveEnvironment());
	const sessionId = SessionId.make("startup-upload-provisional");
	const ref = { environmentId, sessionId };
	setSessionTimelineRpcClientForTest(
		async () =>
			({
				"session.events": () => Stream.never,
				"attachments.upload": () =>
					Effect.fail(new SessionNotFoundError({ sessionId })),
				"context.saveText": () =>
					Effect.fail(new SessionNotFoundError({ sessionId })),
			}) as never,
	);
	const retained = retainSessionTimeline(ref, "connect");

	await expect(
		uploadAttachmentBytes(ref, {
			bytes: new Uint8Array([1]),
			mimeType: "image/png",
			originalName: "image.png",
		}),
	).rejects.toBeInstanceOf(SessionNotFoundError);
	await expect(
		saveContextText({ environmentId, sessionId, text: "notes", ext: "md" }),
	).rejects.toBeInstanceOf(SessionNotFoundError);

	const view = getRendererClientBus().snapshot(retained.key);
	expect(view.failedCommands).toEqual([]);
	expect(view.pendingCommands).toEqual([]);
	expect(pendingSessionCommandError(ref)).toBeNull();
	retained.lease.release();
});
