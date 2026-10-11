import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";

import { AppPaths } from "../../app-paths.ts";
import {
	PermissionAuditLog,
	type PermissionAuditLogShape,
} from "../services/permission-audit.ts";

/**
 * Append-only JSONL audit trail of permission decisions at
 * `<userData>/audit/permission-grants.jsonl`. One line per decided request —
 * who asked (session/chat/project/worktree/provider), what was asked
 * (kind + target), and what the user chose (decision + scope).
 *
 * Plain append, no rotation: the codebase has no log-rotation convention for
 * userData diagnostics (`logs/permissions.log` grows the same way), and grant
 * decisions are rare user gestures, so volume stays trivial.
 *
 * `record` never fails. The append is best-effort: a full disk or a missing
 * directory must not block or break a permission grant, so failures are
 * logged at debug level and swallowed.
 */
export const PermissionAuditLogLive = Layer.effect(
	PermissionAuditLog,
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const filePath = join(paths.userData, "audit", "permission-grants.jsonl");

		const record: PermissionAuditLogShape["record"] = (entry) =>
			Effect.try({
				try: () => {
					mkdirSync(dirname(filePath), { recursive: true });
					appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
						// Only applies when the file is first created — keeps the audit
						// trail private to the OS user like other userData secrets.
						mode: 0o600,
					});
				},
				catch: (cause) => cause,
			}).pipe(
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.logDebug(
						`[PermissionAuditLog] append failed: ${String(cause)}`,
					),
				),
			);

		return { record } as const;
	}),
);
