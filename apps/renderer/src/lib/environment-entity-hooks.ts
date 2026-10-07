import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { Chat, SessionId } from "@zuse/contracts";
import { EnvironmentId } from "@zuse/contracts";
import { useSyncExternalStore } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import {
	EMPTY_CHATS_BY_PROJECT,
	EMPTY_SESSIONS_BY_PROJECT,
} from "./environment-entities.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";
import { environmentBelongsToWorkspace } from "./rpc-client.ts";

/** Read connection-scoped chat metadata from the existing catalog subscription. */
export const useEnvironmentChat = (ref: ChatRef | null): Chat | null => {
	const shell = useEnvironmentShellResource(ref?.environmentId ?? null).data;
	if (ref === null || shell === null) return null;
	for (const chats of Object.values(shell.chatsByProject)) {
		const chat = chats.find((chat) => chat.id === ref.chatId);
		if (chat !== undefined) return chat;
	}
	return null;
};

/** Environment entities come directly from that environment's ClientBus shell. */
export const useEnvironmentEntities = (
	environmentId: string,
	enabled = true,
	workspaces: "selected" | "all" = "selected",
) => {
	const view = useEnvironmentShellResource(
		enabled ? EnvironmentId.make(environmentId) : null,
		"connect",
		workspaces,
	);
	return {
		environmentId,
		view,
		folders: view.data?.folders ?? [],
		originsByFolder: view.data?.originsByFolder ?? {},
		chatsByProject: view.data?.chatsByProject ?? EMPTY_CHATS_BY_PROJECT,
		sessionsByProject:
			view.data?.sessionsByProject ?? EMPTY_SESSIONS_BY_PROJECT,
		creationOperationsByProject: view.data?.creationOperationsByProject ?? {},
	};
};

/** Active environment entities come directly from its one ClientBus shell. */
export const useActiveEnvironmentEntities = () => {
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	return useEnvironmentEntities(
		environmentId,
		environmentBelongsToWorkspace(environmentId, workspace.scope),
	);
};

/** Reactive lookup against the active environment's canonical shell cell. */
export const useActiveSessionById = (sessionId: SessionId | null) => {
	const { sessionsByProject } = useActiveEnvironmentEntities();
	if (sessionId === null) return null;
	for (const sessions of Object.values(sessionsByProject)) {
		const session = sessions.find((candidate) => candidate.id === sessionId);
		if (session !== undefined) return session;
	}
	return null;
};
