import type { IconSvgElement } from "@hugeicons/react";
import {
  LockIcon,
  PencilEdit01Icon,
  SquareUnlock01Icon,
  TerminalIcon,
} from "@hugeicons-pro/core-solid-rounded";

import type { RuntimeMode } from "@zuse/contracts";

/**
 * Shared label/description/icon for each runtime mode. Used by the composer's
 * permission menu and the Settings page's "Default permission mode" radio
 * cards so they stay perfectly in sync.
 *
 * Descriptions spell out exactly which tools each mode skips and which it
 * still prompts on — the user feedback was that the previous one-line
 * copy left them guessing why `Auto-accept edits` still asked for Bash.
 */
export type ModeMeta = {
  readonly label: string;
  readonly description: string;
  readonly Icon: IconSvgElement;
};

export const MODE_META: Record<RuntimeMode, ModeMeta> = {
  "approval-required": {
    label: "Supervised",
    description:
      "Asks before every Bash, file edit, web request, or MCP call. Read-only tools (Read, Glob, Grep, LS) are always free.",
    Icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description:
      "Auto-allows Edit, Write, MultiEdit, NotebookEdit. Still asks for Bash, WebFetch/WebSearch, and other tools.",
    Icon: PencilEdit01Icon,
  },
  "auto-accept-edits-and-bash": {
    label: "Auto-accept edits + Bash",
    description:
      "Auto-allows edits and Bash commands. Still asks for WebFetch/WebSearch and other tools.",
    Icon: TerminalIcon,
  },
  "full-access": {
    label: "Full access",
    description:
      "Auto-allows everything. Plan mode and sensitive paths (.env, .ssh, credentials, keys) still prompt.",
    Icon: SquareUnlock01Icon,
  },
};

export const MODES_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto-accept-edits-and-bash",
  "full-access",
];
