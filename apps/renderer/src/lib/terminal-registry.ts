import { Effect, Fiber, Stream } from "effect";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

import type { PtyId } from "@zuse/contracts";

import { getRpcClient } from "./rpc-client.ts";
import type { TerminalInstance } from "../store/terminals.ts";

/**
 * Persistent terminal registry. The xterm `Terminal` and its backing PTY live
 * HERE — in a module-level map keyed by terminal-instance id — not inside the
 * React component. `PtyTerminal` is a thin host that `attach()`es a live entry
 * into its container on mount and `detach()`es (NOT disposes) on unmount.
 *
 * Why: the right dock mounts only the *active* chat's terminals. Before this
 * registry, switching chats unmounted the previous chat's `PtyTerminal`, whose
 * cleanup killed the PTY — so a running shell died the moment you looked at
 * another chat. Now unmount only detaches the DOM; the process and its output
 * stream keep running in the background, and re-selecting the chat reconnects
 * to the same live shell.
 *
 * PTYs are torn down only on explicit close (`dispose`) or renderer unload
 * (`disposeAll` via `pagehide`) — preserving the "PTYs die with the renderer,
 * no rehydration across reloads" contract.
 */
type LiveTerminal = {
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** Dedicated wrapper that xterm renders into; moved between containers. */
  readonly host: HTMLDivElement;
  readonly observer: ResizeObserver;
  readonly refreshTheme: () => void;
  ptyId: PtyId | null;
  streamFiber: Fiber.Fiber<unknown, unknown> | null;
  disposables: { dispose: () => void } | null;
  resizeTimer: number | null;
  /** Set once `dispose()` runs so a late async PTY open closes itself. */
  disposed: boolean;
};

const registry = new Map<string, LiveTerminal>();

// xterm's canvas/webgl renderer takes literal color strings, not CSS vars, so
// we resolve our shadcn tokens to computed rgb() strings via a probe span.
// `getComputedStyle().color` always returns a normalized rgb()/rgba() the
// renderer can parse, regardless of whether the var is defined in oklch().
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
    // Solid background matching the pane: lets the WebGL renderer draw
    // cleanly and skips the per-frame cost of a transparent canvas.
    background: readToken(host, "--background", "#0b0b0c"),
    foreground: readToken(host, "--foreground", "#e6e6e6"),
    cursor: readToken(host, "--primary", "#e6e6e6"),
    cursorAccent: readToken(host, "--background", "#0b0b0c"),
    selectionBackground: readToken(host, "--accent", "#2c2c33"),
    selectionForeground: readToken(host, "--accent-foreground", "#e6e6e6"),
  };
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
  container.appendChild(host);

  const term = new Terminal({
    fontFamily:
      '"SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    // Thin bar cursor (not the chunky block) so it reads as a clean accent.
    cursorStyle: "bar",
    cursorInactiveStyle: "bar",
    convertEol: false,
    theme: readTerminalTheme(host),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // GPU renderer — keeps up with fast PTY output where the default DOM
  // renderer stalls and visibly drops/garbles characters. Falls back to the
  // DOM renderer automatically if the GL context is lost or unavailable.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL context (rare) — DOM renderer stays active.
  }

  const live: LiveTerminal = {
    term,
    fit,
    host,
    observer: new ResizeObserver(() => safeFit(live)),
    refreshTheme: () => {
      term.options.theme = readTerminalTheme(host);
    },
    ptyId: null,
    streamFiber: null,
    disposables: null,
    resizeTimer: null,
    disposed: false,
  };

  // Observe the host itself: when its container is `hidden` (background chat /
  // inactive terminal tab) it measures 0×0 and `safeFit` no-ops; it fires
  // again with real dimensions once shown.
  live.observer.observe(host);
  window.addEventListener("zuse:appearance-change", live.refreshTheme);
  window.requestAnimationFrame(() => safeFit(live));

  void openPty(live, opts);
  return live;
}

// Don't fit when the container has no layout yet (first render, or hidden):
// xterm's renderer has no dimensions and FitAddon throws "Cannot read
// properties of undefined (reading 'dimensions')".
function safeFit(live: LiveTerminal): void {
  const { host } = live;
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  try {
    live.fit.fit();
  } catch {
    // ignore — happens during teardown when the container is detached
  }
}

async function openPty(
  live: LiveTerminal,
  opts: {
    readonly cwd: string;
    readonly command?: TerminalInstance["command"];
  },
): Promise<void> {
  const { term } = live;
  try {
    const client = await getRpcClient();
    if (live.disposed) return;

    const { ptyId: id } = await Effect.runPromise(
      client["pty.open"]({
        cwd: opts.cwd,
        cols: term.cols,
        rows: term.rows,
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
      void Effect.runPromise(client["pty.close"]({ ptyId: id }));
      return;
    }
    live.ptyId = id;
    safeFit(live);
    void Effect.runPromise(
      client["pty.resize"]({ ptyId: id, cols: term.cols, rows: term.rows }),
    ).catch(() => {
      // ignore
    });

    // Pump output stream into xterm. Stays alive while the chat is in the
    // background so scrollback keeps filling.
    live.streamFiber = Effect.runFork(
      Stream.runForEach(client["pty.output"]({ ptyId: id }), (event) =>
        Effect.sync(() => {
          if (event._tag === "data") {
            term.write(event.bytes);
          } else {
            const note =
              event.exitCode === null
                ? "[process exited]"
                : `[process exited with code ${event.exitCode}]`;
            term.write(`\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);
          }
        }),
      ),
    );

    // Forward keystrokes to the pty.
    const dataDisposable = term.onData((data) => {
      void Effect.runPromise(client["pty.write"]({ ptyId: id, data })).catch(
        () => {
          // pty exited; ignore
        },
      );
    });

    // Send debounced resizes.
    const sendResize = () => {
      if (live.ptyId === null) return;
      void Effect.runPromise(
        client["pty.resize"]({
          ptyId: live.ptyId,
          cols: term.cols,
          rows: term.rows,
        }),
      ).catch(() => {
        // ignore
      });
    };
    const onTermResize = term.onResize(() => {
      if (live.resizeTimer !== null) window.clearTimeout(live.resizeTimer);
      live.resizeTimer = window.setTimeout(sendResize, 100);
    });
    live.disposables = {
      dispose: () => {
        dataDisposable.dispose();
        onTermResize.dispose();
      },
    };
  } catch (err) {
    if (live.disposed) return;
    // eslint-disable-next-line no-console
    console.error("[zuse] failed to open pty:", err);
    term.write(
      "\r\n\x1b[38;5;203mfailed to open terminal — see devtools console\x1b[0m\r\n",
    );
  }
}

/**
 * Mount a terminal into `container`. Reuses the live entry for `instanceId`
 * when one exists (reconnect — moves its DOM host into the new container, no
 * new PTY); otherwise creates the xterm + PTY lazily.
 */
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
    window.requestAnimationFrame(() => safeFit(existing));
    return;
  }
  registry.set(instanceId, makeLive(instanceId, container, opts));
}

/**
 * Unmount a terminal's DOM without killing it. The xterm, PTY, and output
 * stream stay alive so a background chat's shell keeps running; re-selecting
 * the chat re-`attach`es to the same live entry.
 */
export function detach(instanceId: string): void {
  const live = registry.get(instanceId);
  if (live === undefined) return;
  live.observer.disconnect();
  if (live.host.parentElement !== null) {
    live.host.parentElement.removeChild(live.host);
  }
}

/**
 * Permanently tear down a terminal: interrupt its stream, close the PTY,
 * dispose the xterm. Call only on explicit close (terminal tab closed, or its
 * owning chat archived/deleted).
 */
export function dispose(instanceId: string): void {
  const live = registry.get(instanceId);
  if (live === undefined) return;
  registry.delete(instanceId);
  live.disposed = true;
  live.observer.disconnect();
  window.removeEventListener("zuse:appearance-change", live.refreshTheme);
  live.disposables?.dispose();
  if (live.resizeTimer !== null) window.clearTimeout(live.resizeTimer);
  if (live.streamFiber !== null) {
    void Effect.runPromise(Fiber.interrupt(live.streamFiber));
  }
  if (live.ptyId !== null) {
    const id = live.ptyId;
    void getRpcClient().then((client) =>
      Effect.runPromise(client["pty.close"]({ ptyId: id })).catch(() => {
        // already closed
      }),
    );
  }
  if (live.host.parentElement !== null) {
    live.host.parentElement.removeChild(live.host);
  }
  live.term.dispose();
}

/** Tear down every live terminal. Wired to renderer unload below. */
export function disposeAll(): void {
  for (const id of [...registry.keys()]) dispose(id);
}

// Preserve the "PTYs die with the renderer" contract: a full reload no longer
// passes through any component unmount that closes the PTY, so close them here.
// Guard on `addEventListener` too — the test runner stubs a bare `window`.
if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("pagehide", disposeAll);
}
