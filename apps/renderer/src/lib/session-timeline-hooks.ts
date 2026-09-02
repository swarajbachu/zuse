import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type {
	EnvironmentId,
	Message,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";

import { useSessionRuntimeStore } from "../store/session-runtime.ts";
import {
	effectiveSessionRuntimeState,
	runtimeStateFromTimeline,
	type SessionRuntimeState,
} from "./session-runtime-state.ts";
import {
	getRendererClientBus,
	sessionTimelineResourceKey,
	useSessionTimelineResource,
} from "./session-timeline-client-bus.ts";

const EMPTY_MESSAGES: readonly Message[] = [];

export type RendererSessionTimeline = Readonly<{
	ref: SessionRef;
	view: ResourceView<SessionTimelineProjection>;
	projection: SessionTimelineProjection | null;
	messages: readonly Message[];
	runtime: SessionRuntimeState;
}>;

export type OptionalRendererSessionTimeline = Readonly<{
	ref: SessionRef | null;
	view: ResourceView<SessionTimelineProjection>;
	projection: SessionTimelineProjection | null;
	messages: readonly Message[];
	runtime: SessionRuntimeState;
}>;

type TimelineSnapshotCache = Readonly<{
	views: readonly ResourceView<SessionTimelineProjection>[];
	runtimes: readonly SessionRuntimeState[];
	value: readonly RendererSessionTimeline[];
}>;

const EMPTY_TIMELINE_VIEW: ResourceView<SessionTimelineProjection> = {
	data: null,
	origin: "none",
	connection: "dormant",
	sync: "empty",
	generation: 0,
	cursor: null,
	pendingCommands: [],
	failedCommands: [],
};

export const runtimeFromResource = (
	view: ResourceView<SessionTimelineProjection>,
	fallback: SessionRuntimeState,
): SessionRuntimeState => {
	if (
		view.pendingCommands.some(
			(command) => command.kind === "messages.interrupt",
		)
	) {
		return "stopping";
	}
	const pendingSend =
		view.pendingCommands.some((command) => command.kind === "messages.send") &&
		(view.data === null ||
			view.data.messages.findLast(
				(message) => message.role === "user" || message.role === "assistant",
			)?.role === "user");
	if (pendingSend) return "starting";
	if (
		(view.connection !== "connected" || view.sync !== "live") &&
		(fallback === "idle" || fallback === "failed")
	) {
		return fallback;
	}
	const runtime =
		view.data === null ? fallback : runtimeStateFromTimeline(view.data);
	if (runtime !== "idle") return runtime;
	return "idle";
};

/** One qualified timeline selector shared by chat, composer, queue, and dock. */
export const useRendererSessionTimeline = (
	sessionId: SessionId,
	activation: ResourceActivation = "connect",
	environmentId: EnvironmentId,
): RendererSessionTimeline => {
	return useOptionalRendererSessionTimeline(
		sessionId,
		activation,
		environmentId,
	) as RendererSessionTimeline;
};

/** Null-safe variant for surfaces that remain mounted without an active session. */
export const useOptionalRendererSessionTimeline = (
	sessionId: SessionId | null,
	activation: ResourceActivation = "connect",
	environmentId: EnvironmentId | null,
): OptionalRendererSessionTimeline => {
	const ref = useMemo<SessionRef | null>(
		() =>
			sessionId === null || environmentId === null
				? null
				: {
						environmentId,
						sessionId,
					},
		[environmentId, sessionId],
	);
	const view = useSessionTimelineResource(ref, activation);
	const summaryRuntime = useSessionRuntimeStore((state) =>
		sessionId === null
			? "idle"
			: effectiveSessionRuntimeState(state.bySession[sessionId]),
	);
	return {
		ref,
		view: sessionId === null ? EMPTY_TIMELINE_VIEW : view,
		projection: view.data,
		messages: view.data?.messages ?? EMPTY_MESSAGES,
		runtime: runtimeFromResource(view, summaryRuntime),
	};
};

/**
 * Qualified aggregate selector for surfaces such as the sidebar and tab strip.
 * It retains each keyed resource once and publishes a stable array snapshot, so
 * those surfaces do not subscribe to the legacy whole-store projection maps.
 */
export const useRendererSessionTimelines = (
	refs: readonly SessionRef[],
	activation: ResourceActivation = "cache-only",
): readonly RendererSessionTimeline[] => {
	const refsKey = JSON.stringify(
		refs.map((ref) => [ref.environmentId, ref.sessionId]),
	);
	const stableRefsCache = useRef<{
		key: string;
		refs: readonly SessionRef[];
	} | null>(null);
	if (stableRefsCache.current?.key !== refsKey) {
		stableRefsCache.current = {
			key: refsKey,
			refs: refs.map((ref) => ({ ...ref })),
		};
	}
	const stableRefs = stableRefsCache.current.refs;
	const bus = getRendererClientBus();

	useEffect(() => {
		const leases = stableRefs.map((ref) =>
			bus.retain(sessionTimelineResourceKey(ref), { activation }),
		);
		return () => {
			for (const lease of leases) lease.release();
		};
	}, [activation, bus, stableRefs]);

	const subscribe = useCallback(
		(listener: () => void) => {
			const unsubscribeResources = stableRefs.map((ref) =>
				bus.subscribe(sessionTimelineResourceKey(ref), listener),
			);
			const unsubscribeRuntimeFallback = useSessionRuntimeStore.subscribe(() =>
				listener(),
			);
			return () => {
				for (const unsubscribe of unsubscribeResources) unsubscribe();
				unsubscribeRuntimeFallback();
			};
		},
		[bus, stableRefs],
	);
	const snapshotCache = useRef<TimelineSnapshotCache | null>(null);
	const snapshot = useCallback((): readonly RendererSessionTimeline[] => {
		const runtimeState = useSessionRuntimeStore.getState();
		const views = stableRefs.map((ref) =>
			bus.snapshot(sessionTimelineResourceKey(ref)),
		);
		const runtimes = stableRefs.map((ref, index) => {
			const view = views[index];
			const fallback = effectiveSessionRuntimeState(
				runtimeState.bySession[ref.sessionId],
			);
			return view === undefined
				? fallback
				: runtimeFromResource(view, fallback);
		});
		const previous = snapshotCache.current;
		if (
			previous !== null &&
			previous.views.length === views.length &&
			views.every((view, index) => previous.views[index] === view) &&
			runtimes.every((runtime, index) => previous.runtimes[index] === runtime)
		) {
			return previous.value;
		}
		const value = stableRefs.map((ref, index) => {
			const view = views[index] ?? EMPTY_TIMELINE_VIEW;
			return {
				ref,
				view,
				projection: view.data,
				messages: view.data?.messages ?? EMPTY_MESSAGES,
				runtime: runtimes[index] ?? "idle",
			};
		});
		snapshotCache.current = { views, runtimes, value };
		return value;
	}, [bus, stableRefs]);

	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
