import { describe, expect, it } from "vitest";
import chatsStoreSource from "../../src/store/chats.ts?raw";

describe("chat creation handoff", () => {
	it("hydrates a created worktree before removing the pending workspace card", () => {
		const acknowledged = chatsStoreSource.indexOf(
			'markRendererInteraction(initialSessionId, "entity-acknowledged")',
		);
		const authoritativeHandoff = chatsStoreSource.slice(acknowledged);
		const hydrateWorktree = authoritativeHandoff.indexOf(
			"await useWorktreesStore.getState().refresh(projectId)",
		);
		const clearPendingCreation = authoritativeHandoff.indexOf(
			"pendingCreationByChat: Object.fromEntries",
		);

		expect(acknowledged).toBeGreaterThan(-1);
		expect(hydrateWorktree).toBeGreaterThan(-1);
		expect(clearPendingCreation).toBeGreaterThan(hydrateWorktree);
	});
});
