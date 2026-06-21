import { FileChip } from "./file-chip.tsx";
import type { FileView } from "~/store/ui";

/**
 * Back-compat wrapper around `FileChip`. Tool rows pass the absolute path
 * the agent saw; the chip uses that as the display string (the tooltip
 * shows the full path) and opens it in the file editor on click. Pass
 * `view="diff"` from Edit/Write/MultiEdit rows so clicking the file lands
 * on the side-by-side diff instead of the CodeMirror editor.
 */
export function FileBadge({
  path,
  view,
  diffStats,
}: {
  path: string;
  view?: FileView;
  diffStats?: { readonly added: number; readonly removed: number };
}) {
  return (
    <FileChip relPath={path} absPath={path} view={view} diffStats={diffStats} />
  );
}
