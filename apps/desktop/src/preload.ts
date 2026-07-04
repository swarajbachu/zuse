import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  IPC_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type UpdateStatus,
} from "@zuse/wire";

/**
 * Preload bridge — the only seam between the renderer and the main process.
 * Everything the renderer can do flows through Effect RPC over `IPC_CHANNEL`.
 *
 * `send` pushes encoded request frames toward main. `onMessage` registers a
 * listener for response frames from main and returns an unsubscribe handle.
 */
const bridge = {
  rpc: {
    send: (frame: string | Uint8Array) => {
      ipcRenderer.send(IPC_CHANNEL, frame);
    },
    onMessage: (handler: (frame: string | Uint8Array) => void) => {
      const wrapped = (_event: IpcRendererEvent, frame: string | Uint8Array) =>
        handler(frame);
      ipcRenderer.on(IPC_CHANNEL, wrapped);
      return () => {
        ipcRenderer.off(IPC_CHANNEL, wrapped);
      };
    },
  },
  window: {
    onFullScreenChange: (handler: (fullscreen: boolean) => void) => {
      const wrapped = (_event: IpcRendererEvent, value: boolean) =>
        handler(value);
      ipcRenderer.on("window:fullscreen", wrapped);
      return () => {
        ipcRenderer.off("window:fullscreen", wrapped);
      };
    },
    setAppearanceMode: (mode: "system" | "light" | "dark") => {
      ipcRenderer.send("window:setAppearanceMode", mode);
    },
  },
  browser: {
    /**
     * Renderer hands the agent-browser `<webview>`'s webContentsId to main so
     * main can attach Chrome DevTools Protocol once and dispatch real input
     * events into the embedded Chromium. Idempotent — safe to call on every
     * `dom-ready` (which fires on reload too).
     */
    registerWebview: (webContentsId: number) =>
      ipcRenderer.invoke(
        "browser:registerWebview",
        webContentsId,
      ) as Promise<boolean>,
    /**
     * Dispatch a single CDP input action against the registered webview. The
     * renderer animates the cursor overlay locally and calls this in sync
     * with the visual click pulse so what the user sees matches what the
     * page receives.
     */
    dispatchInput: (webContentsId: number, action: unknown) =>
      ipcRenderer.invoke(
        "browser:dispatchInput",
        webContentsId,
        action,
      ) as Promise<boolean>,
    /**
     * Allowlisted CDP passthrough (Accessibility/DOM/Runtime/Page) for the
     * v2 agent-browser tools — a11y snapshots, ref → coordinate resolution,
     * full-page capture, dialog handling. Main rejects anything off-list.
     */
    cdpCommand: (webContentsId: number, method: string, params?: unknown) =>
      ipcRenderer.invoke(
        "browser:cdpCommand",
        webContentsId,
        method,
        params ?? {},
      ) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
    /** Network requests captured since the last load (buffered in main). */
    getNetwork: (webContentsId: number, query?: unknown) =>
      ipcRenderer.invoke(
        "browser:getNetwork",
        webContentsId,
        query ?? {},
      ) as Promise<unknown>,
    /** Uncaught page exceptions captured via CDP since the last load. */
    getPageErrors: (webContentsId: number) =>
      ipcRenderer.invoke("browser:getPageErrors", webContentsId) as Promise<
        string[]
      >,
    /** The currently open JS dialog (alert/confirm/prompt), if any. */
    getDialogState: (webContentsId: number) =>
      ipcRenderer.invoke("browser:getDialogState", webContentsId) as Promise<{
        type: string;
        message: string;
        defaultPrompt?: string;
      } | null>,
  },
  app: {
    openExternal: (url: string) => {
      ipcRenderer.send("app:openExternal", url);
    },
    listOpenTargets: (path: string) =>
      ipcRenderer.invoke("app:listOpenTargets", path) as Promise<
        ReadonlyArray<{
          readonly id: string;
          readonly label: string;
          readonly available: boolean;
          readonly iconDataUrl?: string | null;
        }>
      >,
    openPathInApp: (path: string, appId: string) =>
      ipcRenderer.invoke("app:openPathInApp", path, appId) as Promise<void>,
    revealPath: (path: string) =>
      ipcRenderer.invoke("app:revealPath", path) as Promise<void>,
    copyPath: (path: string) =>
      ipcRenderer.invoke("app:copyPath", path) as Promise<void>,
    copyFileContents: (path: string) =>
      ipcRenderer.invoke("app:copyFileContents", path) as Promise<boolean>,
    getMainDiagnostics: () =>
      ipcRenderer.invoke("app:getMainDiagnostics") as Promise<
        ReadonlyArray<{
          readonly createdAt: string;
          readonly level: "debug" | "info" | "warn" | "error";
          readonly source: string;
          readonly message: string;
          readonly detail?: string;
        }>
      >,
  },
  updates: {
    onStatus: (handler: (status: UpdateStatus) => void) => {
      const wrapped = (_event: IpcRendererEvent, status: UpdateStatus) =>
        handler(status);
      ipcRenderer.on(UPDATE_STATUS_CHANNEL, wrapped);
      return () => {
        ipcRenderer.off(UPDATE_STATUS_CHANNEL, wrapped);
      };
    },
    check: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL) as Promise<void>,
    download: () =>
      ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL) as Promise<void>,
    installNow: () =>
      ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL) as Promise<void>,
    // Dev-only escape hatch: only handled in dev (see updater.ts
    // `registerUpdaterDemo`). Calling in a packaged build rejects harmlessly.
    __demoSet: (status: UpdateStatus) =>
      ipcRenderer.invoke("zuse:update-demo-set", status) as Promise<void>,
  },
  menu: {
    onAction: (handler: (action: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, action: string) =>
        handler(action);
      ipcRenderer.on("menu:action", wrapped);
      return () => {
        ipcRenderer.off("menu:action", wrapped);
      };
    },
    onCloseTab: (handler: () => void) => {
      const wrapped = () => handler();
      ipcRenderer.on("menu:close-tab", wrapped);
      return () => {
        ipcRenderer.off("menu:close-tab", wrapped);
      };
    },
    /**
     * Push the current accelerator map up to the main process so the native
     * menu re-installs with the user's overrides. Renderer calls this from
     * its keybindings store whenever the merged rule set changes.
     */
    setAccelerators: (accelerators: Record<string, string | null>) => {
      ipcRenderer.send("menu:setAccelerators", accelerators);
    },
  },
};

contextBridge.exposeInMainWorld("zuse", bridge);
contextBridge.exposeInMainWorld("memoize", bridge);
