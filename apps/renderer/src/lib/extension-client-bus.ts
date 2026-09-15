import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	EnvironmentId,
	type ExtensionCapability,
	type ExtensionCatalog,
	type ExtensionId,
	type ExtensionListItem,
	type ExtensionLogEntry,
	type ExtensionManifest,
	type ExtensionSource,
	type MarketplaceExtension,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

const EMPTY_CATALOG: ExtensionCatalog = { globallyEnabled: false, items: [] };

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<ExtensionCatalog>("extension-catalog", { environmentId });

const makeDriver = (): ResourceDriver<MemoizeClient, ExtensionCatalog> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start(context) {
			active = true;
			let version = 0;
			const epoch = `extensions:${context.generation}:${crypto.randomUUID()}`;
			fiber = Effect.runFork(
				Stream.runForEach(
					context.client["extension.catalog.stream"](),
					(catalog) =>
						Effect.sync(() => {
							if (!active || !context.isCurrent()) return;
							version += 1;
							context.emit({
								data: catalog,
								cursor: { epoch, version },
								resetEpoch: version === 1,
								sync: "live",
							});
						}),
				).pipe(
					Effect.andThen(
						Effect.fail(new Error("Extension catalog stream ended.")),
					),
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							if (!active || Cause.hasInterruptsOnly(cause)) return;
							context.emit({ sync: "failed" });
						}),
					),
				),
			);
		},
		stop() {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver(
	"extension-catalog",
	() => makeDriver() as ResourceDriver<MemoizeClient, unknown>,
);

const active = () => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	return {
		environmentId,
		key: keyFor(environmentId),
		bus: getRendererClientBus(),
	};
};

const dispatch = async <Result>(
	kind: string,
	payload: unknown,
	context = active(),
): Promise<Result> => {
	const { environmentId, key, bus } = context;
	const receipt = await bus.dispatch<Result>({
		kind,
		commandId: CommandId.make(`${kind}:${crypto.randomUUID()}`),
		environmentId,
		resource: key,
		payload,
		retry: "never",
		createdAt: Date.now(),
	});
	return receipt.result;
};

export const extensionActions = {
	setGlobalEnabled: (enabled: boolean) =>
		dispatch<ExtensionCatalog>("extension.setGlobalEnabled", { enabled }),
	inspect: (source: ExtensionSource) =>
		dispatch<ExtensionManifest>("extension.inspect", { source }),
	install: (
		source: ExtensionSource,
		grantedCapabilities: ReadonlyArray<ExtensionCapability>,
	) =>
		dispatch<ExtensionListItem>("extension.install", {
			source,
			grantedCapabilities,
		}),
	enable: (id: ExtensionId) =>
		dispatch<ExtensionListItem>("extension.enable", { id }),
	disable: (id: ExtensionId) =>
		dispatch<ExtensionListItem>("extension.disable", { id }),
	reload: (id: ExtensionId) =>
		dispatch<ExtensionListItem>("extension.reload", { id }),
	remove: (id: ExtensionId, deleteData: boolean) =>
		dispatch<void>("extension.remove", { id, deleteData }),
	update: (
		id: ExtensionId,
		grantedCapabilities: ReadonlyArray<ExtensionCapability>,
	) =>
		dispatch<ExtensionListItem>("extension.update", {
			id,
			grantedCapabilities,
		}),
	logs: (id: ExtensionId) =>
		dispatch<ReadonlyArray<ExtensionLogEntry>>("extension.logs", { id }),
	marketplace: (refresh = false) =>
		dispatch<ReadonlyArray<MarketplaceExtension>>(
			refresh ? "extension.marketplace.refresh" : "extension.marketplace.list",
			{},
		),
	invoke: async (
		id: ExtensionId,
		method: string,
		input: unknown,
		workspace?: {
			projectId: string;
			worktreeId: string | null;
			sessionId: string | null;
		},
		signal?: AbortSignal,
	) => {
		signal?.throwIfAborted();
		const context = active();
		const requestId = crypto.randomUUID();
		const cancel = () => {
			void dispatch("extension.cancel", { id, requestId }, context).catch(
				(cause) => console.error("[extensions] cancellation failed", cause),
			);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			return await dispatch(
				"extension.invoke",
				{ id, method, input, workspace, requestId },
				context,
			);
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	},
};

export const useExtensionCatalog = (): ExtensionCatalog & {
	readonly loaded: boolean;
	readonly error: string | null;
} => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const key = useMemo(() => keyFor(environmentId), [environmentId]);
	const bus = getRendererClientBus();
	useEffect(
		() => bus.retain(key, { activation: "connect" }).release,
		[bus, key],
	);
	const view = useSyncExternalStore(
		(listener) => bus.subscribe(key, listener),
		() => bus.snapshot(key),
	);
	return {
		...(view.data ?? EMPTY_CATALOG),
		loaded: view.data !== null,
		error: bus.connection(environmentId).error,
	};
};
