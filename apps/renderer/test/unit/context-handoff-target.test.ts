import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId, SessionId } from "@zuse/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
	attachFileWhenReady,
	sendThroughCurrentComposer,
} from "../../src/lib/context-handoff.ts";
import { useComposerBridge } from "../../src/store/composer-bridge.ts";

afterEach(() => {
	useComposerBridge.getState().setAttachFile(null);
	useComposerBridge.getState().setSendText(null);
	vi.useRealTimers();
});
test("never attaches delayed PR context to a different mounted session", () => {
	vi.useFakeTimers();
	const target = {
		environmentId: EnvironmentId.make("local"),
		sessionId: SessionId.make("original"),
	};
	const other = vi.fn();
	const original = vi.fn();
	useComposerBridge
		.getState()
		.setAttachFile(
			other,
			resourceRefKey({ ...target, sessionId: SessionId.make("other") }),
		);
	attachFileWhenReady(
		{ relPath: ".context/pr.md", absPath: "/repo/.context/pr.md" },
		2,
		50,
		target,
	);
	expect(other).not.toHaveBeenCalled();
	useComposerBridge.getState().setAttachFile(original, resourceRefKey(target));
	vi.advanceTimersByTime(50);
	expect(original).toHaveBeenCalledOnce();
	expect(other).not.toHaveBeenCalled();
});

test("sends generated UI responses only through the source session's composer", () => {
	const target = {
		environmentId: EnvironmentId.make("local"),
		sessionId: SessionId.make("source"),
	};
	const send = vi.fn(() => true);
	useComposerBridge.getState().setSendText(send);
	useComposerBridge
		.getState()
		.setAttachFile(
			vi.fn(),
			resourceRefKey({ ...target, sessionId: SessionId.make("other") }),
		);
	expect(sendThroughCurrentComposer("Run the tests", target)).toBe(false);
	expect(send).not.toHaveBeenCalled();

	useComposerBridge.getState().setAttachFile(vi.fn(), resourceRefKey(target));
	expect(sendThroughCurrentComposer("Run the tests", target)).toBe(true);
	expect(send).toHaveBeenCalledExactlyOnceWith("Run the tests");

	useComposerBridge.getState().setSendText(null);
	expect(sendThroughCurrentComposer("Run the tests", target)).toBe(false);
});
