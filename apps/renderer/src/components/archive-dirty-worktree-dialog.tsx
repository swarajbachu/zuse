import { useCallback, useEffect, useRef, useState } from "react";

import {
  resetArchiveDirtyConfirm,
  setArchiveDirtyConfirm,
} from "../store/chats.ts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button";

export function ArchiveDirtyWorktreeDialogHost() {
  const [open, setOpen] = useState(false);
  const pendingResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const resolvePending = useCallback((confirmed: boolean) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setOpen(false);
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    setArchiveDirtyConfirm(
      () =>
        new Promise<boolean>((resolve) => {
          pendingResolveRef.current?.(false);
          pendingResolveRef.current = resolve;
          setOpen(true);
        }),
    );

    return () => {
      pendingResolveRef.current?.(false);
      pendingResolveRef.current = null;
      resetArchiveDirtyConfirm();
    };
  }, []);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true);
          return;
        }
        resolvePending(false);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard worktree changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This chat's worktree has uncommitted changes. Archiving can discard
            those local changes and remove the checkout while preserving the
            branch.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            variant="destructive"
            onClick={() => resolvePending(true)}
          >
            Discard changes and archive
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
