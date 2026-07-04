/**
 * App self-update lifecycle, broadcast from the main process to the renderer
 * and consumed by `UpdateBanner`. The main process drives `electron-updater`
 * manually (not `checkForUpdatesAndNotify`) so the renderer can show a
 * download/restart UI instead of relying on the system notification center.
 *
 * Channel name lives here so both sides import the same string.
 */
export const UPDATE_STATUS_CHANNEL = "zuse:update-status" as const;
export const UPDATE_CHECK_CHANNEL = "zuse:update-check" as const;
export const UPDATE_DOWNLOAD_CHANNEL = "zuse:update-download" as const;
export const UPDATE_INSTALL_CHANNEL = "zuse:update-install" as const;

export type UpdateStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | {
      readonly kind: "available";
      readonly version: string;
      readonly releaseNotes?: string;
      readonly releaseDate?: string;
    }
  | { readonly kind: "not-available" }
  | {
      readonly kind: "downloading";
      readonly percent: number;
      readonly bytesPerSecond: number;
    }
  | { readonly kind: "ready"; readonly version: string }
  | {
      readonly kind: "error";
      readonly message: string;
      // Stalls + transient network errors are retryable; signature/integrity
      // failures are not. Absent means retryable — banner and menu treat
      // `undefined` as "show Try Again". Set explicit `false` to suppress.
      readonly retryable?: boolean;
    };
