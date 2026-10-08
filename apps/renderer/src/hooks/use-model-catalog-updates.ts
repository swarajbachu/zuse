import { EnvironmentId } from "@zuse/contracts";
import { useEffect, useMemo } from "react";
import { useModelCatalogStream } from "../lib/model-catalog-client-bus.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useModelCatalogStore } from "../store/model-catalog.ts";

/**
 * Keep the renderer model catalog in step with the active environment's
 * server. The server fetches the curated document ~20 s after boot and every
 * 6 h, so without this a catalog update only reached the picker on the next
 * launch. Pass `null` to stay unsubscribed.
 */
export function useModelCatalogUpdates(environmentId: string | null): void {
	const ref = useMemo(
		() =>
			environmentId === null
				? null
				: { environmentId: EnvironmentId.make(environmentId) },
		[environmentId],
	);
	const catalog = useModelCatalogStream(ref).data?.catalog;
	const receive = useModelCatalogStore((state) => state.receive);
	useEffect(() => {
		if (ref === null || catalog === undefined) return;
		receive(ref.environmentId, catalog);
	}, [catalog, receive, ref]);
}

/** Mount the desktop catalog stream separately from the hosted startup path. */
export function ModelCatalogUpdates() {
	const environmentId = useEnvironmentCatalogStore((state) =>
		state.initialized ? state.activeEnvironmentId : null,
	);
	useModelCatalogUpdates(environmentId);
	return null;
}
