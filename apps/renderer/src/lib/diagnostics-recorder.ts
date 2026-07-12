export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  readonly createdAt: string;
  readonly level: DiagnosticLogLevel;
  readonly source: string;
  readonly message: string;
  readonly detail?: string;
}

export interface DiagnosticUiAction {
  readonly createdAt: string;
  readonly action: string;
  readonly detail?: string;
}

const LOG_LIMIT = 200;
const ACTION_LIMIT = 100;
const rendererLogs: DiagnosticLogEntry[] = [];
const uiActions: DiagnosticUiAction[] = [];

let installed = false;

function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function stringifyDiagnosticPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function recordDiagnosticEvent(input: {
  readonly level: DiagnosticLogLevel;
  readonly source: string;
  readonly message: string;
  readonly detail?: string;
}): void {
  pushBounded(
    rendererLogs,
    {
      createdAt: new Date().toISOString(),
      level: input.level,
      source: input.source,
      message: input.message.slice(0, 2000),
      detail: input.detail?.slice(0, 4000),
    },
    LOG_LIMIT,
  );
}

export function recordUiAction(action: string, detail?: string): void {
  pushBounded(
    uiActions,
    {
      createdAt: new Date().toISOString(),
      action,
      detail: detail?.slice(0, 1000),
    },
    ACTION_LIMIT,
  );
}

export function getRendererDiagnosticLogs(): ReadonlyArray<DiagnosticLogEntry> {
  return rendererLogs.slice();
}

export function getDiagnosticUiActions(): ReadonlyArray<DiagnosticUiAction> {
  return uiActions.slice();
}

export function installRendererDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    recordDiagnosticEvent({
      level: "warn",
      source: "renderer.console",
      message: args.map(stringifyDiagnosticPart).join(" "),
    });
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    recordDiagnosticEvent({
      level: "error",
      source: "renderer.console",
      message: args.map(stringifyDiagnosticPart).join(" "),
    });
    originalError(...args);
  };

  window.addEventListener("error", (event) => {
    recordDiagnosticEvent({
      level: "error",
      source: "renderer.window.error",
      message: event.message,
      detail: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordDiagnosticEvent({
      level: "error",
      source: "renderer.unhandledrejection",
      message: stringifyDiagnosticPart(event.reason),
    });
  });
}
