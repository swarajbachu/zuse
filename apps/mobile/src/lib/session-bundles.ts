import type { ProjectBundle } from "~/store/sessions";

const EMPTY_CONNECTION_BUNDLES: readonly ProjectBundle[] = [];

/** Stable Zustand snapshot for connections whose projects have not loaded. */
export const selectConnectionBundles = (
	bundlesByConnection: Readonly<Record<string, readonly ProjectBundle[]>>,
	connectionKey: string,
): readonly ProjectBundle[] =>
	bundlesByConnection[connectionKey] ?? EMPTY_CONNECTION_BUNDLES;
