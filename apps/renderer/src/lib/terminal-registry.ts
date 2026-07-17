import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { PtyId } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import type { TerminalInstance } from "../store/terminals.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import {
  getRpcClient,
  reportRendererRpcFailure,
  reportRendererRpcStreamFailure,
  subscribeRendererRpcConnection,
} from "./rpc-client.ts";
import {
  createTerminalInputPump,
  type TerminalInputPump,
} from "./terminal-input-pump.ts";

export type TerminalRuntimeStatus =
  | "connecting"
  | "running"
  | "reconnecting"
  | "exited"
  | "failed";

type LiveTerminal = {
  readonly instanceId: string;
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly host: HTMLDivElement;
  readonly observer: ResizeObserver;
  readonly refreshTheme: () => void;
  ptyId: PtyId | null;
  status: TerminalRuntimeStatus;
  lastSequence: number;
  connectedGeneration: number | null;
  streamGeneration: number | null;
  streamEpoch: number;
  streamFiber: Fiber.Fiber<unknown, unknown> | null;
  inputPump: TerminalInputPump | null;
  disposables: { dispose: () => void } | null;
  unsubscribeConnection: (() => void) | null;
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
  statusSnapshot = { ...statusSnapshot, [live.instanceId]: status };
  recordDiagnosticEvent({
    level: status === "failed" ? "error" : "debug",
    source: "terminal.runtime",
    message: `${previous} -> ${status}`,
    detail: `terminal=${live.instanceId}`,
  });
  for (const listener of statusListeners) listener();
}

function removeStatus(instanceId: string): void {
  if (!(instanceId in statusSnapshot)) return;
  const { [instanceId]: _removed, ...next } = statusSnapshot;
  statusSnapshot = next;
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

function hasErrorTag(cause: unknown, tag: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === tag
  );
}

function stopOutput(live: LiveTerminal): void {
  live.streamEpoch += 1;
  live.streamGeneration = null;
  const fiber = live.streamFiber;
  live.streamFiber = null;
  if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
}

function acceptSequence(
  live: LiveTerminal,
  sequence: number,
): "accepted" | "duplicate" | "gap" {
  if (sequence <= live.lastSequence) return "duplicate";
  if (sequence !== live.lastSequence + 1) {
    return "gap";
  }
  live.lastSequence = sequence;
  return "accepted";
}

function resumeOutputFromCursor(live: LiveTerminal, generation: number): void {
  recordDiagnosticEvent({
    level: "warn",
    source: "terminal.reconnect",
    message: "live sequence discontinuity; replaying from cursor",
    detail: `terminal=${live.instanceId} sequence=${live.lastSequence}`,
  });
  stopOutput(live);
  publishStatus(live, "reconnecting");
  queueMicrotask(() => startOutput(live, generation));
}

function startOutput(live: LiveTerminal, generation: number): void {
  if (
    live.disposed ||
    live.ptyId === null ||
    live.status === "failed" ||
    live.status === "exited" ||
    live.streamGeneration === generation
  ) {
    return;
  }
  stopOutput(live);
  const epoch = live.streamEpoch;
  const ptyId = live.ptyId;
  live.streamGeneration = generation;
  publishStatus(live, live.lastSequence === 0 ? "connecting" : "reconnecting");

  const program = Effect.tryPromise(() => getRpcClient()).pipe(
    Effect.flatMap((client) =>
      Stream.runForEach(
        client["pty.output"]({
          ptyId,
          afterSequence: live.lastSequence,
        }),
        (event) => {
          if (live.disposed || epoch !== live.streamEpoch) return Effect.void;
          if (event._tag === "gap") {
            return Effect.sync(() => {
              markFailed(
                live,
                "terminal output replay gap",
                `requested=${event.requestedAfter} earliest=${event.earliestAvailable} latest=${event.latestAvailable}`,
              );
            });
          }
          if (event._tag === "cursor") {
            return Effect.sync(() => {
              if (event.sequence !== live.lastSequence) {
                markFailed(
                  live,
                  "terminal replay cursor mismatch",
                  `expected=${live.lastSequence} received=${event.sequence}`,
                );
                return;
              }
              publishStatus(live, "running");
              scheduleResize(live);
            });
          }
          const sequenceResult = acceptSequence(live, event.sequence);
          if (sequenceResult === "duplicate") return Effect.void;
          if (sequenceResult === "gap") {
            return Effect.sync(() => resumeOutputFromCursor(live, generation));
          }
          if (event._tag === "data") {
            return writeToTerminal(live.term, event.bytes);
          }
          live.inputPump?.dispose();
          live.inputPump = null;
          publishStatus(live, "exited");
          const note =
            event.exitCode === null
              ? "[process exited]"
              : `[process exited with code ${event.exitCode}]`;
          return writeToTerminal(
            live.term,
            `\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`,
          );
        },
      ),
    ),
    Effect.match({
      onFailure: (error) => {
        if (live.disposed || epoch !== live.streamEpoch) return;
        live.streamFiber = null;
        live.streamGeneration = null;
        if (hasErrorTag(error, "PtyNotFoundError")) {
          markFailed(
            live,
            "terminal process is no longer available",
            causeCategory(error),
          );
          return;
        }
        publishStatus(live, "reconnecting");
        reportRendererRpcStreamFailure(generation, error);
      },
      onSuccess: () => {
        if (live.disposed || epoch !== live.streamEpoch) return;
        live.streamFiber = null;
        live.streamGeneration = null;
        if (live.status !== "exited" && live.status !== "failed") {
          markFailed(live, "terminal output stream ended unexpectedly");
        }
      },
    }),
  );
  live.streamFiber = Effect.runFork(program);
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
  const generation = live.connectedGeneration;
  let acknowledged = false;
  void getRpcClient()
    .then((client) =>
      Effect.runPromise(client["pty.resize"]({ ptyId: id, cols, rows })),
    )
    .then(() => {
      if (generation === live.connectedGeneration) {
        acknowledged = true;
        live.lastSentCols = cols;
        live.lastSentRows = rows;
      }
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
  live.unsubscribeConnection = subscribeRendererRpcConnection((snapshot) => {
    const previousGeneration = live.connectedGeneration;
    live.connectedGeneration =
      snapshot.status === "connected" ? snapshot.generation : null;
    if (live.disposed || live.ptyId === null) return;
    if (snapshot.status === "connected") {
      if (previousGeneration !== snapshot.generation) {
        live.lastSentCols = 0;
        live.lastSentRows = 0;
      }
      startOutput(live, snapshot.generation);
      return;
    }
    if (snapshot.status === "blockedAuth" || snapshot.status === "error") {
      stopOutput(live);
      markFailed(live, "terminal connection could not be restored");
      return;
    }
    stopOutput(live);
    publishStatus(live, "reconnecting");
  });
}

async function openPty(
  live: LiveTerminal,
  opts: {
    readonly cwd: string;
    readonly command?: TerminalInstance["command"];
  },
): Promise<void> {
  try {
    const client = await getRpcClient();
    if (live.disposed) return;
    const { ptyId } = await Effect.runPromise(
      client["pty.open"]({
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
      }),
    );
    if (live.disposed) {
      void Effect.runPromise(client["pty.close"]({ ptyId }));
      return;
    }
    live.ptyId = ptyId;
    live.inputPump = createTerminalInputPump({
      timeoutMs: INPUT_ACK_TIMEOUT_MS,
      write: async (data) => {
        const currentClient = await getRpcClient();
        await Effect.runPromise(currentClient["pty.write"]({ ptyId, data }));
      },
      onFailure: (reason, cause) => {
        if (cause !== undefined && !hasErrorTag(cause, "PtyNotFoundError")) {
          reportRendererRpcFailure(cause);
        }
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
    scheduleFit(live);
    scheduleResize(live);
    if (live.connectedGeneration !== null) {
      startOutput(live, live.connectedGeneration);
    }
  } catch (cause) {
    if (!live.disposed) {
      markFailed(live, "failed to open terminal", causeCategory(cause));
    }
  }
}

function makeLive(
  instanceId: string,
  container: HTMLElement,
  opts: {
    readonly cwd: string;
    readonly command?: TerminalInstance["command"];
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
    fontSize: 13,
    fontWeight: "400",
    lineHeight: 1.24,
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
    lastSequence: 0,
    connectedGeneration: null,
    streamGeneration: null,
    streamEpoch: 0,
    streamFiber: null,
    inputPump: null,
    disposables: null,
    unsubscribeConnection: null,
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

  statusSnapshot = { ...statusSnapshot, [instanceId]: "connecting" };
  for (const listener of statusListeners) listener();
  live.observer.observe(host);
  window.addEventListener("zuse:appearance-change", live.refreshTheme);
  configureRuntime(live);
  scheduleFit(live);
  void openPty(live, opts);
  return live;
}

export function attach(
  instanceId: string,
  container: HTMLElement,
  opts: {
    readonly cwd: string;
    readonly command?: TerminalInstance["command"];
  },
): void {
  const existing = registry.get(instanceId);
  if (existing !== undefined) {
    if (existing.host.parentElement !== container) {
      container.appendChild(existing.host);
    }
    existing.observer.observe(existing.host);
    existing.lastHostWidth = 0;
    existing.lastHostHeight = 0;
    scheduleFit(existing);
    return;
  }
  registry.set(instanceId, makeLive(instanceId, container, opts));
}

export function detach(instanceId: string): void {
  const live = registry.get(instanceId);
  if (live === undefined) return;
  live.observer.disconnect();
  if (live.host.parentElement !== null) live.host.remove();
}

export function dispose(instanceId: string): void {
  const live = registry.get(instanceId);
  if (live === undefined) return;
  registry.delete(instanceId);
  live.disposed = true;
  stopOutput(live);
  live.inputPump?.dispose();
  live.observer.disconnect();
  live.unsubscribeConnection?.();
  live.disposables?.dispose();
  window.removeEventListener("zuse:appearance-change", live.refreshTheme);
  if (live.resizeTimer !== null) clearTimeout(live.resizeTimer);
  if (live.fitFrame !== null) window.cancelAnimationFrame(live.fitFrame);
  if (live.ptyId !== null) {
    const ptyId = live.ptyId;
    void getRpcClient()
      .then((client) => Effect.runPromise(client["pty.close"]({ ptyId })))
      .catch(() => undefined);
  }
  live.host.remove();
  live.term.dispose();
  removeStatus(instanceId);
}

export function disposeAll(): void {
  for (const id of [...registry.keys()]) dispose(id);
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("pagehide", disposeAll);
}
