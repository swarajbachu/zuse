import { describe, expect, it } from "vitest";
import chatsStoreSource from "../../src/store/chats.ts?raw";

describe("chat creation handoff", () => {
	it("does not gate an acknowledged chat on worktree hydration", () => {
		const acknowledged = chatsStoreSource.indexOf(
			'markRendererInteraction(initialSessionId, "entity-acknowledged")',
		);
		const authoritativeHandoff = chatsStoreSource.slice(acknowledged);
		const hydrateWorktree = authoritativeHandoff.indexOf(
			"void useWorktreesStore.getState().refresh(projectId)",
		);
		const clearPendingCreation = authoritativeHandoff.indexOf(
			"pendingCreationByChat: Object.fromEntries",
		);
		const restartTimeline = authoritativeHandoff.indexOf(
			"restartSessionTimeline({ environmentId, sessionId: initialSession.id })",
		);

		expect(acknowledged).toBeGreaterThan(-1);
		expect(hydrateWorktree).toBeGreaterThan(-1);
		expect(clearPendingCreation).toBeGreaterThan(hydrateWorktree);
		expect(authoritativeHandoff.slice(0, clearPendingCreation)).not.toContain(
			"await useWorktreesStore.getState().refresh(projectId)",
		);
		expect(restartTimeline).toBeGreaterThan(clearPendingCreation);
	});
});
