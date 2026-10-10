import "@zuse/i18n/english/shell";
import {
	EnvironmentId,
	type FolderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

import { toastManager } from "../components/ui/toast.tsx";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { cloudSummaryForChat } from "./cloud-workspace-catalog.ts";
import { activeSessionsByProject } from "./environment-entities.ts";

import { prepareChatTab } from "./prepare-chat-tab.ts";

const EMPTY_SESSIONS: ReadonlyArray<Session> = [];

export const closeActiveChatTab = async (
	environmentId?: EnvironmentId,
): Promise<void> => {
	const sessionId = useSessionsStore.getState().selectedSessionId;
	if (sessionId === null) return;
	await closeChatTab(sessionId, environmentId);
};

export const closeChatTab = async (
	sessionId: SessionId,
	explicitEnvironmentId?: EnvironmentId,
): Promise<void> => {
	const sessions = useSessionsStore.getState();
	const sessionsByProject = activeSessionsByProject();
	let projectId: FolderId | null = null;
	let session: Session | null = null;
	for (const [pid, list] of Object.entries(sessionsByProject)) {
		const match = list.find((row) => row.id === sessionId);
		if (match !== undefined) {
			projectId = pid as FolderId;
			session = match;
			break;
		}
	}
	if (projectId === null || session === null) return;
	const currentSession = session;
	const environmentId =
		explicitEnvironmentId ??
		EnvironmentId.make(
			cloudSummaryForChat(currentSession.chatId)?.workspaceId ??
				useEnvironmentCatalogStore.getState().activeEnvironmentId,
		);
	const projectRows = sessionsByProject[projectId] ?? EMPTY_SESSIONS;
	const siblings = projectRows
		.filter(
			(row) =>
				row.chatId === currentSession.chatId &&
				row.archivedAt === null &&
				row.id !== currentSession.id,
		)
		.slice()
		.sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);

	if (siblings.length > 0) {
		const idx = projectRows
			.filter(
				(row) =>
					row.chatId === currentSession.chatId && row.archivedAt === null,
			)
			.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
			)
			.findIndex((row) => row.id === currentSession.id);
		const ordered = siblings;
		const next = ordered[idx] ?? ordered[idx - 1] ?? ordered[0] ?? null;
		await sessions.archive(sessionId, environmentId);
		sessions.select(next?.id ?? null);
		return;
	}

	const prepared = await prepareChatTab(environmentId, projectId);
	if (prepared === null) {
		toastManager.add({
			type: "error",
			title: uiMessage("shell:close_chat_tab_no_authenticated_agent"),
			description: uiMessage(
				"shell:close_chat_tab_connect_an_agent_in_cloud_authentication_before_replacing_this_ta",
			),
		});
		return;
	}
	const { providerId, model, runtimeMode } = prepared;
	const replacementId = await sessions.create(
		currentSession.chatId,
		providerId,
		model,
		{
			runtimeMode,
		},
	);
	if (replacementId === null) return;
	await sessions.archive(currentSession.id, environmentId);
	sessions.select(replacementId);
};
