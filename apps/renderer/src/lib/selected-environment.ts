import { EnvironmentId } from "@zuse/contracts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
	cloudSummaryForSelection,
	findCloudSummaryForSelection,
	useCloudChatCatalogStore,
} from "./cloud-workspace-catalog.ts";

export const currentSelectedEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(
		cloudSummaryForSelection({
			chatId: useChatsStore.getState().selectedChatId,
			sessionId: useSessionsStore.getState().selectedSessionId,
		})?.workspaceId ??
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);

export const useSelectedEnvironmentId = (): EnvironmentId => {
	const chatId = useChatsStore((s) => s.selectedChatId);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const workspaceId = useCloudChatCatalogStore(
		(s) =>
			findCloudSummaryForSelection(s.summaries, { chatId, sessionId })
				?.workspaceId,
	);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	return EnvironmentId.make(workspaceId ?? activeEnvironmentId);
};
