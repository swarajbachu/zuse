import type {
	CloudCommandBlockedReason,
	CloudCommandState,
	CommandId,
	EnvironmentId,
} from "@zuse/contracts";

export type ConnectionPhase =
	| "dormant"
	| "offline"
	| "waking"
	| "connecting"
	| "reconnecting"
	| "connected"
	| "blocked-auth"
	| "update-required"
	| "revoked"
	| "failed";

export type SyncPhase =
	| "empty"
	| "hydrating-cache"
	| "cached"
	| "synchronizing"
	| "live"
	| "stale"
	| "failed";

export type SurfacePhase =
	| "initial-loading"
	| "cached"
	| "waking"
	| "connecting"
	| "synchronizing"
	| "live"
	| "offline-stale"
	| "blocked-auth"
	| "update-required"
	| "error";

export type ResourceOrigin = "none" | "cache" | "checkpoint" | "runtime";

export type ResourceCursor = Readonly<{
	epoch: string;
	version: number;
}>;

export type PendingCommand = Readonly<{
	commandId: CommandId;
	/** Stable command family used by selectors for immediate optimistic state. */
	kind: string;
	submittedAt: number;
	deliveryPhase?: "persisting" | CloudCommandState;
	category?: string;
	blockedUntil?: CloudCommandBlockedReason;
	cancellable?: boolean;
}>;

export type FailedCommand = Readonly<{
	commandId: CommandId;
	kind: string;
	failedAt: number;
	error: string;
	retryable: boolean;
	/** Preserves authoritative mailbox semantics through the client/UI boundary. */
	terminal?: Readonly<{
		state: CloudCommandState;
		category?: string;
	}>;
}>;

export type ResourceView<Data> = Readonly<{
	data: Data | null;
	origin: ResourceOrigin;
	connection: ConnectionPhase;
	sync: SyncPhase;
	generation: number;
	cursor: ResourceCursor | null;
	pendingCommands: readonly PendingCommand[];
	failedCommands: readonly FailedCommand[];
}>;

export type ConnectionView = Readonly<{
	environmentId: EnvironmentId;
	phase: ConnectionPhase;
	generation: number;
	error: string | null;
}>;

export const emptyResourceView = <Data>(
	connection: ConnectionPhase = "dormant",
): ResourceView<Data> => ({
	data: null,
	origin: "none",
	connection,
	sync: "empty",
	generation: 0,
	cursor: null,
	pendingCommands: [],
	failedCommands: [],
});

export const deriveSurfacePhase = <Data>(
	view: ResourceView<Data>,
): SurfacePhase => {
	if (view.connection === "blocked-auth") return "blocked-auth";
	if (view.connection === "update-required") return "update-required";

	if (view.data !== null) {
		if (
			view.connection === "offline" ||
			view.connection === "reconnecting" ||
			view.connection === "revoked" ||
			view.connection === "failed" ||
			view.sync === "stale" ||
			view.sync === "failed"
		) {
			return "offline-stale";
		}
		if (view.connection === "waking") return "waking";
		if (view.connection === "connecting") return "connecting";
		if (view.sync === "synchronizing") return "synchronizing";
		if (view.sync === "live") return "live";
		return "cached";
	}

	if (view.connection === "waking") return "waking";
	if (view.connection === "connecting" || view.connection === "reconnecting") {
		return "connecting";
	}
	if (view.sync === "synchronizing") return "synchronizing";
	if (
		view.connection === "offline" ||
		view.connection === "revoked" ||
		view.connection === "failed" ||
		view.sync === "failed" ||
		view.sync === "stale"
	) {
		return "error";
	}
	return "initial-loading";
};
