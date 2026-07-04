import type { PermissionMode, RuntimeMode } from "@zuse/wire";

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

/**
 * Path patterns that always prompt regardless of any prior `AllowForSession`
 * or `AlwaysAllow` decision. Match anywhere in the path string — agents
 * tend to use absolute paths, so anchoring to a directory boundary catches
 * `~/.ssh/...` and `/path/to/repo/.env` alike.
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)credentials(\.[^/]+)?$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
];

export const isSensitivePath = (p: string): boolean =>
  SENSITIVE_PATTERNS.some((re) => re.test(p));

// ---------------------------------------------------------------------------
// FS operation policy (used by ACP handleFsRequest)
// ---------------------------------------------------------------------------

export type FsOp = "read" | "write" | "create" | "delete" | "move";

export type FsPolicy =
  | { readonly kind: "auto-allow" }
  | { readonly kind: "prompt"; readonly forcePrompt: boolean };

/**
 * Decide whether an ACP FS mutation (or read) should prompt the user.
 *
 * Rules (mirrors the spirit of Claude's policyFor + sensitive checks):
 *  1. Sensitive paths → always prompt (forcePrompt: true), even in full-access.
 *  2. Pure reads → auto-allow.
 *  3. auto-accept-edits → non-sensitive writes/edits are auto-allowed.
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
  const isMutating = op !== "read";

  // 1. Sensitive path wins over every runtime/permission mode.
  if (path.length > 0 && isSensitivePath(path)) {
    return { kind: "prompt", forcePrompt: true };
  }

  // 2. Reads are always free (unless they hit a sensitive path above).
  if (op === "read") {
    return { kind: "auto-allow" };
  }

  // 3. Plan mode — caller (the ACP driver) can decide to treat this as
  //    a hard deny or a forced prompt. We surface "prompt" so the UI can
  //    show plan-mode context if desired.
  if (permissionMode === "plan") {
    return { kind: "prompt", forcePrompt: true };
  }

  // 4. auto-accept-edits — only non-sensitive file mutations are auto-allowed.
  if (runtimeMode === "auto-accept-edits" && isMutating) {
    return { kind: "auto-allow" };
  }

  // 5. full-access — auto-allow any surviving mutation.
  if (runtimeMode === "full-access") {
    return { kind: "auto-allow" };
  }

  // 6. Default (approval-required + non-sensitive mutation) → prompt.
  return { kind: "prompt", forcePrompt: false };
};

// ---------------------------------------------------------------------------
// Bash / terminal command policy (used by ACP handleTerminalRequest)
// ---------------------------------------------------------------------------

export type BashPolicy =
  | { readonly kind: "auto-allow" }
  | { readonly kind: "prompt"; readonly forcePrompt: boolean };

/**
 * Decide whether an ACP terminal command should prompt the user.
 *
 * Mirrors Claude's `policyFor` handling of the Bash tool exactly so ACP
 * agents (Grok, Gemini, Cursor) get the same gating as the SDK drivers:
 *  1. plan mode → always prompt (forcePrompt) — never silently run commands.
 *  2. full-access → auto-allow.
 *  3. auto-accept-edits → still prompt. Unlike file edits, command execution
 *     is NOT auto-accepted in this mode (matches Claude: only FILE_EDIT_TOOLS
 *     skip the prompt under auto-accept-edits, Bash falls through).
 *  4. default (approval-required) → prompt (forcePrompt: false).
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

  // 1. Plan mode never silently runs commands.
  if (permissionMode === "plan") {
    return { kind: "prompt", forcePrompt: true };
  }

  // 2. full-access — auto-allow anything.
  if (runtimeMode === "full-access") {
    return { kind: "auto-allow" };
  }

  // 3. auto-accept-edits — commands still prompt (only file edits are auto-
  //    accepted in this mode, matching Claude).
  // 4. Default — prompt.
  return { kind: "prompt", forcePrompt: false };
};
