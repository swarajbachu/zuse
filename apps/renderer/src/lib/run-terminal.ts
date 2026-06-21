import type { FolderId, WorktreeId } from "@memoize/wire";

import {
  type TerminalInstance,
  terminalsKey,
  useTerminalsStore,
} from "../store/terminals.ts";
import { useUiStore } from "../store/ui.ts";

/**
 * Spawn a command-bound terminal (e.g. the project's Run script) and surface
 * it in the right dock: append the instance, open a terminal panel pinned to
 * that instance's exact list index, activate it, and open the sidebar.
 *
 * Pinning the panel to the command instance's real list index (rather than the
 * auto-computed "next terminal panel" slot) is what guarantees the new tab
 * shows the command output instead of a blank shell, regardless of how many
 * plain terminals are already open.
 */
export function openTerminalCommand(args: {
  readonly folderId: FolderId;
  readonly worktreeId: WorktreeId | null;
  readonly cwd: string;
  readonly title: string;
  readonly command: NonNullable<TerminalInstance["command"]>;
}): void {
  const key = terminalsKey(args.folderId, args.worktreeId);
  const index = useTerminalsStore
    .getState()
    .addCommand(key, args.cwd, args.title, args.command);
  const ui = useUiStore.getState();
  ui.addTerminalPanelForSlot(index);
  ui.setRightSidebarOpen(true);
}
