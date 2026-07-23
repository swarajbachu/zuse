import { useAtomValue } from "@effect/atom-react";
import type { FolderId } from "@zuse/contracts";
import { useEffect } from "react";

import { resolveProjectAvatarUrl } from "~/lib/project-avatar";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import {
	hydrateProjectOrigin,
	projectOriginAtom,
	projectOriginKey,
} from "~/store/project-origins";

export function useProjectAvatarUrl(options: {
	readonly connectionKey: string;
	readonly projectId: FolderId;
	readonly connection: WsProtocolOptions | null;
	readonly provisionalUrl: string | null;
}): string | null {
	const originKey = projectOriginKey(options.connectionKey, options.projectId);
	const origin = useAtomValue(projectOriginAtom(originKey));

	useEffect(() => {
		if (options.connection === null) return;
		void hydrateProjectOrigin(
			options.connectionKey,
			options.connection,
			options.projectId,
		);
	}, [options.connection, options.connectionKey, options.projectId]);

	return resolveProjectAvatarUrl(origin, options.provisionalUrl);
}
