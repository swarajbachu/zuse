import type { UpdateStatus } from "@zuse/wire";

/**
 * Shape of the preload bridge that the main process exposes onto
 * `window.zuse`. The renderer's RPC client transport reads/writes raw
 * encoded RPC frames; serialization + framing happen at the Effect RPC layer.
 */
export interface RpcBridge {
  readonly send: (frame: string | Uint8Array) => void;
  readonly onMessage: (
    handler: (frame: string | Uint8Array) => void,
  ) => () => void;
}

export interface WindowBridge {
  readonly onFullScreenChange: (
    handler: (fullscreen: boolean) => void,
  ) => () => void;
  readonly setAppearanceMode?: (mode: "system" | "light" | "dark") => void;
}

export interface AppBridge {
  readonly openExternal: (url: string) => void;
  readonly listOpenTargets?: (
    path: string,
  ) => Promise<ReadonlyArray<OpenTarget>>;
  readonly openPathInApp?: (path: string, appId: string) => Promise<void>;
  readonly revealPath?: (path: string) => Promise<void>;
  readonly copyPath?: (path: string) => Promise<void>;
  readonly copyFileContents?: (path: string) => Promise<boolean>;
  readonly getMainDiagnostics?: () => Promise<ReadonlyArray<DiagnosticLogEntry>>;
}

export interface DiagnosticLogEntry {
  readonly createdAt: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
  readonly detail?: string;
}

export interface OpenTarget {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly iconDataUrl?: string | null;
}

export interface UpdatesBridge {
  readonly onStatus: (handler: (status: UpdateStatus) => void) => () => void;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly installNow: () => Promise<void>;
  /** Dev-only: round-trips a synthetic status through the real IPC channel. */
  readonly __demoSet?: (status: UpdateStatus) => Promise<void>;
}

/**
 * Action ids the main process emits when the user picks an item in the
 * native Application Menu. The renderer subscribes via `menu.onAction` and
 * dispatches to the appropriate store — see `use-menu-shortcuts.ts`.
 */
export type MenuAction =
  | "new-chat"
  | "open-project"
  | "settings"
  | "export-diagnostics"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "toggle-terminal"
  | "focus-composer";

export interface MenuBridge {
  readonly onAction: (handler: (action: MenuAction) => void) => () => void;
  /**
   * Cmd+W on the native menu fires a dedicated signal — kept separate from
   * the generic action stream because close-tab is a renderer-side
   * imperative (archive the active tab + maybe spawn a fresh one) rather
   * than a navigation intent.
   */
  readonly onCloseTab: (handler: () => void) => () => void;
  /**
   * Push the current resolved accelerator map up to the main process so the
   * native menu re-installs with the user's overrides. `null` for a command
   * means "unbound — drop the accelerator from the menu item entirely."
   * Renderer fires this from its keybindings store on every change.
   */
  readonly setAccelerators?: (
    accelerators: Readonly<Record<string, string | null>>,
  ) => void;
}

/**
 * Discriminated union of CDP input actions the renderer can dispatch into the
 * registered agent-browser webview. Mirrors `Input.dispatchMouseEvent` /
 * `Input.dispatchKeyEvent` payloads, narrowed to the fields we actually use.
 * The wire types are intentionally loose (`unknown`) at the IPC boundary; this
 * is the strict shape the renderer holds.
 */
export type BrowserInputAction =
  | {
      readonly type: "mouseMove" | "mousePressed" | "mouseReleased";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "right" | "middle" | "none";
      readonly clickCount?: number;
    }
  | {
      readonly type: "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX?: number;
      readonly deltaY?: number;
    }
  | {
      readonly type: "keyDown" | "keyUp" | "char";
      readonly key: string;
      readonly text?: string;
      readonly code?: string;
      readonly windowsVirtualKeyCode?: number;
    }
  | { readonly type: "insertText"; readonly text: string };

export interface BrowserBridge {
  /**
   * Attach Chrome DevTools Protocol to the embedded webview's webContents so
   * subsequent `dispatchInput` calls deliver real mouse/keyboard input.
   * Idempotent — safe to call on every `dom-ready`.
   */
  readonly registerWebview: (webContentsId: number) => Promise<boolean>;
  /** Send a single CDP input action. Returns false if not registered yet. */
  readonly dispatchInput: (
    webContentsId: number,
    action: BrowserInputAction,
  ) => Promise<boolean>;
}

export interface ZuseBridge {
  readonly rpc: RpcBridge;
  readonly window?: WindowBridge;
  readonly menu?: MenuBridge;
  readonly app?: AppBridge;
  readonly updates?: UpdatesBridge;
  readonly browser?: BrowserBridge;
}

declare global {
  interface Window {
    zuse?: ZuseBridge;
    /** Legacy alias exposed for compatibility with pre-Zuse dev helpers. */
    memoize?: ZuseBridge;
  }
}

export function getBridge(): ZuseBridge {
  const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
  if (!bridge) {
    throw new Error(
      "zuse bridge missing — preload.ts did not load. Are we running outside Electron?",
    );
  }
  return bridge;
}
