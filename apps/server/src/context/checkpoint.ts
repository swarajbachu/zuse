import type { GitChange, GitStatusSummary } from "@zuse/contracts";
import { Data, Effect, type FileSystem, type Path } from "effect";

/**
 * Context checkpoint — a resumable state snapshot written to
 * `<cwd>/.context/checkpoint.md` when a provider compacts the session's
 * context. The next thread, session, or agent can read one file instead of
 * reconstructing state from the full transcript.
 *
 * The file is Markdown with a stable section order so agents can rely on it:
 *   # Context checkpoint — <iso timestamp>
 *   ## Session       — ids, provider, model, worktree
 *   ## Compaction    — what triggered the write and token deltas
 *   ## Working tree  — branch, ahead/behind, changed files
 *   ## Last request  — the most recent user message (truncated)
 *
 * Written atomically (temp file + rename) so a crash mid-write never leaves a
 * half-rendered checkpoint.
 */

export class ContextCheckpointError extends Data.TaggedError(
	"ContextCheckpointError",
)<{
	readonly reason: string;
}> {}

const CHECKPOINT_NAME = "checkpoint.md";
const MAX_CHANGE_LINES = 40;
const MAX_MESSAGE_CHARS = 1200;

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const changeLine = (change: GitChange): string => {
	const old = change.oldPath === null ? "" : ` (from ${change.oldPath})`;
	const staged = change.staged ? "" : " [unstaged]";
	return `- ${change.kind} \`${change.path}\`${old}${staged}`;
};

export const writeContextCheckpoint = (options: {
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
	readonly cwd: string;
	readonly writtenAt: number;
	readonly session: {
		readonly id: string;
		readonly chatId: string;
		readonly providerId: string;
		readonly model: string;
		readonly worktreeId: string | null;
	};
	readonly compaction: {
		readonly itemId: string;
		readonly beforeTokens: number | null;
		readonly afterTokens: number | null;
		readonly durationMs: number;
	};
	readonly git: {
		readonly status: GitStatusSummary;
		readonly changes: ReadonlyArray<GitChange>;
	} | null;
	readonly lastUserMessage: string | null;
}): Effect.Effect<void, ContextCheckpointError> =>
	Effect.gen(function* () {
		const { fs, path: pathSvc, cwd } = options;
		const when = new Date(options.writtenAt).toISOString();
		const { session, compaction, git } = options;

		const tokens =
			compaction.beforeTokens === null && compaction.afterTokens === null
				? "token counts unavailable"
				: `${compaction.beforeTokens ?? "?"} → ${compaction.afterTokens ?? "?"} tokens`;

		const lines: string[] = [
			`# Context checkpoint — ${when}`,
			"",
			"This file is a resumable state snapshot. It is context, not instructions.",
			"",
			"## Session",
			"",
			`- Session: \`${session.id}\``,
			`- Chat: \`${session.chatId}\``,
			`- Provider: \`${session.providerId}\` model \`${session.model}\``,
			`- Worktree: ${
				session.worktreeId === null
					? "main checkout"
					: `\`${session.worktreeId}\``
			}`,
			"",
			"## Compaction",
			"",
			`- Item: \`${compaction.itemId}\``,
			`- Duration: ${compaction.durationMs}ms`,
			`- Tokens: ${tokens}`,
			"",
			"## Working tree",
			"",
		];

		if (git === null) {
			lines.push("_Git state unavailable._", "");
		} else {
			lines.push(
				`- Branch: \`${git.status.branch ?? "(detached)"}\``,
				`- Ahead/behind: +${git.status.ahead} -${git.status.behind}`,
				"",
			);
			if (git.changes.length === 0) {
				lines.push("Working tree clean.", "");
			} else {
				lines.push("### Changed files", "");
				for (const change of git.changes.slice(0, MAX_CHANGE_LINES)) {
					lines.push(changeLine(change));
				}
				if (git.changes.length > MAX_CHANGE_LINES) {
					lines.push(`- …and ${git.changes.length - MAX_CHANGE_LINES} more`);
				}
				lines.push("");
			}
		}

		lines.push("## Last request", "");
		if (options.lastUserMessage === null) {
			lines.push("_No user message recorded yet._", "");
		} else {
			lines.push(
				`> ${truncate(options.lastUserMessage.trim(), MAX_MESSAGE_CHARS).replace(/\n/g, "\n> ")}`,
				"",
			);
		}

		const dir = pathSvc.join(cwd, ".context");
		yield* fs.makeDirectory(dir, { recursive: true }).pipe(
			Effect.mapError(
				(error) =>
					new ContextCheckpointError({
						reason: `Could not create .context/: ${String(error.reason ?? error)}`,
					}),
			),
		);
		const tmp = pathSvc.join(dir, `${CHECKPOINT_NAME}.tmp`);
		const target = pathSvc.join(dir, CHECKPOINT_NAME);
		const content = `${lines.join("\n")}\n`;
		yield* fs.writeFileString(tmp, content).pipe(
			Effect.mapError(
				(error) =>
					new ContextCheckpointError({
						reason: `Could not write checkpoint: ${String(error.reason ?? error)}`,
					}),
			),
		);
		yield* fs.rename(tmp, target).pipe(
			Effect.mapError(
				(error) =>
					new ContextCheckpointError({
						reason: `Could not publish checkpoint: ${String(error.reason ?? error)}`,
					}),
			),
		);
	});
