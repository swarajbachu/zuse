import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearPinnedChats,
	hydratePinnedChats,
	isPinnedAtom,
	pinnedChatKey,
	pinnedChatKeysAtom,
	pinnedChatsHydratedAtom,
	togglePinnedChat,
} from "../../../src/store/pinned-chats";
import { appAtomRegistry } from "../../../src/store/registry";

const secureStore = vi.hoisted(() => {
	let stored: string | null = null;
	return {
		getItemAsync: vi.fn(async () => stored),
		setItemAsync: vi.fn(async (_key: string, value: string) => {
			stored = value;
		}),
		deleteItemAsync: vi.fn(async () => {
			stored = null;
		}),
		seed: (value: string | null) => {
			stored = value;
		},
	};
});

vi.mock("expo-secure-store", () => secureStore);

describe("pinned chats", () => {
	beforeEach(() => {
		secureStore.seed(null);
		secureStore.getItemAsync.mockClear();
		secureStore.setItemAsync.mockClear();
		secureStore.deleteItemAsync.mockClear();
		appAtomRegistry.set(pinnedChatsHydratedAtom, false);
		appAtomRegistry.set(pinnedChatKeysAtom, []);
	});

	it("hydrates stored keys and marks hydrated", async () => {
		const key = pinnedChatKey("env-1", "chat-1");
		secureStore.seed(JSON.stringify([key, 42, "valid"]));

		await hydratePinnedChats();

		expect(appAtomRegistry.get(pinnedChatsHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([key, "valid"]);
	});

	it("hydrates to empty on corrupt storage", async () => {
		secureStore.seed("{not json");
		await hydratePinnedChats();
		expect(appAtomRegistry.get(pinnedChatsHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([]);
	});

	it("toggles optimistically and persists", async () => {
		const key = pinnedChatKey("env-1", "chat-1");
		await togglePinnedChat(key);
		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([key]);
		expect(appAtomRegistry.get(isPinnedAtom(key))).toBe(true);

		await togglePinnedChat(key);
		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([]);
		expect(appAtomRegistry.get(isPinnedAtom(key))).toBe(false);
	});

	it("rolls back the toggle when persistence fails", async () => {
		const key = pinnedChatKey("env-1", "chat-1");
		secureStore.setItemAsync.mockRejectedValueOnce(new Error("disk full"));

		await togglePinnedChat(key);

		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([]);
	});

	it("clears storage and state", async () => {
		const key = pinnedChatKey("env-1", "chat-1");
		await togglePinnedChat(key);

		await clearPinnedChats();

		expect(secureStore.deleteItemAsync).toHaveBeenCalled();
		expect(appAtomRegistry.get(pinnedChatsHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(pinnedChatKeysAtom)).toEqual([]);
	});
});
