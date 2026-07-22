import * as FileSystem from "expo-file-system/legacy";
import { captureMobileAnalytics } from "./analytics";

export type CrashReport = {
  readonly id: string;
  readonly at: string;
  readonly context: string;
  readonly message: string;
  readonly stack?: string;
  readonly componentStack?: string;
};

const PATH = `${FileSystem.documentDirectory ?? ""}zuse-last-crash.json`;
let installed = false;

type NativeErrorUtils = {
  readonly getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
  readonly setGlobalHandler?: (
    handler: (error: unknown, isFatal?: boolean) => void,
  ) => void;
};

const errorUtils = (): NativeErrorUtils | undefined =>
  (globalThis as unknown as { readonly ErrorUtils?: NativeErrorUtils })
    .ErrorUtils;

export const installCrashReporting = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const utils = errorUtils();
  const previous = utils?.getGlobalHandler?.();
  utils?.setGlobalHandler?.((error, isFatal) => {
    const errorCode = isFatal === true ? "fatal-js" : "global-js";
    captureMobileAnalytics("app error", {
      error_code: errorCode,
      error_fingerprint: errorCode,
      fatal: isFatal === true,
    });
    void captureMobileError(error, {
      context: errorCode,
    });
    previous?.(error, isFatal);
  });
};

export const captureMobileError = async (
  error: unknown,
  input: { readonly context: string; readonly componentStack?: string },
): Promise<void> => {
  const report = buildReport(error, input);
  console.error("[mobile:crash]", report);
  try {
    await FileSystem.writeAsStringAsync(PATH, JSON.stringify(report, null, 2));
  } catch {
    // Crash reporting must never become another crash source.
  }
};

export const readLastCrashReport = async (): Promise<CrashReport | null> => {
  try {
    const info = await FileSystem.getInfoAsync(PATH);
    if (!info.exists) {
      return null;
    }
    return JSON.parse(await FileSystem.readAsStringAsync(PATH)) as CrashReport;
  } catch {
    return null;
  }
};

export const clearLastCrashReport = async (): Promise<void> => {
  try {
    await FileSystem.deleteAsync(PATH, { idempotent: true });
  } catch {
    // Best effort.
  }
};

const buildReport = (
  error: unknown,
  input: { readonly context: string; readonly componentStack?: string },
): CrashReport => {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : safeString(error));
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    context: input.context,
    message: err.message,
    stack: err.stack,
    componentStack: input.componentStack,
  };
};

const safeString = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
