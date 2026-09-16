import type { ResourceLease } from "@zuse/client-runtime/client-bus";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import { terminalOwnerLimitFailureMessage } from "@zuse/client-runtime/terminal-catalog";
import {
	createTerminalInputPump,
	retainPendingInitialInput,
	type TerminalInputPump,
} from "@zuse/client-runtime/terminal-input-pump";
import type { TerminalResourceState } from "@zuse/client-runtime/terminal-resource";
import {
	type EnvironmentId,
	type PtyId,
	PtyOpenToken,
	type PtyOwnerId,
	PtyOwnership,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Effect } from "effect";
import type { TerminalInstance } from "../store/terminals.ts";
import { GhosttySurface } from "../terminal/ghostty/surface.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { setPowerActiveTerminalCount } from "./power-runtime-activity.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";
import {
	dispatchTerminalClose,
	dispatchTerminalInput,
	dispatchTerminalOpen,
	dispatchTerminalRename,
	dispatchTerminalResize,
	dispatchTerminalRestart,
	retainTerminalResource,
} from "./terminal-client-bus.ts";

export type TerminalRuntimeStatus =
	| "connecting"
	| "running"
	| "reconnecting"
	| "exited"
	| "failed";

type LiveTerminal = {
	readonly environmentId: EnvironmentId;
	readonly instanceId: PtyId;
	readonly ownerId: PtyOwnerId;
	readonly term: GhosttySurface;
	readonly host: HTMLDivElement;
	readonly observer: ResizeObserver;
	readonly refreshTheme: () => void;
	ptyId: PtyId | null;
	processEpoch: string | null;
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
	rendererReady: boolean;
	rendererReadyPromise: Promise<void> | null;
	openOptions: TerminalAttachOptions;
	openPromise: Promise<void> | null;
	restartPromise: Promise<void> | null;
	failureMessage: string | null;
	disposed: boolean;
};

type TerminalAttachOptions = Readonly<{
	cwd: string;
	ownerId: PtyOwnerId;
	title: string;
	serverPtyId?: PtyId;
	processEpoch?: string;
	command?: TerminalInstance["command"];
	initialInput?: string;
	onInitialInputWritten?: () => void;
	onPtyBound?: (ptyId: PtyId, processEpoch: string) => void;
	onStatusChanged?: (status: TerminalRuntimeStatus) => void;
}>;

const INPUT_ACK_STALL_WARNING_MS = 3_000;
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
): string => structuralTupleKey(environmentId, instanceId);

export const terminalOpenOwnership = (
	instanceId: PtyId,
	ownerId: PtyOwnerId,
	title: string,
): PtyOwnership =>
	PtyOwnership.make({
		ownerId,
		label: title,
		scope: "session",
		openToken: PtyOpenToken.make(instanceId),
	});

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

export const getTerminalFailureMessage = (
	environmentId: EnvironmentId,
	instanceId: PtyId,
): string | null =>
	registry.get(terminalRuntimeKey(environmentId, instanceId))?.failureMessage ??
	null;

function publishStatus(
	live: LiveTerminal,
	status: TerminalRuntimeStatus,
): void {
	if (live.status === status) return;
	const previous = live.status;
	live.status = status;
	live.openOptions.onStatusChanged?.(status);
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

function writeToTerminal(
	term: GhosttySurface,
	data: string,
): Effect.Effect<void> {
	return Effect.promise(() => term.write(data));
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
	if (live.disposed) return;
	live.failureMessage = reason;
	if (live.status === "failed") return;
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

const openFailureMessage = (cause: unknown): string => {
	const limitFailure = terminalOwnerLimitFailureMessage(cause);
	if (limitFailure !== null) return limitFailure;
	if (
		typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		cause._tag === "PtyOpenConflictError"
	) {
		return "This terminal identity conflicts with an existing process. Close it, then reopen.";
	}
	return "Failed to open terminal. Check the connection, then retry.";
};

function ensureInputPump(live: LiveTerminal): void {
	if (live.disposed || live.inputPump !== null || live.ptyId === null) return;
	const ptyId = live.ptyId;
	live.inputPump = createTerminalInputPump({
		stallWarningMs: INPUT_ACK_STALL_WARNING_MS,
		write: async (data) => {
			await dispatchTerminalInput(
				{ environmentId: live.environmentId, terminalId: ptyId },
				data,
				live.ownerId,
			);
		},
		onFailure: (cause) => {
			markFailed(live, "write-failed", causeCategory(cause));
		},
		onStall: (elapsedMs) => {
			recordDiagnosticEvent({
				level: "warn",
				source: "terminal.input",
				message: "input acknowledgement delayed",
				detail: `terminal=${live.instanceId} elapsedMs=${elapsedMs}`,
			});
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
	flushInitialInput(live);
}

function observeTerminalResource(
	live: LiveTerminal,
	view: ResourceView<TerminalResourceState>,
): void {
	if (live.disposed) return;
	if (view.data !== null) {
		live.processEpoch = view.data.processEpoch;
		live.failureMessage =
			view.data.failure === null
				? null
				: `${view.data.failure.message} Restart the terminal to continue.`;
		if (
			view.connection !== "connected" &&
			view.data.phase !== "exited" &&
			view.data.phase !== "failed"
		) {
			publishStatus(live, "reconnecting");
			return;
		}
		publishStatus(live, view.data.phase);
		if (view.data.phase === "running") {
			ensureInputPump(live);
			scheduleResize(live);
		}
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
	const retained = retainTerminalResource(
		ref,
		{
			reset: () => live.term.reset(),
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
		},
		live.ownerId,
	);
	live.resourceLease = retained.lease;
	live.unsubscribeResource = getRendererClientBus().subscribe(
		retained.key,
		(view) => observeTerminalResource(live, view),
	);
	observeTerminalResource(live, getRendererClientBus().snapshot(retained.key));
}

function activateBoundPty(live: LiveTerminal): void {
	if (!live.rendererReady || live.ptyId === null || live.disposed) return;
	ensureInputPump(live);
	scheduleFit(live);
	scheduleResize(live);
	retainOutput(live);
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
		live.ownerId,
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
			live.term.fit();
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
	opts: TerminalAttachOptions,
): Promise<void> {
	try {
		const { ptyId, processEpoch } = await dispatchTerminalOpen(
			live.environmentId,
			{
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
				ownership: terminalOpenOwnership(
					live.instanceId,
					live.ownerId,
					opts.title,
				),
			},
		);
		if (live.disposed) {
			void dispatchTerminalClose(
				{
					environmentId: live.environmentId,
					terminalId: ptyId,
				},
				live.ownerId,
			);
			return;
		}
		if (live.ptyId !== null && live.ptyId !== ptyId) {
			void dispatchTerminalClose(
				{ environmentId: live.environmentId, terminalId: ptyId },
				live.ownerId,
			);
			markFailed(
				live,
				"Terminal reconciliation returned a different process. Retry the terminal.",
			);
			return;
		}
		live.ptyId = ptyId;
		live.processEpoch = processEpoch;
		live.failureMessage = null;
		opts.onPtyBound?.(ptyId, processEpoch);
		activateBoundPty(live);
	} catch (cause) {
		if (!live.disposed && live.ptyId === null) {
			markFailed(live, openFailureMessage(cause), causeCategory(cause));
		}
	}
}

async function beginOpen(live: LiveTerminal): Promise<void> {
	if (live.disposed || live.ptyId !== null) return Promise.resolve();
	if (!live.rendererReady) {
		await live.rendererReadyPromise;
		if (live.disposed || !live.rendererReady || live.ptyId !== null) return;
	}
	if (live.openPromise !== null) return live.openPromise;
	live.failureMessage = null;
	publishStatus(live, "connecting");
	let tracked: Promise<void>;
	tracked = openPty(live, live.openOptions).finally(() => {
		if (live.openPromise === tracked) live.openPromise = null;
	});
	live.openPromise = tracked;
	return tracked;
}

async function initializeRenderer(live: LiveTerminal): Promise<void> {
	try {
		await live.term.ready();
	} catch (cause) {
		if (!live.disposed) {
			markFailed(
				live,
				"Terminal renderer failed to initialize. Close it, then reopen.",
				causeCategory(cause),
			);
		}
		return;
	}
	if (live.disposed) return;
	live.rendererReady = true;
	if (live.ptyId === null) void beginOpen(live);
	else activateBoundPty(live);
}

function makeLive(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	container: HTMLElement,
	opts: TerminalAttachOptions,
): LiveTerminal {
	const host = document.createElement("div");
	host.className = "h-full w-full";
	host.dataset.terminalInstanceId = instanceId;
	host.dataset.terminalStatus = "connecting";
	container.appendChild(host);

	const term = new GhosttySurface();
	term.open(host);

	let live: LiveTerminal;
	const observer = new ResizeObserver(() => scheduleFit(live));
	live = {
		environmentId,
		instanceId,
		ownerId: opts.ownerId,
		term,
		host,
		observer,
		refreshTheme: () => term.refreshTheme(),
		ptyId: opts.serverPtyId ?? null,
		processEpoch: opts.processEpoch ?? null,
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
		rendererReady: false,
		rendererReadyPromise: null,
		openOptions: opts,
		openPromise: null,
		restartPromise: null,
		failureMessage: null,
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
	live.rendererReadyPromise = initializeRenderer(live);
	return live;
}

export function attach(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	container: HTMLElement,
	opts: TerminalAttachOptions,
): void {
	const key = terminalRuntimeKey(environmentId, instanceId);
	const existing = registry.get(key);
	if (existing !== undefined) {
		if (existing.ownerId !== opts.ownerId) {
			throw new Error(`Terminal owner changed for retained instance: ${key}`);
		}
		if (existing.host.parentElement !== container) {
			container.appendChild(existing.host);
		}
		existing.openOptions = {
			...existing.openOptions,
			onInitialInputWritten:
				opts.onInitialInputWritten ??
				existing.openOptions.onInitialInputWritten,
			onPtyBound: opts.onPtyBound ?? existing.openOptions.onPtyBound,
			onStatusChanged:
				opts.onStatusChanged ?? existing.openOptions.onStatusChanged,
		};
		if (
			opts.processEpoch !== undefined &&
			(opts.serverPtyId === undefined || existing.ptyId === opts.serverPtyId)
		) {
			existing.processEpoch = opts.processEpoch;
		}
		if (opts.serverPtyId !== undefined && existing.ptyId === null) {
			reconcilePtyBinding(
				environmentId,
				instanceId,
				opts.serverPtyId,
				opts.processEpoch,
			);
		} else if (existing.ptyId === null && existing.status === "failed") {
			void beginOpen(existing);
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

/** Bind a catalog-reconciled process to a retained logical renderer slot. */
export function reconcilePtyBinding(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	serverPtyId: PtyId,
	processEpoch?: string,
): boolean {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live === undefined || live.disposed) return false;
	if (live.ptyId !== null) {
		if (live.ptyId !== serverPtyId) return false;
		if (processEpoch !== undefined) live.processEpoch = processEpoch;
		return true;
	}
	live.ptyId = serverPtyId;
	if (processEpoch !== undefined) live.processEpoch = processEpoch;
	live.failureMessage = null;
	publishStatus(live, "connecting");
	activateBoundPty(live);
	return true;
}

export function detach(environmentId: EnvironmentId, instanceId: PtyId): void {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live === undefined) return;
	live.observer.disconnect();
	if (live.host.parentElement !== null) live.host.remove();
}

const retainedTerminal = (
	environmentId: EnvironmentId,
	instanceId: PtyId,
): Readonly<{ live: LiveTerminal; ptyId: PtyId }> => {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live === undefined || live.disposed || live.ptyId === null) {
		throw new Error("Terminal process is not attached");
	}
	return { live, ptyId: live.ptyId };
};

export async function rename(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	label: string,
): Promise<void> {
	const { live, ptyId } = retainedTerminal(environmentId, instanceId);
	await dispatchTerminalRename(
		{ environmentId, terminalId: ptyId },
		label,
		live.ownerId,
	);
}

export async function restart(
	environmentId: EnvironmentId,
	instanceId: PtyId,
): Promise<void> {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live === undefined || live.disposed) {
		throw new Error("Terminal process is not attached");
	}
	if (live.restartPromise !== null) return live.restartPromise;
	const operation = (async () => {
		live.inputPump?.dispose();
		live.inputPump = null;
		publishStatus(live, "connecting");
		try {
			if (live.ptyId === null) {
				await beginOpen(live);
				if (live.ptyId === null) {
					throw new Error(
						live.failureMessage ?? "Terminal open retry did not complete.",
					);
				}
				return;
			}
			const ptyId = live.ptyId;
			const restarted = await dispatchTerminalRestart(
				{ environmentId, terminalId: ptyId },
				live.ownerId,
				live.processEpoch ?? undefined,
			);
			live.processEpoch = restarted.processEpoch;
			live.openOptions.onPtyBound?.(restarted.ptyId, restarted.processEpoch);
			ensureInputPump(live);
		} catch (cause) {
			markFailed(
				live,
				live.ptyId === null && live.failureMessage !== null
					? live.failureMessage
					: (terminalOwnerLimitFailureMessage(cause) ??
							"failed to restart terminal"),
				causeCategory(cause),
			);
			throw cause;
		}
	})();
	live.restartPromise = operation;
	try {
		await operation;
	} finally {
		if (live.restartPromise === operation) live.restartPromise = null;
	}
}

/** Ask the foreground shell/TUI to clear while preserving its terminal state. */
export async function clearScreen(
	environmentId: EnvironmentId,
	instanceId: PtyId,
): Promise<void> {
	const { live } = retainedTerminal(environmentId, instanceId);
	ensureInputPump(live);
	if (
		live.inputPump === null ||
		!(await live.inputPump.enqueueAndWait("\x0c"))
	) {
		throw new Error("Terminal did not acknowledge clear-screen input");
	}
}

function releaseLive(live: LiveTerminal, closeProcess: boolean): Promise<void> {
	const key = terminalRuntimeKey(live.environmentId, live.instanceId);
	if (registry.get(key) !== live) return Promise.resolve();
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
	const closePromise =
		closeProcess && live.ptyId !== null
			? dispatchTerminalClose(
					{
						environmentId: live.environmentId,
						terminalId: live.ptyId,
					},
					live.ownerId,
				).catch(() => undefined)
			: Promise.resolve();
	live.host.remove();
	live.term.dispose();
	removeStatus(live.environmentId, live.instanceId);
	return closePromise;
}

export function dispose(
	environmentId: EnvironmentId,
	instanceId: PtyId,
	fallback: Readonly<{ serverPtyId?: PtyId; ownerId?: PtyOwnerId }> = {},
): Promise<void> {
	const live = registry.get(terminalRuntimeKey(environmentId, instanceId));
	if (live !== undefined) return releaseLive(live, true);
	if (fallback.serverPtyId === undefined) return Promise.resolve();
	// Catalog-restored terminals may be explicitly closed before their surface is
	// mounted. The server identity is enough to close that owned process without
	// manufacturing a Ghostty renderer just to tear it down.
	return dispatchTerminalClose(
		{ environmentId, terminalId: fallback.serverPtyId },
		fallback.ownerId,
	).catch(() => undefined);
}

if (
	typeof window !== "undefined" &&
	typeof window.addEventListener === "function"
) {
	window.addEventListener("pagehide", () => {
		for (const live of [...registry.values()]) void releaseLive(live, false);
	});
}
