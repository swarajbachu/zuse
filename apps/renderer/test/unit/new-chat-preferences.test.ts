import { beforeEach, describe, expect, it } from "vitest";
import { newChatPreferences } from "../../src/lib/new-chat-preferences.ts";

const values = new Map<string, string>();
const localStorage = {
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => values.set(key, value),
};

Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { localStorage },
});

describe("new chat preferences", () => {
	beforeEach(() => values.clear());

	it("defaults every project to a worktree", () => {
		expect(newChatPreferences.workspaceFor("project-a")).toBe("worktree");
	});

	it("remembers workspace and computer choices independently per project", () => {
		newChatPreferences.rememberWorkspace("project-a", "local");
		newChatPreferences.rememberEnvironment("project-a", "computer-a");
		newChatPreferences.rememberWorkspace("project-b", "worktree");
		newChatPreferences.rememberEnvironment("project-b", "cloud:provider-b");

		expect(newChatPreferences.workspaceFor("project-a")).toBe("local");
		expect(newChatPreferences.environmentFor("project-a")).toBe("computer-a");
		expect(newChatPreferences.workspaceFor("project-b")).toBe("worktree");
		expect(newChatPreferences.environmentFor("project-b")).toBe(
			"cloud:provider-b",
		);
		expect(newChatPreferences.lastProjectKey()).toBe("project-b");
	});

	it("ignores malformed stored values", () => {
		values.set(
			"zuse.newChatPreferences.v1",
			JSON.stringify({
				lastProjectKey: 42,
				environmentByProject: { project: 1 },
				workspaceByProject: { project: "invalid" },
			}),
		);

		expect(newChatPreferences.lastProjectKey()).toBeNull();
		expect(newChatPreferences.environmentFor("project")).toBeNull();
		expect(newChatPreferences.workspaceFor("project")).toBe("worktree");
	});
});
