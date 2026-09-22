import type { SessionRef } from "@zuse/client-runtime/resource-ref";

const starts = new Map<string, { start: number; phases: Set<string> }>();
const keyOf = (ref: SessionRef) => `${ref.environmentId}:${ref.sessionId}`;
/** Bounded, content-free measurements available in browser performance tools. */
export const beginCloudFetch = (ref: SessionRef): void => {
	const key = keyOf(ref);
	starts.delete(key);
	starts.set(key, { start: performance.now(), phases: new Set() });
	if (starts.size > 128) starts.delete(starts.keys().next().value as string);
};
export const markCloudFetch = (
	ref: SessionRef,
	phase:
		| "cache"
		| "head"
		| "live"
		| "paint"
		| "history-complete"
		| "request-start"
		| "control-ready"
		| "downloaded"
		| "decrypted",
): void => {
	const state = starts.get(keyOf(ref));
	if (!state || state.phases.has(phase)) return;
	state.phases.add(phase);
	const name = `zuse.cloud.fetch.${phase}`;
	performance.clearMeasures(name);
	performance.measure(name, { start: state.start, end: performance.now() });
};
export const markCloudCatalogArrival = (createdAt: Date): void => {
	const name = "zuse.cloud.catalog.creation-to-arrival";
	performance.clearMeasures(name);
	performance.measure(name, {
		start: 0,
		duration: Math.max(0, Date.now() - createdAt.getTime()),
	});
};
