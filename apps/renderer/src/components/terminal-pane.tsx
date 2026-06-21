import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerTerminal01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { type ReactNode, useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Effect, Fiber, Stream } from "effect";

import type { FolderId, PtyId, WorktreeId } from "@memoize/wire";

import { getRpcClient } from "../lib/rpc-client.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import {
  EMPTY_TERMINALS,
  type TerminalInstance,
  terminalsKey,
  useTerminalsStore,
} from "../store/terminals.ts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Right-pane terminal host. Owns the per-workspace terminal list + active
 * selection (`useTerminalsStore`) and mounts a `PtyTerminal` for every
 * instance, toggling visibility with `hidden` so switching between terminals
 * preserves each one's xterm scrollback and PTY connection.
 *
 * Terminals are ephemeral: closing the renderer kills every PTY because the
 * `PtyTerminal` cleanup runs on unmount. Persistence across reloads is out
 * of scope.
 */
function TerminalPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Renders a single terminal for one right-dock tab. The tab carries a
 * workspace-relative `slot`; this resolves it to the active workspace's Nth
 * terminal instance (seeding via `ensureSlot`) and mounts one `PtyTerminal`.
 * Plain shell on every workspace — setup moved to the inline creating card
 * and Run to the top bar.
 */
export function TerminalSlotPane({ slot }: { slot: number }) {
  const ctx = useActiveContext();
  const ready = ctx.status === "ready" && !ctx.worktreePending;

  if (ctx.status === "loading") {
    return <TerminalPlaceholder>Loading workspace…</TerminalPlaceholder>;
  }
  if (ctx.status === "empty") {
    return (
      <TerminalPlaceholder>
        No folder selected. Add or pick a folder on the left.
      </TerminalPlaceholder>
    );
  }
  if (ctx.worktreePending) {
    return <TerminalPlaceholder>Preparing worktree…</TerminalPlaceholder>;
  }
  if (!ready) return null;
  return (
    <PlainTerminalSlot
      folderId={ctx.folderId}
      worktreeId={ctx.worktreeId}
      rootPath={ctx.rootPath}
      slot={slot}
    />
  );
}

function PlainTerminalSlot({
  folderId,
  worktreeId,
  rootPath,
  slot,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  rootPath: string;
  slot: number;
}) {
  const key = terminalsKey(folderId, worktreeId);
  const list = useTerminalsStore((s) => s.byKey[key] ?? EMPTY_TERMINALS);
  const ensureSlot = useTerminalsStore((s) => s.ensureSlot);

  useEffect(() => {
    if (list.length <= slot) ensureSlot(key, slot, rootPath);
  }, [key, list.length, slot, ensureSlot, rootPath]);

  const inst = list[slot];
  if (inst === undefined) return null;
  return (
    <PtyTerminal
      folderId={folderId}
      cwd={inst.cwd}
      instanceId={inst.id}
      command={inst.command}
    />
  );
}

function TerminalWorkspace({
  folderId,
  worktreeId,
  rootPath,
  showFloatingAdd = false,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  rootPath: string;
  showFloatingAdd?: boolean;
}) {
  const key = terminalsKey(folderId, worktreeId);
  const list = useTerminalsStore((s) => s.byKey[key] ?? EMPTY_TERMINALS);
  const activeId = useTerminalsStore((s) => s.activeByKey[key] ?? null);
  const ensureSeed = useTerminalsStore((s) => s.ensureSeed);
  const add = useTerminalsStore((s) => s.add);
  const remove = useTerminalsStore((s) => s.remove);
  const setActive = useTerminalsStore((s) => s.setActive);

  const handleAdd = () => {
    add(key, rootPath);
  };
  const handleClose = (id: string) => {
    remove(key, id);
    // If the user closed the last one, seed a fresh terminal so the pane
    // is never empty — matches what a developer expects from a terminal
    // dock: there's always a shell waiting.
    if (list.length === 1) ensureSeed(key, rootPath);
  };

  useEffect(() => {
    if (list.length === 0) ensureSeed(key, rootPath);
  }, [key, list.length, ensureSeed, rootPath]);

  // A single terminal gets the full pane — the list sidebar only earns its
  // width once there's more than one shell to switch between. When it's
  // hidden, a floating "+" (revealed on hover) keeps "add a terminal" within
  // reach; adding a second one brings the sidebar back.
  const single = list.length <= 1;

  return (
    <div className="group/terminal flex h-full min-h-0 w-full">
      {single ? null : (
        <TerminalList
          instances={list}
          activeId={activeId}
          onAdd={handleAdd}
          onSelect={(id) => setActive(key, id)}
          onClose={handleClose}
        />
      )}
      <div className="relative flex min-w-0 flex-1 flex-col bg-background">
        {single && showFloatingAdd ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleAdd}
                  className="absolute right-2 top-2 z-10 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover/terminal:opacity-100"
                  aria-label="New terminal"
                >
                  <Plus className="size-3.5" strokeWidth={1.8} />
                </button>
              }
            />
            <TooltipPopup>New terminal</TooltipPopup>
          </Tooltip>
        ) : null}
        {list.map((inst) => (
          <div
            key={inst.id}
            hidden={inst.id !== activeId}
            className="absolute inset-0 flex"
          >
            <PtyTerminal
              folderId={folderId}
              cwd={inst.cwd}
              instanceId={inst.id}
              command={inst.command}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalList({
  instances,
  activeId,
  onAdd,
  onSelect,
  onClose,
}: {
  instances: ReadonlyArray<TerminalInstance>;
  activeId: string | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const count = instances.length;
  const label = count === 1 ? "1 Terminal" : `${count} Terminals`;
  return (
    <div className="flex w-44 shrink-0 flex-col border-r border-border bg-background/40">
      <div className="flex h-7 shrink-0 items-center justify-between gap-1 border-b border-border/60 px-2 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onAdd}
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                aria-label="New terminal"
              >
                <Plus className="size-3.5" strokeWidth={1.8} />
              </button>
            }
          />
          <TooltipPopup>New terminal</TooltipPopup>
        </Tooltip>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {instances.map((inst) => (
          <li key={inst.id}>
            <button
              type="button"
              onClick={() => onSelect(inst.id)}
              className={`group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] transition-colors ${
                inst.id === activeId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              <HugeiconsIcon icon={ComputerTerminal01Icon} className="size-3.5 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{inst.title}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Close ${inst.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(inst.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose(inst.id);
                  }
                }}
                className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
              >
                <X className="size-3" strokeWidth={1.8} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// xterm's canvas/webgl renderer takes literal color strings, not CSS vars,
// so we resolve our shadcn tokens to computed rgb() strings via a probe span.
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

export function PtyTerminal({
  folderId,
  cwd,
  instanceId,
  command,
}: {
  folderId: FolderId;
  cwd: string;
  instanceId: string;
  command?: TerminalInstance["command"];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: false,
      // Transparent canvas so the parent pane's `bg-background` shows through.
      // This keeps the terminal in sync with theme changes without re-mounting.
      allowTransparency: true,
      theme: {
        background: "rgba(0, 0, 0, 0)",
        foreground: readToken(container, "--foreground", "#e6e6e6"),
        cursor: readToken(container, "--primary", "#e6e6e6"),
        cursorAccent: readToken(container, "--background", "#0b0b0c"),
        selectionBackground: readToken(container, "--accent", "#2c2c33"),
        selectionForeground: readToken(container, "--accent-foreground", "#e6e6e6"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Don't fit synchronously — the parent grid hasn't laid out yet on first
    // render, so xterm's renderer has no dimensions and FitAddon throws
    // "Cannot read properties of undefined (reading 'dimensions')". The
    // ResizeObserver below fires once after observe with real measurements.
    const safeFit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // ignore — happens during teardown when the container is detached
      }
    };

    let cancelled = false;
    let ptyId: PtyId | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let streamFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let resizeTimer: number | null = null;

    const observer = new ResizeObserver(safeFit);
    observer.observe(container);
    window.requestAnimationFrame(safeFit);

    void (async () => {
      try {
        const client = await getRpcClient();
        if (cancelled) return;

        const { ptyId: id } = await Effect.runPromise(
          client.pty.open({
            cwd,
            cols: term.cols,
            rows: term.rows,
            command:
              command === undefined
                ? undefined
                : {
                    cmd: command.cmd,
                    args: [...command.args],
                    env: command.env,
                  },
          }),
        );
        if (cancelled) {
          void Effect.runPromise(client.pty.close({ ptyId: id }));
          return;
        }
        ptyId = id;
        safeFit();
        void Effect.runPromise(
          client.pty.resize({ ptyId: id, cols: term.cols, rows: term.rows }),
        ).catch(() => {
          // ignore
        });

        // Pump output stream into xterm.
        streamFiber = Effect.runFork(
          Stream.runForEach(client.pty.output({ ptyId: id }), (event) =>
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
        dataDisposable = term.onData((data) => {
          void Effect.runPromise(client.pty.write({ ptyId: id, data })).catch(
            () => {
              // pty exited; ignore
            },
          );
        });

        // Send debounced resizes.
        const sendResize = () => {
          if (ptyId === null) return;
          void Effect.runPromise(
            client.pty.resize({ ptyId, cols: term.cols, rows: term.rows }),
          ).catch(() => {
            // ignore
          });
        };
        const onTermResize = term.onResize(() => {
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(sendResize, 100);
        });
        // Also tie the disposable cleanup chain.
        const prevDispose = dataDisposable.dispose.bind(dataDisposable);
        dataDisposable = {
          dispose: () => {
            prevDispose();
            onTermResize.dispose();
          },
        };
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[memoize] failed to open pty:", err);
        term.write(
          "\r\n\x1b[38;5;203mfailed to open terminal — see devtools console\x1b[0m\r\n",
        );
      }
    })();

    return () => {
      cancelled = true;
      observer.disconnect();
      dataDisposable?.dispose();
      if (streamFiber !== null) {
        void Effect.runPromise(Fiber.interrupt(streamFiber));
      }
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (ptyId !== null) {
        const id = ptyId;
        void getRpcClient().then((client) =>
          Effect.runPromise(client.pty.close({ ptyId: id })).catch(() => {
            // already closed
          }),
        );
      }
      term.dispose();
    };
    // Instance id is part of the deps so swapping instances re-opens cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, cwd, instanceId]);

  return (
    <div ref={containerRef} className="h-full w-full bg-background p-2" />
  );
}
