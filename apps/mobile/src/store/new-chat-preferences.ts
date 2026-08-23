import * as SecureStore from "expo-secure-store";

import type { NewChatSourceKind } from "~/lib/new-chat";

const STORE_KEY = "zuse.new-chat-preferences.v1";

export type NewChatPreferences = Readonly<{
	connectionKey: string | null;
	projectId: string | null;
	sourceKind: NewChatSourceKind;
}>;

export const DEFAULT_NEW_CHAT_PREFERENCES: NewChatPreferences = {
	connectionKey: null,
	projectId: null,
	sourceKind: "main",
};

const isSourceKind = (value: unknown): value is NewChatSourceKind =>
	value === "main" ||
	value === "worktree" ||
	value === "branch" ||
	value === "pr";

const nullableId = (value: unknown): string | null | undefined =>
	value === null || typeof value === "string" ? value : undefined;

const decodePreferences = (value: unknown): NewChatPreferences => {
	if (typeof value !== "object" || value === null)
		return DEFAULT_NEW_CHAT_PREFERENCES;
	const connectionKey = nullableId(Reflect.get(value, "connectionKey"));
	const projectId = nullableId(Reflect.get(value, "projectId"));
	const sourceKind = Reflect.get(value, "sourceKind");
	if (
		connectionKey === undefined ||
		projectId === undefined ||
		!isSourceKind(sourceKind)
	) {
		return DEFAULT_NEW_CHAT_PREFERENCES;
	}
	return { connectionKey, projectId, sourceKind };
};

export const readNewChatPreferences = async (): Promise<NewChatPreferences> => {
	try {
		const raw = await SecureStore.getItemAsync(STORE_KEY);
		return raw === null
			? DEFAULT_NEW_CHAT_PREFERENCES
			: decodePreferences(JSON.parse(raw));
	} catch {
		return DEFAULT_NEW_CHAT_PREFERENCES;
	}
};

let writeTail = Promise.resolve();

export const saveNewChatPreferences = (
	preferences: NewChatPreferences,
): Promise<void> => {
	writeTail = writeTail
		.catch(() => undefined)
		.then(() =>
			SecureStore.setItemAsync(STORE_KEY, JSON.stringify(preferences)),
		);
	return writeTail;
};
