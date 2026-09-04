import {
	defaultModelFor,
	EnvironmentId,
	type FolderId,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";

import { toastManager } from "../components/ui/toast.tsx";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { resolveChatRuntimeMode } from "./auto-worktree.ts";
import { cloudSummaryForChat } from "./cloud-workspace-catalog.ts";
import { activeSessionsByProject } from "./environment-entities.ts";
import { selectAuthenticatedProvider } from "./model-picker-availability.ts";
import { useSettingsStore } from "./settings-client-bus.ts";

const EMPTY_SESSIONS: ReadonlyArray<Session> = [];

export const closeActiveChatTab = async (): Promise<void> => {
	const sessionId = useSessionsStore.getState().selectedSessionId;
	if (sessionId === null) return;
	await closeChatTab(sessionId);
};

export const closeChatTab = async (sessionId: SessionId): Promise<void> => {
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
		await sessions.archive(sessionId);
		sessions.select(next?.id ?? null);
		return;
	}

	const settings = useSettingsStore.getState();
	const environmentId = EnvironmentId.make(
		cloudSummaryForChat(currentSession.chatId)?.workspaceId ??
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	await useProvidersStore.getState().loadFor(environmentId);
	const providerId = selectAuthenticatedProvider({
		preferredProviderId: settings.defaultProviderId,
		providerIds: Object.keys(MODELS_BY_PROVIDER) as ReadonlyArray<ProviderId>,
		availability:
			useProvidersStore.getState().availabilityByEnvironment[environmentId]
				?.availability ?? [],
		providerEnabled: settings.providerEnabled ?? {},
	});
	if (providerId === null) {
		toastManager.add({
			type: "error",
			title: "No authenticated agent",
			description:
				"Connect an agent in Cloud Authentication before replacing this tab.",
		});
		return;
	}
	const model =
		settings.defaultModelByProvider[providerId] ?? defaultModelFor(providerId);
	const runtimeMode = await resolveChatRuntimeMode(environmentId, projectId);
	const replacementId = await sessions.create(
		currentSession.chatId,
		providerId,
		model,
		{
			runtimeMode,
		},
	);
	if (replacementId === null) return;
	await sessions.archive(currentSession.id);
	sessions.select(replacementId);
};
