import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId, SessionId } from "@zuse/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { attachFileWhenReady } from "../../src/lib/context-handoff.ts";
import { useComposerBridge } from "../../src/store/composer-bridge.ts";

afterEach(() => {
	useComposerBridge.getState().setAttachFile(null);
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
