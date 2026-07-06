import { Effect } from "effect";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppPaths } from "../app-paths.ts";

type DiagnosticFields = Record<string, unknown>;

const logPathFor = (paths: typeof AppPaths.Service): string =>
  process.env.ZUSE_RELAY_LINK_LOG?.trim() ||
  join(paths.userData, "logs", "relay-link.log");

const safeFields = (fields: DiagnosticFields): DiagnosticFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ]),
  );

export const appendRelayDiagnostic = (
  paths: typeof AppPaths.Service,
  event: string,
  fields: DiagnosticFields = {},
): Effect.Effect<void> =>
  Effect.sync(() => {
    const logPath = logPathFor(paths);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...safeFields(fields),
    });
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${line}\n`, "utf8");
    } catch {
      // Diagnostics are best-effort and must never break app behavior.
    }
  });
