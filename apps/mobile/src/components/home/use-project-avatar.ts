import { useAtomValue } from "@effect/atom-react";
import type { FolderId } from "@zuse/contracts";
import { useEffect } from "react";

import {
	resolveProjectAvatarUrl,
	shouldHydrateProjectAvatar,
} from "~/lib/project-avatar";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { connectionSnapshotAtom } from "~/store/connection-runtime";
import {
	hydrateProjectOrigin,
	projectOriginAtom,
	projectOriginAttemptGenerationAtom,
	projectOriginKey,
	projectOriginLoadingAtom,
} from "~/store/project-origins";

export function useProjectAvatarUrl(options: {
	readonly connectionKey: string;
	readonly projectId: FolderId;
	readonly connection: WsProtocolOptions | null;
	readonly provisionalUrl: string | null;
}): string | null {
	const originKey = projectOriginKey(options.connectionKey, options.projectId);
	const origin = useAtomValue(projectOriginAtom(originKey));
	const loading = useAtomValue(projectOriginLoadingAtom(originKey));
	const attemptedGeneration = useAtomValue(
		projectOriginAttemptGenerationAtom(originKey),
	);
	const connectionSnapshot = useAtomValue(
		connectionSnapshotAtom(options.connectionKey),
	);
	const generation = connectionSnapshot?.generation;
	const shouldHydrate = shouldHydrateProjectAvatar({
		connectionStatus: connectionSnapshot?.status,
		originResolved: origin !== undefined,
		loading,
		generation,
		attemptedGeneration,
	});

	useEffect(() => {
		if (
			options.connection === null ||
			generation === undefined ||
			!shouldHydrate
		) {
			return;
		}
		void hydrateProjectOrigin(
			options.connectionKey,
			options.connection,
			options.projectId,
			generation,
		);
	}, [
		generation,
		options.connection,
		options.connectionKey,
		options.projectId,
		shouldHydrate,
	]);

	return resolveProjectAvatarUrl(origin, options.provisionalUrl);
}
