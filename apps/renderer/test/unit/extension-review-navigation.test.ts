// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configureReviewEditGuard } from "../../src/lib/review-edit-guard.ts";
import { useUiStore } from "../../src/store/ui.ts";

afterEach(() => {
	configureReviewEditGuard(false, null);
	vi.restoreAllMocks();
});
it.each([
	"open",
	"close",
] as const)("guards %s extension navigation while a review has unsaved edits", (action) => {
	useUiStore.setState({
		activeMainTab: "changes",
		extensionPanel: { extensionId: "test", panelId: "main" },
	});
	configureReviewEditGuard(true, null);
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	const navigate = () =>
		action === "open"
			? useUiStore
					.getState()
					.openExtensionPanel({ extensionId: "new", panelId: "main" })
			: useUiStore.getState().closeExtensionPanel();
	navigate();
	expect(useUiStore.getState().activeMainTab).toBe("changes");
	expect(useUiStore.getState().extensionPanel?.extensionId).toBe("test");
	confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
	navigate();
	expect(useUiStore.getState().activeMainTab).toBe(
		action === "open" ? "extension" : "chat",
	);
});
