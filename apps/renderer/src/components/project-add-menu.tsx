import { HugeiconsIcon } from "@hugeicons/react";
import { FileAddIcon, FolderOpenIcon, GlobeIcon } from "@hugeicons-pro/core-solid-rounded";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatShortcut } from "../lib/shortcuts.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { CloneRepoDialog } from "./clone-repo-dialog.tsx";
import { CreateProjectDialog } from "./create-project-dialog.tsx";
import { TooltipShortcut } from "./projects-sidebar.tsx";

/**
 * Replaces the bare `+` button in the projects sidebar with a three-way
 * popover, mirroring the screenshot:
 *
 *   • Open project       — existing pick-a-folder flow
 *   • Open GitHub project — clone a repo, then register it
 *   • Quick start        — scaffold a fresh project from a template
 *
 * The "Open project" item keeps the `Cmd+O` accelerator so the fast path
 * stays one keypress away; the other two are mouse-driven for v1.
 */
export function ProjectAddMenu() {
  const add = useWorkspaceStore((s) => s.add);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                aria-label="Add project"
              >
                <Plus className="size-3.5" strokeWidth={1.8} />
              </MenuTrigger>
            }
          />
          <TooltipPopup>
            <TooltipShortcut
              label="Add project"
              shortcut={formatShortcut("open-project")}
            />
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" className="min-w-[200px]">
          <MenuItem
            onClick={() => void add()}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
          >
            <HugeiconsIcon icon={FolderOpenIcon} className="size-3.5 text-muted-foreground" />
            Open project
          </MenuItem>
          <MenuItem
            onClick={() => setCloneOpen(true)}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
          >
            <HugeiconsIcon icon={GlobeIcon} className="size-3.5 text-muted-foreground" />
            Open GitHub project
          </MenuItem>
          <MenuItem
            onClick={() => setCreateOpen(true)}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
          >
            <HugeiconsIcon icon={FileAddIcon} className="size-3.5 text-muted-foreground" />
            Quick start
          </MenuItem>
        </MenuPopup>
      </Menu>

      <CloneRepoDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
