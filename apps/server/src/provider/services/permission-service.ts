import type {
	DeviceCommand,
	DeviceCommandDecision,
	DeviceCommandGrant,
	FolderId,
	PermissionDecision,
	PermissionKind,
	PermissionRequest,
	PermissionRequestChange,
	PermissionRequestExpiredError,
	PermissionRequestNotFoundError,
	SavedDecision,
	SessionId,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

/**
 * Bridge between provider drivers (which call `request` from inside their
 * SDK permission callback) and the renderer (which subscribes to `requests`,
 * shows a toast, then calls `decide`).
 *
 * `request` blocks the driver until a decision is made or the session
 * tears down. `decide` resolves whichever deferred is keyed by `requestId`.
 * `listPending` lets a freshly-mounted UI hydrate without waiting for the
 * next stream message.
 *
 * "Allow for session" is enforced inside `request` itself: before publishing
 * a new `PermissionRequest` we look up `permission_decisions` for an
 * existing `AllowForSession` row matching `(sessionId, kindTag, kindKey)`,
 * and short-circuit with an `AllowOnce` decision when one exists. This
 * mirrors the SDK's own session-scoped suppression and keeps the prompt
 * stream quiet for repeat tool calls within a session.
 */
/**
 * Options for `request`. `projectId` is required so folder-scoped
 * `AlwaysAllow` rows can short-circuit a re-prompt across sessions in the
 * same project. `forcePrompt` skips the existing-decision lookup entirely —
 * the driver sets it for sensitive paths so prior `AllowForSession` /
 * `AlwaysAllow` decisions can't silence them.
 */
export interface RequestOptions {
	readonly projectId: FolderId;
	readonly forcePrompt?: boolean;
}

export interface PermissionServiceShape {
	readonly request: (
		sessionId: SessionId,
		kind: PermissionKind,
		options: RequestOptions,
	) => Effect.Effect<PermissionDecision>;

	readonly decide: (
		requestId: string,
		decision: PermissionDecision,
	) => Effect.Effect<
		void,
		PermissionRequestNotFoundError | PermissionRequestExpiredError
	>;

	readonly listPending: (
		sessionId: SessionId,
	) => Effect.Effect<ReadonlyArray<PermissionRequest>>;

	readonly requests: () => Stream.Stream<PermissionRequestChange>;

	/**
	 * Inspector queries. `listDecisions` returns persisted decisions filtered
	 * by project (or all when no filter is given). `revokeDecision` deletes a
	 * single row by `requestId` so the next matching tool call re-prompts.
	 */
	readonly listDecisions: (filter: {
		readonly projectId?: FolderId;
	}) => Effect.Effect<ReadonlyArray<SavedDecision>>;

	readonly revokeDecision: (requestId: string) => Effect.Effect<void>;
}

export class PermissionService extends Context.Service<
	PermissionService,
	PermissionServiceShape
>()("memoize/PermissionService") {}

/** Device grants deliberately have no relationship to provider Bash/full-access policy. */
export interface DevicePermissionStore {
	readonly grants: () => Promise<ReadonlyArray<DeviceCommandGrant>>;
	readonly saveGrant: (grant: DeviceCommandGrant) => Promise<void>;
	readonly deleteGrant: (id: string) => Promise<void>;
	readonly clearGrants: () => Promise<void>;
}
export const deviceGrantMatches = (
	grant: DeviceCommandGrant,
	command: DeviceCommand,
): boolean =>
	grant.accountId === command.accountId &&
	grant.deviceId === command.deviceId &&
	(grant.chatId === null ||
		(grant.chatId === command.chatId &&
			grant.grantEpoch === command.grantEpoch));

/** Shared permission authority for foreign cloud chats, which have no local session row. */
export class DevicePermissionAuthority {
	constructor(private readonly store: DevicePermissionStore) {}
	list() {
		return this.store.grants();
	}
	clear() {
		return this.store.clearGrants();
	}
	async allows(command: DeviceCommand): Promise<boolean> {
		return (await this.list()).some((grant) =>
			deviceGrantMatches(grant, command),
		);
	}
	async remember(
		command: DeviceCommand,
		decision: DeviceCommandDecision,
	): Promise<void> {
		if (decision !== "AllowForSession" && decision !== "AlwaysAllow") return;
		const chatId = decision === "AlwaysAllow" ? null : command.chatId;
		await this.store.saveGrant({
			id: JSON.stringify([command.accountId, command.deviceId, chatId]),
			accountId: command.accountId,
			deviceId: command.deviceId,
			grantEpoch: command.grantEpoch,
			chatId,
			createdAt: Date.now(),
		});
	}
	async revoke(id: string, accountId?: string): Promise<DeviceCommandGrant> {
		const grant = (await this.list()).find(
			(grant) =>
				grant.id === id &&
				(accountId === undefined || grant.accountId === accountId),
		);
		if (!grant) throw new Error("Permission not found");
		await this.store.deleteGrant(id);
		return grant;
	}
}
