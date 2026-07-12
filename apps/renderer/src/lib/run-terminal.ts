import type { ChatId } from "@zuse/contracts";

import {
  type TerminalInstance,
  terminalsKey,
  useTerminalsStore,
} from "../store/terminals.ts";
import { useUiStore } from "../store/ui.ts";

/**
 * Spawn a command-bound terminal (e.g. the project's Run script) and surface
 * it in the owning chat's right dock: append the instance to that chat's
 * terminal list, open a terminal panel pinned to the instance's exact list
 * index, activate it, and open the sidebar.
 *
 * Terminals are scoped per chat, so the caller passes the chat that should own
 * the run (the active chat for the top-bar Run button, or the worktree's chat
 * for auto-run after setup). Pinning the panel to the command instance's real
 * list index (rather than the auto-computed "next terminal panel" slot) is what
 * guarantees the new tab shows the command output instead of a blank shell.
 */
export function openTerminalCommand(args: {
  readonly chatId: ChatId;
  readonly cwd: string;
  readonly title: string;
  readonly command: NonNullable<TerminalInstance["command"]>;
}): void {
  const key = terminalsKey(args.chatId);
  const index = useTerminalsStore
    .getState()
    .addCommand(key, args.cwd, args.title, args.command);
  const ui = useUiStore.getState();
  ui.addTerminalPanelForSlot(args.chatId, index);
  ui.setRightSidebarOpen(true);
}
