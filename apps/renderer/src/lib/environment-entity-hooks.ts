import type { SessionId } from "@zuse/contracts";
import { EnvironmentId } from "@zuse/contracts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import {
	EMPTY_CHATS_BY_PROJECT,
	EMPTY_SESSIONS_BY_PROJECT,
} from "./environment-entities.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";

/** Environment entities come directly from that environment's ClientBus shell. */
export const useEnvironmentEntities = (environmentId: string) => {
	const view = useEnvironmentShellResource(
		EnvironmentId.make(environmentId),
		"connect",
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
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	return useEnvironmentEntities(environmentId);
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
