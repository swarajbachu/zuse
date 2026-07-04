import { useEffect } from "react";

import type { Command } from "@zuse/wire";

import type { MenuAction } from "../lib/bridge";
import { dispatchCommand } from "../lib/commands";
import { recordUiAction } from "../lib/diagnostics-recorder";
import { useUiStore } from "../store/ui";

/**
 * Subscribe to native Application Menu clicks emitted by the main process
 * and forward them through the central command dispatcher. The actual
 * handlers live in `lib/commands.ts` so the menu, the document keydown
 * listener, and (eventually) any future surface share one fan-in point.
 *
 * `MenuAction` is a structural subset of `Command`; the cast is safe so
 * long as we don't introduce menu items that aren't commands.
 */
export function useMenuShortcuts(): void {
  useEffect(() => {
    const menu = window.zuse?.menu;
    if (menu === undefined) return;

    const handle = (action: MenuAction) => {
      recordUiAction("menu.action", action);
      if (action === "export-diagnostics") {
        const ui = useUiStore.getState();
        ui.setSettingsSection({ kind: "diagnostics" });
        ui.setView("settings");
        return;
      }
      dispatchCommand(action as Command);
    };

    return menu.onAction(handle as (action: string) => void);
  }, []);
}
