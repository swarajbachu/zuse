import {
	decidePermission,
	isSensitivePath,
	type PermissionVerdict,
	type ToolCategory,
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
// to the ACP handlers' `auto-allow | auto-deny | prompt` response shape.
// ---------------------------------------------------------------------------
// FS operation policy (used by ACP handleFsRequest)
// ---------------------------------------------------------------------------

export type FsOp = "read" | "write" | "create" | "delete" | "move";

export type ProviderPolicy =
	| { readonly kind: "auto-allow" }
	| { readonly kind: "auto-deny" }
	| { readonly kind: "prompt"; readonly forcePrompt: boolean };

export type FsPolicy = ProviderPolicy;

const providerPolicy = (
	verdict: PermissionVerdict,
	forcePrompt: boolean,
): ProviderPolicy =>
	verdict === "allow"
		? { kind: "auto-allow" }
		: verdict === "deny"
			? { kind: "auto-deny" }
			: { kind: "prompt", forcePrompt };

export const getToolPolicy = (
	category: ToolCategory,
	runtimeMode: RuntimeMode,
	permissionMode?: PermissionMode,
): ProviderPolicy =>
	providerPolicy(
		decidePermission({
			runtimeMode,
			permissionMode: permissionMode ?? "default",
			category,
			sensitive: false,
		}),
		false,
	);

/**
 * Decide whether an ACP FS mutation (or read) should prompt the user.
 *
 * Rules (mirrors the spirit of Claude's policyFor + sensitive checks):
 *  1. Sensitive paths → always prompt (forcePrompt: true), even in full-access.
 *  2. Pure reads → auto-allow.
 *  3. auto-accept-edits modes → non-sensitive writes/edits are auto-allowed.
 *  4. full-access → auto-allow anything that survived the sensitive check.
 *  5. plan mode → deny mutations without prompting.
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

const SIMPLE_READ_ONLY_COMMANDS = new Set([
	"cat",
	"du",
	"grep",
	"head",
	"ls",
	"pwd",
	"stat",
	"tail",
	"wc",
]);

/** Conservative allow-list for shell-based codebase inspection in plan mode. */
export const isReadOnlyShellCommand = (command: string): boolean => {
	const trimmed = command.trim();
	if (
		trimmed.length === 0 ||
		/[;&|><\n\r`]/.test(trimmed) ||
		trimmed.includes("$(")
	) {
		return false;
	}

	const words = trimmed.split(/\s+/);
	if (
		words.some((word) => {
			const unquoted = word.replace(/^['"]|['"]$/g, "");
			const optionValue = unquoted.includes("=")
				? unquoted.slice(unquoted.indexOf("=") + 1)
				: unquoted;
			return isSensitivePath(unquoted) || isSensitivePath(optionValue);
		})
	) {
		return false;
	}
	if (
		words.some((word) => word === "--output" || word.startsWith("--output="))
	) {
		return false;
	}
	const executable = words[0];
	if (executable === undefined) return false;
	if (SIMPLE_READ_ONLY_COMMANDS.has(executable)) return true;
	if (executable !== "rg") return false;
	return !words.some(
		(word) =>
			word === "--hidden" ||
			word === "--no-ignore" ||
			word.startsWith("--no-ignore-") ||
			word === "--pre" ||
			word.startsWith("--pre=") ||
			/^-u{1,3}$/.test(word),
	);
};

/**
 * Decide whether an ACP terminal command should prompt the user.
 *
 * Mirrors Claude's `policyFor` handling of the Bash tool exactly so ACP
 * agents (Grok, Gemini, Cursor) get the same gating as the SDK drivers:
 *  1. plan mode → allow a conservative set of read-only inspection commands
 *     and deny everything else without prompting.
 *  2. full-access → auto-allow.
 *  3. auto-accept-edits-and-bash → auto-allow.
 *  4. auto-accept-edits → still prompt. Unlike file edits, command execution
 *     is NOT auto-accepted in this mode.
 *  5. default (approval-required) → prompt (forcePrompt: false).
 *
 * The plan-mode allow-list rejects shell composition, output redirection,
 * mutating command variants, and sensitive path strings. Unknown commands are
 * denied rather than guessed safe.
 */
export const getBashPolicy = (
	command: string,
	runtimeMode: RuntimeMode,
	permissionMode?: PermissionMode,
): BashPolicy => {
	if (permissionMode === "plan" && isReadOnlyShellCommand(command)) {
		return { kind: "auto-allow" };
	}
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
