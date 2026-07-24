import * as SecureStore from "expo-secure-store";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

const STORE_KEY = "zuse.mobile.pinned-chats.v1";

export const pinnedChatKey = (connectionKey: string, chatId: string): string =>
	JSON.stringify([connectionKey, chatId]);

export const pinnedChatsHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);
export const pinnedChatKeysAtom = Atom.make<readonly string[]>([]).pipe(
	Atom.keepAlive,
);

/** Per-chat membership; notifies only when this chat's pinned bit flips. */
export const isPinnedAtom = Atom.family((key: string) =>
	Atom.make((get) => get(pinnedChatKeysAtom).includes(key)),
);

const persist = (keys: readonly string[]) =>
	SecureStore.setItemAsync(STORE_KEY, JSON.stringify(keys));

export const hydratePinnedChats = async (): Promise<void> => {
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
	batchAtomUpdates(() => {
		appAtomRegistry.set(pinnedChatsHydratedAtom, true);
		appAtomRegistry.set(pinnedChatKeysAtom, keys);
	});
};

export const togglePinnedChat = async (key: string): Promise<void> => {
	const current = appAtomRegistry.get(pinnedChatKeysAtom);
	const next = current.includes(key)
		? current.filter((candidate) => candidate !== key)
		: [key, ...current];
	appAtomRegistry.set(pinnedChatKeysAtom, next);
	try {
		await persist(next);
	} catch {
		appAtomRegistry.set(pinnedChatKeysAtom, current);
	}
};

export const clearPinnedChats = async (): Promise<void> => {
	await SecureStore.deleteItemAsync(STORE_KEY);
	batchAtomUpdates(() => {
		appAtomRegistry.set(pinnedChatsHydratedAtom, true);
		appAtomRegistry.set(pinnedChatKeysAtom, []);
	});
};
