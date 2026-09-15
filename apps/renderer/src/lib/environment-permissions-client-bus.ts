import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import {
	CommandId,
	EnvironmentId,
	type FolderId,
	type PermissionDecision,
	type PermissionRequest,
	type SavedDecision,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import { interruptSession } from "./session-actions.ts";
import {
	dispatchSessionCommand,
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type EnvironmentPermissionsData = Readonly<{
	requestsById: Readonly<Record<string, PermissionRequest>>;
	decisionsByProject: Readonly<Record<string, ReadonlyArray<SavedDecision>>>;
	loadingDecisionsByProject: Readonly<Record<string, boolean>>;
}>;

const emptyData = (): EnvironmentPermissionsData => ({
	requestsById: {},
	decisionsByProject: {},
	loadingDecisionsByProject: {},
});

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<EnvironmentPermissionsData>("environment-permissions", {
		environmentId,
	});

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-permissions" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const makeDriver = (): ResourceDriver<
	MemoizeClient,
	EnvironmentPermissionsData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			if (environmentFrom(context.key) === null) return;
			active = true;
			const epoch = `environment-permissions:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			let current = context.data ?? emptyData();
			const program = Stream.runForEach(
				context.client["permission.requests"]({}),
				(change) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						// Fold optimistic overlays into the driver's working state before
						// applying the next authoritative event. Otherwise an unrelated
						// request could resurrect a prompt while its decision is in flight.
						current = context.snapshot()?.data ?? current;
						let requestsById = current.requestsById;
						if (change._tag === "snapshot") {
							requestsById = Object.fromEntries(
								change.requests.map((request) => [request.id, request]),
							);
						} else if (change._tag === "change") {
							requestsById = {
								...requestsById,
								[change.request.id]: change.request,
							};
						} else {
							const next = { ...requestsById };
							delete next[change.requestId];
							requestsById = next;
						}
						version += 1;
						current = { ...current, requestsById };
						context.emit({
							data: current,
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Permission stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						const failure = Cause.squash(cause);
						context.emit({ sync: "failed" });
						if (!isRpcClientTransportError(failure)) return;
						getRendererClientBus().reportConnectionFault(
							context.key.ref.environmentId,
							{ phase: "failed", message: messageOf(failure) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("environment-permissions", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<EnvironmentPermissionsData>();

export const useEnvironmentPermissions = (
	environmentId?: EnvironmentId,
): ResourceView<EnvironmentPermissionsData> => {
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const selectedEnvironmentId =
		environmentId ?? EnvironmentId.make(activeEnvironmentId);
	const key = useMemo(
		() => keyFor(selectedEnvironmentId),
		[selectedEnvironmentId],
	);
	return useClientBusResource(key, EMPTY, "connect");
};

export const decideEnvironmentPermission = async (
	request: Pick<PermissionRequest, "id" | "sessionId">,
	decision: PermissionDecision,
	environmentId?: EnvironmentId,
): Promise<void> => {
	const selectedEnvironmentId =
		environmentId ??
		EnvironmentId.make(
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
		);
	const commandId = CommandId.make(
		`permission-decide:${request.id}:${Date.now().toString(36)}`,
	);
	// The durable session timeline owns prompt visibility and its submission
	// overlay. The environment stream only proves a live callback is attached.
	// An authoritative PermissionResolved event removes the durable prompt.
	await dispatchSessionCommand({
		kind: "permission.decide",
		commandId,
		ref: {
			environmentId: selectedEnvironmentId,
			sessionId: request.sessionId,
		},
		payload: { requestId: request.id, decision },
		retry: "never",
	});
};

/** A user denial rejects the requested action and ends that agent turn. */
export const denyEnvironmentPermissionAndInterrupt = async (
	request: Pick<PermissionRequest, "id" | "sessionId">,
	environmentId: EnvironmentId,
): Promise<void> => {
	await decideEnvironmentPermission(request, { _tag: "Deny" }, environmentId);
	await interruptSession({ environmentId, sessionId: request.sessionId });
};

const activeKey = () =>
	keyFor(
		EnvironmentId.make(
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
		),
	);

export const loadEnvironmentPermissionDecisions = async (
	projectId: FolderId,
): Promise<void> => {
	const key = activeKey();
	const bus = getRendererClientBus();
	bus.overlay(key, {
		update: (data) => ({
			...data,
			loadingDecisionsByProject: {
				...data.loadingDecisionsByProject,
				[projectId]: true,
			},
		}),
	});
	try {
		const receipt = await bus.dispatch<ReadonlyArray<SavedDecision>>({
			kind: "permission.listDecisions",
			commandId: CommandId.make(
				`permission-list:${projectId}:${Date.now().toString(36)}`,
			),
			environmentId: key.ref.environmentId,
			resource: key,
			payload: { projectId },
			retry: "never",
			createdAt: Date.now(),
		});
		bus.overlay(key, {
			update: (data) => ({
				...data,
				decisionsByProject: {
					...data.decisionsByProject,
					[projectId]: receipt.result,
				},
				loadingDecisionsByProject: {
					...data.loadingDecisionsByProject,
					[projectId]: false,
				},
			}),
		});
	} catch (cause) {
		bus.overlay(key, {
			update: (data) => ({
				...data,
				loadingDecisionsByProject: {
					...data.loadingDecisionsByProject,
					[projectId]: false,
				},
			}),
		});
		throw cause;
	}
};

export const revokeEnvironmentPermissionDecision = async (
	projectId: FolderId,
	requestId: string,
): Promise<void> => {
	const key = activeKey();
	const bus = getRendererClientBus();
	const before = bus.snapshot(key).data?.decisionsByProject[projectId];
	bus.overlay(key, {
		update: (data) => ({
			...data,
			decisionsByProject: {
				...data.decisionsByProject,
				[projectId]: (data.decisionsByProject[projectId] ?? []).filter(
					(decision) => decision.requestId !== requestId,
				),
			},
		}),
	});
	try {
		await bus.dispatch({
			kind: "permission.revokeDecision",
			commandId: CommandId.make(
				`permission-revoke:${requestId}:${Date.now().toString(36)}`,
			),
			environmentId: key.ref.environmentId,
			resource: key,
			payload: { requestId },
			retry: "never",
			createdAt: Date.now(),
		});
	} catch (cause) {
		if (before !== undefined) {
			bus.overlay(key, {
				update: (data) => ({
					...data,
					decisionsByProject: {
						...data.decisionsByProject,
						[projectId]: before,
					},
				}),
			});
		}
		throw cause;
	}
};
