import { Context, type Effect } from "effect";

/**
 * Lets the server ask the host shell to open a "choose folder" dialog without
 * importing any UI toolkit. The Electron shim provides a live impl backed by
 * `dialog.showOpenDialog`; a future headless server provides a stub that
 * always resolves null (or surfaces the request to a connected client).
 *
 * Returns the chosen absolute path, or null if the user cancelled.
 */
export class FolderPicker extends Context.Service<
  FolderPicker,
  {
    readonly pick: () => Effect.Effect<string | null>;
  }
>()("memoize/FolderPicker") {}
