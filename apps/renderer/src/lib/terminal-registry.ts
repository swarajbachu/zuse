import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ResourceLease } from "@zuse/client-runtime/client-bus";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { TerminalResourceState } from "@zuse/client-runtime/terminal-resource";
import type { EnvironmentId, PtyId } from "@zuse/contracts";
import { Effect } from "effect";
import type { TerminalInstance } from "../store/terminals.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { setPowerActiveTerminalCount } from "./power-runtime-activity.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";
import {
	dispatchTerminalClose,
	dispatchTerminalInput,
	dispatchTerminalOpen,
	dispatchTerminalResize,
	retainTerminalResource,
} from "./terminal-client-bus.ts";
import {
	createTerminalInputPump,
	retainPendingInitialInput,
	type TerminalInputPump,
} from "./terminal-input-pump.ts";

export type TerminalRuntimeStatus =
	| "connecting"
	| "running"
	| "reconnecting"
	| "exited"
	| "failed";

type LiveTerminal = {
	readonly environmentId: EnvironmentId;
	readonly instanceId: PtyId;
	readonly term: Terminal;
	readonly fit: FitAddon;
	readonly host: HTMLDivElement;
	readonly observer: ResizeObserver;
	readonly refreshTheme: () => void;
	ptyId: PtyId | null;
	status: TerminalRuntimeStatus;
	resourceLease: ResourceLease | null;
	unsubscribeResource: (() => void) | null;
	inputPump: TerminalInputPump | null;
	pendingInitialInput: string;
	initialInputInFlight: boolean;
	onInitialInputWritten: (() => void) | null;
	disposables: { dispose: () => void } | null;
	resizeTimer: ReturnType<typeof setTimeout> | null;
	resizeInFlight: boolean;
	resizePending: boolean;
	fitFrame: number | null;
	lastHostWidth: number;
	lastHostHeight: number;
	lastSentCols: number;
	lastSentRows: number;
	disposed: boolean;
};

const INPUT_ACK_TIMEOUT_MS = 3_000;
const RESIZE_DEBOUNCE_MS = 75;
const registry = new Map<string, LiveTerminal>();
const statusListeners = new Set<() => void>();
let statusSnapshot: Readonly<Record<string, TerminalRuntimeStatus>> = {};

const flushInitialInput = (live: LiveTerminal): void => {
	if (
		live.inputPump === null ||
		live.pendingInitialInput.length === 0 ||
		live.initialInputInFlight
	)
		return;
	const expected = live.pendingInitialInput;
	live.initialInputInFlight = true;
	void live.inputPump.enqueueAndWait(expected).then((written) => {
		live.initialInputInFlight = false;
		if (!written || live.pendingInitialInput !== expected) return;
		live.pendingInitialInput = "";
		const onWritten = live.onInitialInputWritten;
		live.onInitialInputWritten = null;
		onWritten?.();
	});
};

export const terminalRuntimeKey = (
	environmentId: EnvironmentId | string,
	instanceId: PtyId | string,
): string => `${environmentId}:${instanceId}`;

const publishPowerTerminalCount = (): void => {
	setPowerActiveTerminalCount(
		Object.values(statusSnapshot).filter(
			(status) => status !== "exited" && status !== "failed",
		).length,
	);
};

export const subscribeStatuses = (listener: () => void): (() => void) => {
	statusListeners.add(listener);
	return () => statusListeners.delete(listener);
};

export const getStatusesSnapshot = (): Readonly<
	Record<string, TerminalRuntimeStatus>
> => statusSnapshot;

function publishStatus(
	live: LiveTerminal,
	status: TerminalRuntimeStatus,
): void {
	if (live.status === status) return;
	const previous = live.status;
	live.status = status;
	live.host.dataset.terminalStatus = status;
	statusSnapshot = {
		...statusSnapshot,
		[terminalRuntimeKey(live.environmentId, live.instanceId)]: status,
	};
	publishPowerTerminalCount();
	recordDiagnosticEvent({
		level: status === "failed" ? "error" : "debug",
		source: "terminal.runtime",
		message: `${previous} -> ${status}`,
		detail: `terminal=${live.instanceId}`,
	});
	for (const listener of statusListeners) listener();
}

function removeStatus(environmentId: EnvironmentId, instanceId: PtyId): void {
	const key = terminalRuntimeKey(environmentId, instanceId);
	if (!(key in statusSnapshot)) return;
	const { [key]: _removed, ...next } = statusSnapshot;
	statusSnapshot = next;
	publishPowerTerminalCount();
	for (const listener of statusListeners) listener();
}

function readToken(el: HTMLElement, cssVar: string, fallback: string): string {
	const probe = document.createElement("span");
	probe.style.color = `var(${cssVar})`;
	probe.style.display = "none";
	el.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();
	return computed || fallback;
}

function readTerminalTheme(
	host: HTMLElement,
): NonNullable<Terminal["options"]["theme"]> {
	return {
		background: readToken(host, "--background", "#0b0b0c"),
		foreground: readToken(host, "--foreground", "#e6e6e6"),
		cursor: readToken(host, "--primary", "#e6e6e6"),
		cursorAccent: readToken(host, "--background", "#0b0b0c"),
		selectionBackground: readToken(host, "--accent", "#2c2c33"),
		selectionForeground: readToken(host, "--accent-foreground", "#e6e6e6"),
	};
}

function writeToTerminal(term: Terminal, data: string): Effect.Effect<void> {
	return Effect.callback<void>((resume) => {
		term.write(data, () => resume(Effect.void));
	});
}

function causeCategory(cause: unknown): string {
	if (
		typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		typeof cause._tag === "string"
	) {
		return cause._tag;
	}
	if (cause instanceof Error) return cause.name;
	return typeof cause;
}

function markFailed(live: LiveTerminal, reason: string, detail?: string): void {
	if (live.disposed || live.status === "failed") return;
	publishStatus(live, "failed");
	live.inputPump?.dispose();
	live.inputPump = null;
	recordDiagnosticEvent({
		level: "error",
		source: "terminal.failure",
		message: reason,
		detail: detail ?? `terminal=${live.instanceId}`,
	});
}

function observeTerminalResource(
	live: LiveTerminal,
	view: ResourceView<TerminalResourceState>,
): void {
	if (live.disposed) return;
	if (view.data !== null) {
		if (
			view.connection !== "connected" &&
			view.data.phase !== "exited" &&
			view.data.phase !== "failed"
		) {
			publishStatus(live, "reconnecting");
			return;
		}
		publishStatus(live, view.data.phase);
		if (view.data.phase === "running") scheduleResize(live);
		if (view.data.phase === "exited" || view.data.phase === "failed") {
			live.inputPump?.dispose();
			live.inputPump = null;
		}
		return;
	}
	if (view.connection === "connected") publishStatus(live, "connecting");
	else if (view.connection !== "dormant") publishStatus(live, "reconnecting");
}

function retainOutput(live: LiveTerminal): void {
	if (live.ptyId === null || live.resourceLease !== null) return;
	const ref = {
		environmentId: live.environmentId,
		terminalId: live.ptyId,
	} as const;
	const retained = retainTerminalResource(ref, {
		write: (bytes) => Effect.runPromise(writeToTerminal(live.term, bytes)),
		exited: (exitCode) => {
			const note =
				exitCode === null
					? "[process exited]"
					: `[process exited with code ${exitCode}]`;
			return Effect.runPromise(
				writeToTerminal(live.term, `\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`),
			);
		},
	});
	live.resourceLease = retained.lease;
	live.unsubscribeResource = getRendererClientBus().subscribe(
		retained.key,
		(view) => observeTerminalResource(live, view),
	);
	observeTerminalResource(live, getRendererClientBus().snapshot(retained.key));
}

function sendResize(live: LiveTerminal): void {
	live.resizeTimer = null;
	if (live.disposed) {
		live.resizePending = false;
		return;
	}
	if (
		live.resizeInFlight ||
		live.ptyId === null ||
		(live.status !== "running" && live.status !== "connecting")
	) {
		return;
	}
	const { cols, rows } = live.term;
	if (cols === live.lastSentCols && rows === live.lastSentRows) {
		live.resizePending = false;
		return;
	}
	live.resizePending = false;
	live.resizeInFlight = true;
	const id = live.ptyId;
	let acknowledged = false;
	void dispatchTerminalResize(
		{ environmentId: live.environmentId, terminalId: id },
		cols,
		rows,
	)
		.then(() => {
			acknowledged = true;
			live.lastSentCols = cols;
			live.lastSentRows = rows;
		})
		.catch((cause) => {
			recordDiagnosticEvent({
				level: "warn",
				source: "terminal.resize",
				message: "resize failed",
				detail: causeCategory(cause),
			});
		})
		.finally(() => {
			live.resizeInFlight = false;
			if (
				!live.disposed &&
				(live.resizePending ||
					(acknowledged &&
						(live.term.cols !== live.lastSentCols ||
							live.term.rows !== live.lastSentRows)))
			) {
				scheduleResize(live);
			}
		});
}

function scheduleResize(live: LiveTerminal): void {
	live.resizePending = true;
	if (live.resizeTimer !== null) clearTimeout(live.resizeTimer);
	live.resizeTimer = setTimeout(() => sendResize(live), RESIZE_DEBOUNCE_MS);
}

function scheduleFit(live: LiveTerminal): void {
	if (live.fitFrame !== null || live.disposed) return;
	live.fitFrame = window.requestAnimationFrame(() => {
		live.fitFrame = null;
		const width = live.host.clientWidth;
		const height = live.host.clientHeight;
		if (
			width === 0 ||
			height === 0 ||
			(width === live.lastHostWidth && height === live.lastHostHeight)
		) {
			return;
		}
		live.lastHostWidth = width;
		live.lastHostHeight = height;
		try {
			live.fit.fit();
		} catch (cause) {
			if (!live.disposed) {
				recordDiagnosticEvent({
					level: "warn",
					source: "terminal.fit",
					message: "fit skipped",
					detail: causeCategory(cause),
				});
			}
		}
	});
}

function configureRuntime(live: LiveTerminal): void {
	const dataDisposable = live.term.onData((data) => {
		if (live.status === "running") live.inputPump?.enqueue(data);
	});
	const resizeDisposable = live.term.onResize(() => scheduleResize(live));
	live.disposables = {
		dispose: () => {
			dataDisposable.dispose();
			resizeDisposable.dispose();
		},
	};
}

async function openPty(
	live: LiveTerminal,
	opts: {
		readonly cwd: string;
		readonly command?: TerminalInstance["command"];
		readonly initialInput?: string;
		readonly onInitialInputWritten?: () => void;
	},
): Promise<void> {
	try {
		const { ptyId } = await dispatchTerminalOpen(live.environmentId, {
			cwd: opts.cwd,
			cols: live.term.cols,
			rows: live.term.rows,
			command:
				opts.command === undefined
					? undefined
					: {
							cmd: opts.command.cmd,
							args: [...opts.command.args],
							env: opts.command.env,
						},
		});
		if (live.disposed) {
			void dispatchTerminalClose({
				environmentId: live.environmentId,
				terminalId: ptyId,
			});
			return;
		}
		live.ptyId = ptyId;
		live.inputPump = createTerminalInputPump({
			timeoutMs: INPUT_ACK_TIMEOUT_MS,
			write: async (data) => {
				await dispatchTerminalInput(
					{ environmentId: live.environmentId, terminalId: ptyId },
					data,
				);
			},
			onFailure: (reason, cause) => {
				markFailed(live, reason, causeCategory(cause));
			},
			onQueueHighWater: (characters) => {
				if (characters < 256) return;
				recordDiagnosticEvent({
					level: "warn",
					source: "terminal.input",
					message: "input queue high-water mark",
					detail: `terminal=${live.instanceId} characters=${characters}`,
				});
			},
		});
		if (live.pendingInitialInput.length > 0) {
			flushInitialInput(live);
		}
		scheduleFit(live);
		scheduleResize(live);
		retainOutput(live);
	} catch (cause) {
		if (!live.disposed) {
			markFailed(live, "failed to open terminal", causeCategory(cause));
		}
	}
}

function makeLive(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	container: HTMLElement,
	opts: {
		readonly cwd: string;
		readonly command?: TerminalInstance["command"];
		readonly initialInput?: string;
		readonly onInitialInputWritten?: () => void;
	},
): LiveTerminal {
	const host = document.createElement("div");
	host.className = "h-full w-full";
	host.dataset.terminalInstanceId = instanceId;
	host.dataset.terminalStatus = "connecting";
	container.appendChild(host);

	const term = new Terminal({
		fontFamily:
			'"SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
		fontSize: 11,
		fontWeight: "400",
		lineHeight: 1.2,
		letterSpacing: 0,
		cursorBlink: true,
		cursorStyle: "bar",
		cursorInactiveStyle: "bar",
		convertEol: false,
		scrollback: 5_000,
		theme: readTerminalTheme(host),
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(host);

	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => {
			recordDiagnosticEvent({
				level: "warn",
				source: "terminal.renderer",
				message: "WebGL context lost; using DOM renderer",
				detail: `terminal=${instanceId}`,
			});
			webgl.dispose();
		});
		term.loadAddon(webgl);
	} catch (cause) {
		recordDiagnosticEvent({
			level: "debug",
			source: "terminal.renderer",
			message: "WebGL unavailable; using DOM renderer",
			detail: causeCategory(cause),
		});
	}

	let live: LiveTerminal;
	const observer = new ResizeObserver(() => scheduleFit(live));
	live = {
		environmentId,
		instanceId,
		term,
		fit,
		host,
		observer,
		refreshTheme: () => {
			term.options.theme = readTerminalTheme(host);
		},
		ptyId: null,
		status: "connecting",
		resourceLease: null,
		unsubscribeResource: null,
		inputPump: null,
		pendingInitialInput: opts.initialInput ?? "",
		initialInputInFlight: false,
		onInitialInputWritten: opts.onInitialInputWritten ?? null,
		disposables: null,
		resizeTimer: null,
		resizeInFlight: false,
		resizePending: false,
		fitFrame: null,
		lastHostWidth: 0,
		lastHostHeight: 0,
		lastSentCols: 0,
		lastSentRows: 0,
		disposed: false,
	};

	statusSnapshot = {
		...statusSnapshot,
		[terminalRuntimeKey(environmentId, instanceId)]: "connecting",
	};
	publishPowerTerminalCount();
	for (const listener of statusListeners) listener();
	live.observer.observe(host);
	window.addEventListener("zuse:appearance-change", live.refreshTheme);
	configureRuntime(live);
	scheduleFit(live);
	void openPty(live, opts);
	return live;
}

export function attach(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	container: HTMLElement,
	opts: {
		readonly cwd: string;
		readonly command?: TerminalInstance["command"];
		readonly initialInput?: string;
		readonly onInitialInputWritten?: () => void;
	},
): void {
	const key = terminalRuntimeKey(environmentId, instanceId);
	const existing = registry.get(key);
	if (existing !== undefined) {
		if (existing.host.parentElement !== container) {
			container.appendChild(existing.host);
		}
		existing.observer.observe(existing.host);
		existing.lastHostWidth = 0;
		existing.lastHostHeight = 0;
		scheduleFit(existing);
		if (opts.initialInput !== undefined && opts.initialInput.length > 0) {
			// React may remount while the cloud PTY write is still awaiting its
			// acknowledgement. The retained terminal owns that trigger until it is
			// acknowledged, so the remount only replaces the completion callback.
			existing.pendingInitialInput = retainPendingInitialInput(
				existing.pendingInitialInput,
				opts.initialInput,
			);
			existing.onInitialInputWritten = opts.onInitialInputWritten ?? null;
			flushInitialInput(existing);
		}
		return;
	}
	registry.set(key, makeLive(environmentId, instanceId, container, opts));
}

export function detach(environmentId: EnvironmentId, instanceId: PtyId): void {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live === undefined) return;
	live.observer.disconnect();
	if (live.host.parentElement !== null) live.host.remove();
}

export function dispose(environmentId: EnvironmentId, instanceId: PtyId): void {
	const key = terminalRuntimeKey(environmentId, instanceId);
	const live = registry.get(key);
	if (live === undefined) return;
	registry.delete(key);
	live.disposed = true;
	live.unsubscribeResource?.();
	live.resourceLease?.release();
	live.inputPump?.dispose();
	live.observer.disconnect();
	live.disposables?.dispose();
	window.removeEventListener("zuse:appearance-change", live.refreshTheme);
	if (live.resizeTimer !== null) clearTimeout(live.resizeTimer);
	if (live.fitFrame !== null) window.cancelAnimationFrame(live.fitFrame);
	if (live.ptyId !== null) {
		const ptyId = live.ptyId;
		void dispatchTerminalClose({
			environmentId: live.environmentId,
			terminalId: ptyId,
		}).catch(() => undefined);
	}
	live.host.remove();
	live.term.dispose();
	removeStatus(environmentId, instanceId);
}

export function disposeAll(): void {
	for (const live of [...registry.values()]) {
		dispose(live.environmentId, live.instanceId);
	}
}

if (
	typeof window !== "undefined" &&
	typeof window.addEventListener === "function"
) {
	window.addEventListener("pagehide", disposeAll);
}
