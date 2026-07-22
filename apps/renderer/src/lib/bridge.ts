import type {
	NearbyPairingRequest,
	NetworkAccessState,
	UpdateStatus,
} from "@zuse/contracts";

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

export interface PairingBridge {
	readonly onNearbyRequest: (
		handler: (request: NearbyPairingRequest) => void,
	) => () => void;
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
	readonly getMainDiagnostics?: () => Promise<
		ReadonlyArray<DiagnosticLogEntry>
	>;
}

export interface NetworkBridge {
	readonly getAccessState: () => Promise<NetworkAccessState>;
	readonly setAccessEnabled: (enabled: boolean) => Promise<NetworkAccessState>;
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
	/**
	 * Push the current running-agent count to main (for the before-quit guard
	 * and "quit/restart when idle" deferrals). Renderer store is the source of
	 * truth; call on every change.
	 */
	readonly reportRunningCount: (count: number) => void;
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

/** Outcome of an allowlisted CDP call routed through main. */
export interface CdpCommandOutcome {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

/** One network request summary from main's CDP Network buffer. */
export interface NetworkRequestSummary {
	readonly id: string;
	readonly method: string;
	readonly url: string;
	readonly resourceType?: string;
	readonly status?: number;
	readonly mimeType?: string;
	readonly failed?: string;
}

export interface NetworkRequestDetail extends NetworkRequestSummary {
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly bodyBase64?: boolean;
}

export type NetworkQueryResult =
	| { readonly requests: ReadonlyArray<NetworkRequestSummary> }
	| { readonly detail: NetworkRequestDetail }
	| null;

export interface BrowserDialogState {
	readonly type: string;
	readonly message: string;
	readonly defaultPrompt?: string;
}

export interface BrowserCookieImportStatus {
	readonly supported: boolean;
	readonly source?: string;
	readonly profile?: string;
	readonly lastImportTime?: string;
	readonly importedDomainCount: number;
	readonly importedCookieCount: number;
	readonly importedDomains: ReadonlyArray<string>;
	readonly message?: string;
}

export interface LocalServerSummary {
	readonly name: string;
	readonly port: number;
}

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
	/**
	 * Allowlisted CDP passthrough (Accessibility/DOM/Runtime/Page). Optional —
	 * absent on preload builds that predate agent-browser v2, so callers must
	 * fall back to the injected-JS paths when undefined.
	 */
	readonly cdpCommand?: (
		webContentsId: number,
		method: string,
		params?: unknown,
	) => Promise<CdpCommandOutcome>;
	readonly startScreencast?: (webContentsId: number) => Promise<boolean>;
	readonly stopScreencast?: (webContentsId: number) => Promise<boolean>;
	readonly onScreencastFrame?: (
		handler: (frame: {
			readonly webContentsId: number;
			readonly data: string;
		}) => void,
	) => () => void;
	readonly onScreencastInterrupted?: (
		handler: (webContentsId: number) => void,
	) => () => void;
	/** Network requests captured since the last load (buffered in main). */
	readonly getNetwork?: (
		webContentsId: number,
		query?: { filter?: string; id?: string },
	) => Promise<NetworkQueryResult>;
	/** Uncaught page exceptions captured via CDP since the last load. */
	readonly getPageErrors?: (webContentsId: number) => Promise<string[]>;
	/** The currently open JS dialog, if any. */
	readonly getDialogState?: (
		webContentsId: number,
	) => Promise<BrowserDialogState | null>;
	readonly listLocalServers?: () => Promise<ReadonlyArray<LocalServerSummary>>;
	readonly saveRecording?: (
		bytes: Uint8Array,
		mimeType: string,
		durationMs: number,
	) => Promise<{
		readonly id: string;
		readonly type: string;
		readonly size: number;
		readonly durationMs: number;
		readonly createdAt: string;
	}>;
	readonly getCookieImportStatus?: () => Promise<BrowserCookieImportStatus>;
	readonly importCookies?: () => Promise<BrowserCookieImportStatus>;
	readonly clearImportedCookies?: () => Promise<BrowserCookieImportStatus>;
	readonly clearBrowsingData?: () => Promise<BrowserCookieImportStatus>;
	readonly getNativeCredentialCapability?: () => Promise<{
		readonly supported: boolean;
		readonly reason?: string;
	}>;
	readonly fillNativeCredential?: (
		webContentsId: number,
		origin: string,
		submit?: boolean,
	) => Promise<{ readonly ok: boolean; readonly error?: string }>;
}

export interface SshBridge {
	readonly listHosts: () => Promise<ReadonlyArray<string>>;
	readonly ensureEnvironment: (host: string) => Promise<unknown>;
}

export type NotchTrayItemState =
	| "running"
	| "completed"
	| "failed"
	| "planReady"
	| "question"
	| "permission";

export interface NotchTrayItem {
	readonly id: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly title: string;
	readonly subtitle: string;
	readonly state: NotchTrayItemState;
	readonly label: string;
	readonly updatedAt: number;
}

export interface NotchDisplaySupport {
	readonly supported: boolean;
	readonly reason: "supported" | "not-macos" | "no-notched-display";
}

export interface NotchBridge {
	readonly setItems: (items: ReadonlyArray<NotchTrayItem>) => void;
	readonly setEnabled: (enabled: boolean) => void;
	readonly setPinned: (pinned: boolean) => void;
	readonly setExpanded?: (expanded: boolean) => void;
	readonly openChat: (chatId: string, sessionId: string) => void;
	readonly getDisplaySupport?: () => Promise<NotchDisplaySupport>;
	readonly onDisplaySupportChanged?: (
		handler: (support: NotchDisplaySupport) => void,
	) => () => void;
	readonly onItems?: (
		handler: (items: ReadonlyArray<NotchTrayItem>) => void,
	) => () => void;
	readonly onPinned?: (handler: (pinned: boolean) => void) => () => void;
	readonly onOpenChat?: (
		handler: (target: { chatId: string; sessionId: string }) => void,
	) => () => void;
}

export interface ZuseBridge {
	readonly rpc: RpcBridge;
	readonly window?: WindowBridge;
	readonly pairing?: PairingBridge;
	readonly menu?: MenuBridge;
	readonly app?: AppBridge;
	readonly network?: NetworkBridge;
	readonly updates?: UpdatesBridge;
	readonly browser?: BrowserBridge;
	readonly notch?: NotchBridge;
	readonly ssh?: SshBridge;
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
