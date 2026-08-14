import type { ResourceDataUpdate } from "@zuse/client-runtime/client-bus";
import type { ResourceCursor } from "@zuse/client-runtime/resource-state";
import {
	type Chat,
	type ChatId,
	EnvironmentId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import {
	type EnvironmentShellData,
	environmentShellResourceKey,
	environmentShellSnapshot,
} from "./environment-shell-client-bus.ts";
import { getActiveEnvironment } from "./rpc-client.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

export const EMPTY_CHATS_BY_PROJECT: Readonly<
	Record<string, ReadonlyArray<Chat>>
> = {};
export const EMPTY_SESSIONS_BY_PROJECT: Readonly<
	Record<string, ReadonlyArray<Session>>
> = {};

export const environmentShellData = (
	environmentId: EnvironmentId | string,
): EnvironmentShellData | null =>
	environmentShellSnapshot({
		environmentId: EnvironmentId.make(environmentId),
	}).data;

export const activeEnvironmentShellData = (): EnvironmentShellData | null =>
	environmentShellData(getActiveEnvironment());

export const activeChatsByProject =
	(): EnvironmentShellData["chatsByProject"] =>
		activeEnvironmentShellData()?.chatsByProject ?? EMPTY_CHATS_BY_PROJECT;

export const activeSessionsByProject =
	(): EnvironmentShellData["sessionsByProject"] =>
		activeEnvironmentShellData()?.sessionsByProject ??
		EMPTY_SESSIONS_BY_PROJECT;

export const activeChatById = (chatId: ChatId): Chat | null => {
	for (const chats of Object.values(activeChatsByProject())) {
		const chat = chats.find((candidate) => candidate.id === chatId);
		if (chat !== undefined) return chat;
	}
	return null;
};

export const activeSessionById = (sessionId: SessionId): Session | null => {
	for (const sessions of Object.values(activeSessionsByProject())) {
		const session = sessions.find((candidate) => candidate.id === sessionId);
		if (session !== undefined) return session;
	}
	return null;
};

export type EnvironmentShellFence = Readonly<{
	environmentId: EnvironmentId;
	generation: number;
	cursor: ResourceCursor | null;
}>;

export const activeEnvironmentShellFence = (): EnvironmentShellFence => {
	const environmentId = EnvironmentId.make(getActiveEnvironment());
	const view = environmentShellSnapshot({ environmentId });
	return { environmentId, generation: view.generation, cursor: view.cursor };
};

/**
 * Apply a response only to the environment-shell generation and cursor which
 * issued it. Live summary frames that advanced while an RPC was in flight win
 * over the stale response automatically.
 */
export const updateEnvironmentShell = (
	fence: EnvironmentShellFence,
	update: ResourceDataUpdate<EnvironmentShellData>["update"],
	options: { readonly persist?: boolean } = {},
): boolean =>
	getRendererClientBus().update(
		environmentShellResourceKey({ environmentId: fence.environmentId }),
		{
			expectedGeneration: fence.generation,
			expectedCursor: fence.cursor,
			update,
			persist: options.persist,
		},
	);

/** Optimistic command intent belongs in the canonical keyed cell as an overlay. */
export const overlayActiveEnvironmentShell = (
	update: (data: EnvironmentShellData) => EnvironmentShellData | undefined,
): boolean => {
	return overlayEnvironmentShell(
		EnvironmentId.make(getActiveEnvironment()),
		update,
	);
};

/** Apply optimistic entity intent to one explicitly qualified environment. */
export const overlayEnvironmentShell = (
	environmentId: EnvironmentId,
	update: (data: EnvironmentShellData) => EnvironmentShellData | undefined,
): boolean => {
	return getRendererClientBus().overlay(
		environmentShellResourceKey({ environmentId }),
		{ update },
	);
};
