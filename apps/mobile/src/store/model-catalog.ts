import type { ResolvedModelCatalog } from "@zuse/contracts";
import { bundledResolvedModelCatalog } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import {
	readModelCatalogSnapshot,
	writeModelCatalogSnapshot,
} from "~/offline/cache";
import { fetchModelCatalog } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

/**
 * Per-connection resolved model catalog (curated seed merged with the
 * desktop's live provider inventories). Three instant tiers: the bundled
 * snapshot compiled into the app, the last server answer on disk, then the
 * `model.catalog` RPC. An old desktop without the RPC keeps the bundled
 * snapshot, so pickers always have something to show.
 */
const BUNDLED = bundledResolvedModelCatalog();
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;

export const catalogByConnectionAtom = Atom.make<
	Record<string, ResolvedModelCatalog | undefined>
>({}).pipe(Atom.keepAlive);

/** Catalog for one connection; the bundled snapshot until hydrated. */
export const connectionModelCatalogAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(catalogByConnectionAtom)[connKey] ?? BUNDLED),
);

/**
 * Catalog of the most recently hydrated connection — the one whose composer
 * or new-chat screen is on screen. Model menus read this so they don't have
 * to thread a connection key through every pill and sheet.
 */
export const activeModelCatalogAtom = Atom.make<ResolvedModelCatalog>(
	BUNDLED,
).pipe(Atom.keepAlive);

export const activeModelCatalog = (): ResolvedModelCatalog =>
	appAtomRegistry.get(activeModelCatalogAtom);

const loadedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

const publish = (connKey: string, catalog: ResolvedModelCatalog): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.update(catalogByConnectionAtom, (state) => ({
			...state,
			[connKey]: catalog,
		}));
		appAtomRegistry.set(activeModelCatalogAtom, catalog);
	});
};

export const hydrateModelCatalog = async (
	connKey: string,
	options: WsProtocolOptions,
	settings: { readonly maxAgeMs?: number } = {},
): Promise<void> => {
	const known = appAtomRegistry.get(catalogByConnectionAtom)[connKey];
	if (known !== undefined) {
		appAtomRegistry.set(activeModelCatalogAtom, known);
	}
	const fresh = loadedAt.get(connKey);
	if (
		fresh !== undefined &&
		Date.now() - fresh < (settings.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
	) {
		return;
	}
	const pending = inFlight.get(connKey);
	if (pending !== undefined) {
		await pending;
		return;
	}
	const run = (async () => {
		if (known === undefined) {
			const snapshot = await Effect.runPromise(
				readModelCatalogSnapshot(connKey).pipe(
					Effect.catch(() => Effect.succeed(null)),
				),
			);
			if (snapshot !== null) publish(connKey, snapshot);
		}
		const remote = await Effect.runPromise(
			fetchModelCatalog({ connection: options }),
		);
		loadedAt.set(connKey, Date.now());
		if (remote === null) return;
		publish(connKey, remote);
		await Effect.runPromise(
			writeModelCatalogSnapshot(connKey, remote).pipe(
				Effect.catch(() => Effect.void),
			),
		);
	})().finally(() => {
		inFlight.delete(connKey);
	});
	inFlight.set(connKey, run);
	await run;
};

export const resetModelCatalogRuntime = (): void => {
	loadedAt.clear();
	batchAtomUpdates(() => {
		appAtomRegistry.set(catalogByConnectionAtom, {});
		appAtomRegistry.set(activeModelCatalogAtom, BUNDLED);
	});
};
