import {
	defaultModelFor,
	type FolderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";

import { useProvidersStore } from "../store/providers.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useSettingsStore } from "../store/settings.ts";

const EMPTY_SESSIONS: ReadonlyArray<Session> = [];

export const closeActiveChatTab = async (): Promise<void> => {
	const sessionId = useSessionsStore.getState().selectedSessionId;
	if (sessionId === null) return;
	await closeChatTab(sessionId);
};

export const closeChatTab = async (sessionId: SessionId): Promise<void> => {
	const sessions = useSessionsStore.getState();
	let projectId: FolderId | null = null;
	let session: Session | null = null;
	for (const [pid, list] of Object.entries(sessions.sessionsByProject)) {
		const match = list.find((row) => row.id === sessionId);
		if (match !== undefined) {
			projectId = pid as FolderId;
			session = match;
			break;
		}
	}
	if (projectId === null || session === null) return;
	const currentSession = session;
	const projectRows = sessions.sessionsByProject[projectId] ?? EMPTY_SESSIONS;
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
		await sessions.archive(sessionId);
		sessions.select(next?.id ?? null);
		return;
	}

	const settings = useSettingsStore.getState();
	await useProvidersStore.getState().refresh();
	const providerId = settings.defaultProviderId;
	const model =
		settings.defaultModelByProvider[providerId] ?? defaultModelFor(providerId);
	await sessions.archive(currentSession.id);
	await sessions.create(currentSession.chatId, providerId, model, {
		runtimeMode: settings.defaultRuntimeMode,
	});
};
