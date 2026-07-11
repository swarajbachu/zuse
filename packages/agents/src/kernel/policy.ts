import {
	decidePermission,
	isSensitivePath,
	type PermissionVerdict,
} from "@zuse/agents/kernel/permission-policy";
import type { PermissionMode, RuntimeMode } from "@zuse/contracts";

/**
 * Shared permission policy helpers used by both SDK drivers (Claude, Codex)
 * and ACP drivers (Grok, Gemini, Cursor) for FileWrite / Bash decisions.
 *
 * The goal is a single source of truth for:
 *  - sensitive-path detection (always forces a prompt)
 *  - runtimeMode short-circuits (auto-accept-edits, full-access)
 *  - plan-mode handling (future)
 *
 * ACP FS handlers and terminal stubs import the FS-specific policy surface.
 * Claude/Codex can migrate their tool-centric policyFor() over time.
 */

// ---------------------------------------------------------------------------
// Sensitive paths (forcePrompt regardless of any prior allow decision)
// ---------------------------------------------------------------------------

// Sensitive-path matching and the runtime/permission decision table live in
// the provider-neutral agent kernel. This module only adapts kernel verdicts
// to the ACP handlers' historical `auto-allow | prompt` response shape.
// ---------------------------------------------------------------------------
// FS operation policy (used by ACP handleFsRequest)
// ---------------------------------------------------------------------------

export type FsOp = "read" | "write" | "create" | "delete" | "move";

type ProviderPolicy =
	| { readonly kind: "auto-allow" }
	| { readonly kind: "prompt"; readonly forcePrompt: boolean };

export type FsPolicy = ProviderPolicy;

const providerPolicy = (
	verdict: PermissionVerdict,
	forcePrompt: boolean,
): ProviderPolicy =>
	verdict === "allow"
		? { kind: "auto-allow" }
		: { kind: "prompt", forcePrompt };

/**
 * Decide whether an ACP FS mutation (or read) should prompt the user.
 *
 * Rules (mirrors the spirit of Claude's policyFor + sensitive checks):
 *  1. Sensitive paths → always prompt (forcePrompt: true), even in full-access.
 *  2. Pure reads → auto-allow.
 *  3. auto-accept-edits modes → non-sensitive writes/edits are auto-allowed.
 *  4. full-access → auto-allow anything that survived the sensitive check.
 *  5. plan mode (when passed) → we can force-deny or force-prompt (caller decides).
 *  6. default → prompt (forcePrompt: false).
 */
export const getFsPolicy = (
	op: FsOp,
	path: string,
	runtimeMode: RuntimeMode,
	permissionMode?: PermissionMode,
): FsPolicy => {
	const sensitive = path.length > 0 && isSensitivePath(path);
	return providerPolicy(
		decidePermission({
			runtimeMode,
			permissionMode: permissionMode ?? "default",
			category: op === "read" ? "read" : "edit",
			sensitive,
		}),
		sensitive || permissionMode === "plan",
	);
};

// ---------------------------------------------------------------------------
// Bash / terminal command policy (used by ACP handleTerminalRequest)
// ---------------------------------------------------------------------------

export type BashPolicy = ProviderPolicy;

/**
 * Decide whether an ACP terminal command should prompt the user.
 *
 * Mirrors Claude's `policyFor` handling of the Bash tool exactly so ACP
 * agents (Grok, Gemini, Cursor) get the same gating as the SDK drivers:
 *  1. plan mode → always prompt (forcePrompt) — never silently run commands.
 *  2. full-access → auto-allow.
 *  3. auto-accept-edits-and-bash → auto-allow.
 *  4. auto-accept-edits → still prompt. Unlike file edits, command execution
 *     is NOT auto-accepted in this mode.
 *  5. default (approval-required) → prompt (forcePrompt: false).
 *
 * Important: this policy does **not** path-scan `command` for sensitive
 * strings (`.env`, keys, etc.). A shell line that `ls`s another project
 * directory is not a "sensitive path". When `forcePrompt` is true for Bash,
 * the cause is plan mode (or a future per-command heuristic), never
 * `isSensitivePath`. The renderer must not label Bash force-prompts as
 * "Sensitive path" — that copy confuses Grok/ACP users in plan mode.
 *
 * `command` is accepted for future per-command heuristics (e.g. forcing a
 * prompt on obviously destructive commands) but is not inspected yet.
 */
export const getBashPolicy = (
	command: string,
	runtimeMode: RuntimeMode,
	permissionMode?: PermissionMode,
): BashPolicy => {
	void command;
	return providerPolicy(
		decidePermission({
			runtimeMode,
			permissionMode: permissionMode ?? "default",
			category: "execute",
			sensitive: false,
		}),
		permissionMode === "plan",
	);
};
