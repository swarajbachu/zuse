import { Context, type Effect } from "effect";

/**
 * One line in the permission-grant audit trail. Written verbatim as JSONL —
 * no aggregation, no rotation: the file is append-only so the record of
 * *which prompt produced which grant* survives crashes and restarts.
 *
 * `target` is the raw match key the decision applies to (shell command,
 * file path, URL, or `tool:summary` for unclassified tools). It is stored
 * unredacted, matching `permission_decisions.kind_json` and
 * `logs/permissions.log`, which already persist the same values — the
 * audit file lives in the same user-private data directory and adding a
 * second redaction scheme would only fork the meaning of "target".
 */
export interface PermissionAuditEntry {
	/** ISO timestamp of the decision write (not the prompt time). */
	readonly at: string;
	/** `PermissionRequest.id` — joins back to the `PermissionRequested` event. */
	readonly requestId: string;
	readonly sessionId: string;
	readonly chatId: string | null;
	readonly projectId: string | null;
	readonly worktreeId: string | null;
	readonly providerId: string | null;
	/** `PermissionKind._tag`: `FileWrite` | `Bash` | `Network` | `Other`. */
	readonly kind: string;
	/** Source tool for `Other` kinds (MCP / orchestration tool name), else null. */
	readonly tool: string | null;
	/** The verbatim `PermissionDecision._tag` the user picked. */
	readonly decision: "AllowOnce" | "AllowForSession" | "AlwaysAllow" | "Deny";
	/** Persistence scope the decision was saved under. */
	readonly scope: "session" | "folder" | "global";
	readonly target: string;
	/** True when the prompt forced a fresh choice (sensitive path / plan mode). */
	readonly forcePrompt: boolean;
	/** ISO timestamp of the original prompt, for lag forensics. */
	readonly requestedAt: string;
}

export interface PermissionAuditLogShape {
	/**
	 * Append one JSONL entry. Never fails — a broken audit sink must not
	 * break a permission grant, so implementations contain and log errors.
	 */
	readonly record: (entry: PermissionAuditEntry) => Effect.Effect<void>;
}

export class PermissionAuditLog extends Context.Service<
	PermissionAuditLog,
	PermissionAuditLogShape
>()("memoize/PermissionAuditLog") {}
