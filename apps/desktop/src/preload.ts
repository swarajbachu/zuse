import {
	AGENTS_RUNNING_COUNT_CHANNEL,
	IPC_CHANNEL,
	UPDATE_CHECK_CHANNEL,
	UPDATE_DOWNLOAD_CHANNEL,
	UPDATE_INSTALL_CHANNEL,
	UPDATE_STATUS_CHANNEL,
	type UpdateStatus,
} from "@zuse/contracts";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

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
	pairing: {
		onNearbyRequest: (handler: (request: unknown) => void) => {
			console.info("[zuse:pairing] preload.subscription.installed");
			const wrapped = (_event: IpcRendererEvent, request: unknown) => {
				console.info("[zuse:pairing] preload.request.received");
				handler(request);
			};
			ipcRenderer.on("pairing:nearby-request", wrapped);
			return () => {
				ipcRenderer.off("pairing:nearby-request", wrapped);
			};
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
		listLocalServers: () =>
			ipcRenderer.invoke("browser:listLocalServers") as Promise<
				ReadonlyArray<{ name: string; port: number }>
			>,
	},
	notch: {
		setItems: (items: unknown) => {
			ipcRenderer.send("notch:setItems", items);
		},
		setEnabled: (enabled: boolean) => {
			ipcRenderer.send("notch:setEnabled", enabled);
		},
		setPinned: (pinned: boolean) => {
			ipcRenderer.send("notch:setPinned", pinned);
		},
		setExpanded: (expanded: boolean) => {
			ipcRenderer.send("notch:setExpanded", expanded);
		},
		openChat: (chatId: string, sessionId: string) => {
			ipcRenderer.send("notch:openChat", chatId, sessionId);
		},
		getDisplaySupport: () =>
			ipcRenderer.invoke("notch:getDisplaySupport") as Promise<{
				readonly supported: boolean;
				readonly reason: "supported" | "not-macos" | "no-notched-display";
			}>,
		onDisplaySupportChanged: (
			handler: (support: {
				readonly supported: boolean;
				readonly reason: "supported" | "not-macos" | "no-notched-display";
			}) => void,
		) => {
			const wrapped = (
				_event: IpcRendererEvent,
				support: {
					readonly supported: boolean;
					readonly reason: "supported" | "not-macos" | "no-notched-display";
				},
			) => handler(support);
			ipcRenderer.on("notch:display-support", wrapped);
			return () => {
				ipcRenderer.off("notch:display-support", wrapped);
			};
		},
		onItems: (handler: (items: unknown) => void) => {
			const wrapped = (_event: IpcRendererEvent, items: unknown) =>
				handler(items);
			ipcRenderer.on("notch:items", wrapped);
			return () => {
				ipcRenderer.off("notch:items", wrapped);
			};
		},
		onPinned: (handler: (pinned: boolean) => void) => {
			const wrapped = (_event: IpcRendererEvent, pinned: boolean) =>
				handler(pinned);
			ipcRenderer.on("notch:pinned", wrapped);
			return () => {
				ipcRenderer.off("notch:pinned", wrapped);
			};
		},
		onOpenChat: (
			handler: (target: { chatId: string; sessionId: string }) => void,
		) => {
			const wrapped = (
				_event: IpcRendererEvent,
				target: { chatId: string; sessionId: string },
			) => handler(target);
			ipcRenderer.on("notch:openChat", wrapped);
			return () => {
				ipcRenderer.off("notch:openChat", wrapped);
			};
		},
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
	network: {
		getAccessState: () =>
			ipcRenderer.invoke("network:getAccessState") as Promise<
				import("@zuse/contracts").NetworkAccessState
			>,
		setAccessEnabled: (enabled: boolean) =>
			ipcRenderer.invoke("network:setAccessEnabled", enabled) as Promise<
				import("@zuse/contracts").NetworkAccessState
			>,
	},
	ssh: {
		listHosts: () =>
			ipcRenderer.invoke("ssh:listHosts") as Promise<ReadonlyArray<string>>,
		ensureEnvironment: (host: string) =>
			ipcRenderer.invoke("ssh:ensureEnvironment", host) as Promise<unknown>,
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
		/**
		 * Push the current running-agent count to main so the `before-quit` guard
		 * and the "quit/restart when idle" deferrals have a fresh value. Fire on
		 * every change (and once on mount). Renderer store is the source of truth.
		 */
		reportRunningCount: (count: number) => {
			ipcRenderer.send(AGENTS_RUNNING_COUNT_CHANNEL, count);
		},
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
