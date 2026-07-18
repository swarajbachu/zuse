import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const STORE_KEY = "zuse.mobile.pinned-chats.v1";

export const pinnedChatKey = (connectionKey: string, chatId: string): string =>
	JSON.stringify([connectionKey, chatId]);

type PinnedChatsState = {
	hydrated: boolean;
	keys: readonly string[];
	hydrate: () => Promise<void>;
	toggle: (key: string) => Promise<void>;
	clear: () => Promise<void>;
};

const persist = (keys: readonly string[]) =>
	SecureStore.setItemAsync(STORE_KEY, JSON.stringify(keys));

export const usePinnedChatsStore = create<PinnedChatsState>((set, get) => ({
	hydrated: false,
	keys: [],
	hydrate: async () => {
		const raw = await SecureStore.getItemAsync(STORE_KEY);
		let keys: string[] = [];
		try {
			const parsed: unknown = raw === null ? [] : JSON.parse(raw);
			if (Array.isArray(parsed)) {
				keys = parsed.filter(
					(value): value is string => typeof value === "string",
				);
			}
		} catch {
			keys = [];
		}
		set({ hydrated: true, keys });
	},
	toggle: async (key) => {
		const current = get().keys;
		const next = current.includes(key)
			? current.filter((candidate) => candidate !== key)
			: [key, ...current];
		set({ keys: next });
		try {
			await persist(next);
		} catch {
			set({ keys: current });
		}
	},
	clear: async () => {
		await SecureStore.deleteItemAsync(STORE_KEY);
		set({ hydrated: true, keys: [] });
	},
}));
