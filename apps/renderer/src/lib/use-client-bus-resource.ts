import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import type { ResourceKey } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { getRendererClientBus } from "./session-timeline-client-bus.ts";

/** Shared React lifecycle for a keyed ClientBus resource. */
export const useClientBusResource = <Data>(
	key: ResourceKey<Data> | null,
	empty: ResourceView<Data>,
	activation: ResourceActivation,
): ResourceView<Data> => {
	const bus = getRendererClientBus();
	useEffect(() => {
		if (key === null) return;
		return bus.retain(key, { activation }).release;
	}, [activation, bus, key]);
	const subscribe = useCallback(
		(listener: () => void) =>
			key === null ? () => undefined : bus.subscribe(key, listener),
		[bus, key],
	);
	const snapshot = useCallback(
		() => (key === null ? empty : bus.snapshot(key)),
		[bus, empty, key],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
