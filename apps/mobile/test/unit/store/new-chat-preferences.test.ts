import { beforeEach, describe, expect, test, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
	value: null as string | null,
	writes: [] as Array<[string, string]>,
}));

vi.mock("expo-secure-store", () => ({
	getItemAsync: () => Promise.resolve(secureStore.value),
	setItemAsync: (key: string, value: string) => {
		secureStore.writes.push([key, value]);
		return Promise.resolve();
	},
}));

import {
	DEFAULT_NEW_CHAT_PREFERENCES,
	readNewChatPreferences,
	saveNewChatPreferences,
} from "../../../src/store/new-chat-preferences";

describe("new chat preferences", () => {
	beforeEach(() => {
		secureStore.value = null;
		secureStore.writes = [];
	});

	test("restores machine, repository, and work mode", async () => {
		secureStore.value = JSON.stringify({
			connectionKey: "machine-1",
			projectId: "project-1",
			sourceKind: "worktree",
		});

		await expect(readNewChatPreferences()).resolves.toEqual({
			connectionKey: "machine-1",
			projectId: "project-1",
			sourceKind: "worktree",
		});
	});

	test("falls back safely for malformed preferences", async () => {
		secureStore.value = JSON.stringify({
			connectionKey: 42,
			projectId: [],
			sourceKind: "branch-name-that-must-not-be-saved",
		});

		await expect(readNewChatPreferences()).resolves.toEqual(
			DEFAULT_NEW_CHAT_PREFERENCES,
		);
	});

	test("persists only defaults, never a concrete branch selection", async () => {
		await saveNewChatPreferences({
			connectionKey: "machine-2",
			projectId: "project-2",
			sourceKind: "pr",
		});

		const encoded = secureStore.writes[0]?.[1];
		expect(encoded).toBeDefined();
		expect(JSON.parse(encoded ?? "{}")).toEqual({
			connectionKey: "machine-2",
			projectId: "project-2",
			sourceKind: "pr",
		});
	});
});
