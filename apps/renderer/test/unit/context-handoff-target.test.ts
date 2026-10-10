import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId, SessionId } from "@zuse/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
	attachFileWhenReady,
	insertIntoCurrentComposer,
} from "../../src/lib/context-handoff.ts";
import { useComposerBridge } from "../../src/store/composer-bridge.ts";

afterEach(() => {
	useComposerBridge.getState().setAttachFile(null);
	useComposerBridge.getState().setInsertText(null);
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

test("inserts generated follow-ups only into the source session's composer", () => {
	const target = {
		environmentId: EnvironmentId.make("local"),
		sessionId: SessionId.make("source"),
	};
	const insert = vi.fn();
	useComposerBridge.getState().setInsertText(insert);
	useComposerBridge
		.getState()
		.setAttachFile(
			vi.fn(),
			resourceRefKey({ ...target, sessionId: SessionId.make("other") }),
		);
	expect(insertIntoCurrentComposer("Run the tests", target)).toBe(false);
	expect(insert).not.toHaveBeenCalled();

	useComposerBridge.getState().setAttachFile(vi.fn(), resourceRefKey(target));
	expect(insertIntoCurrentComposer("Run the tests", target)).toBe(true);
	expect(insert).toHaveBeenCalledExactlyOnceWith("Run the tests");
});
