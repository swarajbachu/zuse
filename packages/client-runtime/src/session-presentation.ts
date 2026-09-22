import type {
	SessionInteraction,
	SessionStatus,
	SessionTimelineProjection,
} from "@zuse/contracts";

import type { ResourceView } from "./resource-state.ts";

export type SessionRuntimeState =
	| "starting"
	| "running"
	| "stopping"
	| "idle"
	| "failed";

export type SessionInteractionSubmission = "pending" | "submitting" | "failed";

export type PresentedSessionInteraction = Readonly<{
	interaction: SessionInteraction;
	submission: SessionInteractionSubmission;
	error: string | null;
}>;

export type SessionAttentionState =
	| "idle"
	| "running"
	| "question"
	| "permission";

export type SessionPresentation = Readonly<{
	runtime: SessionRuntimeState;
	busy: boolean;
	turnActive: boolean;
	/** A durable turn is active or a still-applicable start command bridges to it. */
	turnInFlight: boolean;
	attention: SessionAttentionState;
	interactions: ReadonlyArray<PresentedSessionInteraction>;
}>;

export const runtimeStateFromStatus = (
	status: SessionStatus,
): SessionRuntimeState => {
	switch (status) {
		case "booting":
			return "starting";
		case "running":
			return "running";
		case "error":
			return "failed";
		case "closed":
		case "idle":
			return "idle";
	}
};

export const runtimeStateFromTimeline = (
	projection: SessionTimelineProjection,
): SessionRuntimeState => {
	if (projection.status === "error") return "failed";
	if (projection.status === "booting") return "starting";
	const phase = projection.currentTurn?.phase;
	if (phase === "interrupt-requested" || phase === "interrupt-acknowledged") {
		return "stopping";
	}
	if (projection.currentTurn !== null || projection.status === "running") {
		return "running";
	}
	return "idle";
};

export const isSessionRuntimeBusy = (state: SessionRuntimeState): boolean =>
	state === "starting" || state === "running" || state === "stopping";

export const isSessionTurnActive = (state: SessionRuntimeState): boolean =>
	state === "running" || state === "stopping";

export const hasPendingTurnStart = (
	pendingCommands: ResourceView<unknown>["pendingCommands"],
): boolean =>
	pendingCommands.some(
		(command) =>
			(command.deliveryPhase === undefined ||
				command.deliveryPhase === "leased" ||
				command.deliveryPhase === "applied") &&
			(command.kind === "messages.send" ||
				command.kind === "messages.queue.add" ||
				command.kind === "messages.queue.runNext" ||
				command.kind === "messages.queue.resume"),
	);

const latestConversationalRole = (
	projection: SessionTimelineProjection,
): "user" | "assistant" | null => {
	for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
		const role = projection.messages[index]?.role;
		if (role === "user" || role === "assistant") return role;
	}
	return null;
};

const pendingStartStillApplies = (
	view: ResourceView<SessionTimelineProjection>,
): boolean => {
	if (!hasPendingTurnStart(view.pendingCommands)) return false;
	if (view.data === null) return true;
	// A later assistant frame proves the submitted turn already settled even if
	// receipt persistence has not removed the client command overlay yet.
	return latestConversationalRole(view.data) !== "assistant";
};

const submissionKindsFor = (
	interaction: SessionInteraction,
): ReadonlyArray<string> =>
	interaction._tag === "Question"
		? ["session.answerQuestion", "session.cancelQuestion"]
		: ["permission.decide"];

const presentInteractions = (
	projection: SessionTimelineProjection | null,
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<PresentedSessionInteraction> => {
	if (projection === null) return [];
	return projection.interactions.map((interaction) => {
		const kinds = submissionKindsFor(interaction);
		const pending = view.pendingCommands.find(
			(command) =>
				kinds.includes(command.kind) && command.targetId === interaction.id,
		);
		if (pending !== undefined) {
			return { interaction, submission: "submitting", error: null };
		}
		const failed = view.failedCommands.find(
			(command) =>
				kinds.includes(command.kind) && command.targetId === interaction.id,
		);
		if (failed !== undefined) {
			return {
				interaction,
				submission: "failed",
				error: failed.error,
			};
		}
		return { interaction, submission: "pending", error: null };
	});
};

/**
 * The single presentation reducer for timeline-backed renderer surfaces.
 * Catalog status is a cold-start hint only: once a qualified cursor or
 * projection exists, it can never revive or settle the durable timeline.
 */
export const deriveSessionPresentation = ({
	view,
	catalogStatus,
	catalogRuntime,
}: {
	readonly view: ResourceView<SessionTimelineProjection>;
	readonly catalogStatus?: SessionStatus;
	readonly catalogRuntime?: SessionRuntimeState;
}): SessionPresentation => {
	const qualified =
		view.cursor !== null ||
		(view.data !== null &&
			(view.sync === "live" || view.data.currentTurn !== null));
	const catalogFallback =
		catalogRuntime ??
		(catalogStatus === undefined
			? "idle"
			: runtimeStateFromStatus(catalogStatus));
	let runtime =
		qualified && view.data !== null
			? runtimeStateFromTimeline(view.data)
			: !qualified
				? view.connection === "connected"
					? catalogFallback
					: "idle"
				: "idle";
	let pendingStartApplied = false;
	if (
		view.pendingCommands.some(
			(command) => command.kind === "messages.interrupt",
		) &&
		(view.data === null ||
			view.data.currentTurn !== null ||
			(!qualified && latestConversationalRole(view.data) !== "assistant") ||
			isSessionTurnActive(runtime))
	) {
		runtime = "stopping";
	} else if (runtime === "idle" && pendingStartStillApplies(view)) {
		runtime = "starting";
		pendingStartApplied = true;
	}

	const interactions = presentInteractions(view.data, view);
	const attention = interactions.some(
		(item) => item.interaction._tag === "Permission",
	)
		? "permission"
		: interactions.some((item) => item.interaction._tag === "Question")
			? "question"
			: isSessionRuntimeBusy(runtime)
				? "running"
				: "idle";

	return {
		runtime,
		busy: isSessionRuntimeBusy(runtime),
		turnActive: isSessionTurnActive(runtime),
		turnInFlight: isSessionTurnActive(runtime) || pendingStartApplied,
		attention,
		interactions,
	};
};
