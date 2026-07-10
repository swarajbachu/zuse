import { SqlClient } from "effect/unstable/sql";
import { Effect, Layer } from "effect";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DiagnosticsExportError,
  DiagnosticsExportResult,
  type AgentAvailability,
} from "@zuse/contracts";

import packageJson from "../../../package.json" with { type: "json" };
import { AppPaths } from "../../app-paths.ts";
import { ProviderService } from "../../provider/services/provider-service.ts";
import { DiagnosticsService } from "../services/diagnostics-service.ts";

const MAX_RECENT_ERRORS = 20;
const MAX_SESSION_EVENTS = 8;
const MAX_REDACTED_EVENTS_PER_FILE = 200;
const MAX_TEXT_PREVIEW = 240;

interface RecentErrorRow {
  readonly message_id: string;
  readonly session_id: string;
  readonly chat_id: string | null;
  readonly project_id: string;
  readonly provider_id: string;
  readonly model: string;
  readonly kind: string;
  readonly content_json: string;
  readonly created_at: string;
}

interface SessionEventFile {
  readonly sessionId: string;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly eventCount: number;
  readonly truncated: boolean;
  readonly events: ReadonlyArray<unknown>;
}

type BundleArtifactName =
  | "manifest"
  | "bundle-summary"
  | "trace-summary"
  | "recent-errors"
  | "environment"
  | "provider-status"
  | "client-context"
  | "redacted-session-events";

function safeIsoForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function truncate(value: string): string {
  return value.length <= MAX_TEXT_PREVIEW
    ? value
    : `${value.slice(0, MAX_TEXT_PREVIEW)}...`;
}

function summarizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      redacted: true,
      length: value.length,
      preview: truncate(value),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(summarizeUnknown);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => {
        if (
          key.toLowerCase().includes("text") ||
          key.toLowerCase().includes("prompt") ||
          key.toLowerCase().includes("output") ||
          key.toLowerCase().includes("summary")
        ) {
          return [key, summarizeUnknown(entry)] as const;
        }
        return [key, summarizeUnknown(entry)] as const;
      },
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function readErrorMessage(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const message = (parsed as { readonly message?: unknown }).message;
      return typeof message === "string"
        ? truncate(message)
        : "Error message unavailable";
    }
    return truncate(JSON.stringify(summarizeUnknown(parsed)));
  } catch {
    return "Could not parse persisted error content.";
  }
}

function listSessionEventFiles(
  userData: string,
): ReadonlyArray<{ projectId: string; path: string }> {
  const root = join(userData, "sessions");
  if (!existsSync(root)) return [];
  const files: Array<{ projectId: string; path: string; mtimeMs: number }> = [];
  for (const projectId of readdirSync(root)) {
    const projectDir = join(root, projectId);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const entry of readdirSync(projectDir)) {
      if (!entry.endsWith(".events.ndjson")) continue;
      const path = join(projectDir, entry);
      const stat = statSync(path);
      files.push({ projectId, path, mtimeMs: stat.mtimeMs });
    }
  }
  return [...files]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_SESSION_EVENTS)
    .map(({ projectId, path }) => ({ projectId, path }));
}

function redactSessionEventFile(input: {
  readonly projectId: string;
  readonly path: string;
}): SessionEventFile {
  const text = readFileSync(input.path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = lines.slice(-MAX_REDACTED_EVENTS_PER_FILE).flatMap((line) => {
    try {
      return [summarizeUnknown(JSON.parse(line) as unknown)];
    } catch {
      return [{ parseError: true, bytes: Buffer.byteLength(line) }];
    }
  });
  const fileName = basename(input.path);
  const sessionId = fileName.replace(/\.events\.ndjson$/, "");
  return {
    projectId: input.projectId,
    sessionId,
    sourcePath: input.path,
    eventCount: lines.length,
    truncated: lines.length > MAX_REDACTED_EVENTS_PER_FILE,
    events,
  };
}

function summarizeProvider(provider: AgentAvailability) {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    cliInstalled: provider.cliInstalled,
    cliVersion: provider.cliVersion,
    cliLoggedIn: provider.cliLoggedIn,
    hasApiKey: provider.hasApiKey,
    cliVersionStatus: provider.cliVersionStatus,
    latestVersionStatus: provider.latestVersionStatus,
    authStatus: provider.authStatus,
    authType: provider.authType,
    status: provider.status,
    statusMessage: provider.statusMessage,
    lastCheckedAt: provider.lastCheckedAt,
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, prettyJson(value), "utf8");
}

function buildSummary(input: {
  readonly diagnosticId: string;
  readonly bundlePath: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly latestFailures: ReadonlyArray<{
    readonly span: string;
    readonly message: string;
  }>;
  readonly providerCount: number;
}): string {
  const topFailure = input.latestFailures[0];
  return [
    `Diagnostic ID: ${input.diagnosticId}`,
    `Bundle: ${input.bundlePath}`,
    `App: Zuse ${input.version}`,
    `Platform: ${input.platform}-${input.arch} ${input.osRelease}`,
    `Latest failure: ${topFailure ? `${topFailure.span} - ${topFailure.message}` : "none found"}`,
    `Providers captured: ${input.providerCount}`,
  ].join("\n");
}

export const DiagnosticsServiceLive = Layer.effect(
  DiagnosticsService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const paths = yield* AppPaths;
    const providerService = yield* ProviderService;

    const exportBundle = (payload: { readonly clientContext?: unknown }) =>
      Effect.gen(function* () {
        const createdAt = new Date();
        const diagnosticId = `diag_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const bundleDir = join(paths.userData, "diagnostics", diagnosticId);
        yield* Effect.try(() => mkdirSync(bundleDir, { recursive: true }));

        const recentErrorRows = yield* sql<RecentErrorRow>`
            SELECT
              m.id AS message_id,
              m.session_id,
              s.chat_id,
              s.project_id,
              s.provider_id,
              s.model,
              m.kind,
              m.content_json,
              m.created_at
            FROM messages m
            INNER JOIN sessions s ON s.id = m.session_id
            WHERE m.kind = 'error'
            ORDER BY m.created_at DESC
            LIMIT ${MAX_RECENT_ERRORS}
          `;

        const providers = yield* providerService
          .availability()
          .pipe(Effect.orElseSucceed(() => []));

        const latestFailures = recentErrorRows.map((row) => ({
          traceId: null,
          span: `message.${row.kind}`,
          message: readErrorMessage(row.content_json),
          chatId: row.chat_id,
          sessionId: row.session_id,
          providerId: row.provider_id,
          model: row.model,
          occurredAt: row.created_at,
        }));

        const commonFailureMap = new Map<
          string,
          { span: string; count: number; errorTag: string }
        >();
        for (const failure of latestFailures) {
          const key = `${failure.span}:${failure.message}`;
          const existing = commonFailureMap.get(key);
          commonFailureMap.set(key, {
            span: failure.span,
            count: (existing?.count ?? 0) + 1,
            errorTag: failure.message,
          });
        }

        const traceSummary = {
          latestFailures,
          slowestSpans: [],
          commonFailures: [...commonFailureMap.values()].sort(
            (left, right) => right.count - left.count,
          ),
        };
        const recentErrors = {
          errors: latestFailures,
        };
        const environment = {
          app: "zuse",
          version: packageJson.version,
          createdAt: createdAt.toISOString(),
          platform: platform(),
          arch: arch(),
          osRelease: release(),
          node: process.version,
        };
        const providerStatus = {
          providers: providers.map(summarizeProvider),
        };
        const sessionEvents = yield* Effect.try(() => ({
          files: listSessionEventFiles(paths.userData).map(
            redactSessionEventFile,
          ),
        }));
        const artifacts: Record<string, unknown> = {
          "trace-summary": traceSummary,
          "recent-errors": recentErrors,
          environment,
          "provider-status": providerStatus,
          "redacted-session-events": sessionEvents,
        };
        if (payload.clientContext !== undefined) {
          artifacts["client-context"] = payload.clientContext;
        }

        const artifactSizes = Object.fromEntries(
          Object.entries(artifacts).map(([name, artifact]) => [
            name,
            jsonByteLength(artifact),
          ]),
        );
        const diagnosticWarnings = [
          latestFailures.length === 0
            ? "No persisted message errors were captured."
            : null,
          payload.clientContext === undefined
            ? "No renderer client context was provided."
            : null,
        ].filter((warning): warning is string => warning !== null);
        const bundleSummary = {
          diagnosticId,
          generatedFor: "github-bug-report",
          attachFileToIssue: true,
          pasteJsonOnlyIfAttachmentFails: true,
          artifactSizes,
          diagnosticWarnings,
        };
        artifacts["bundle-summary"] = bundleSummary;
        artifactSizes["bundle-summary"] = jsonByteLength(bundleSummary);

        const included: BundleArtifactName[] = [
          "manifest",
          "bundle-summary",
          "trace-summary",
          "recent-errors",
          "environment",
          "provider-status",
          ...(payload.clientContext !== undefined
            ? (["client-context"] as const)
            : []),
          "redacted-session-events",
        ];
        const manifest = {
          app: "zuse",
          version: packageJson.version,
          createdAt: createdAt.toISOString(),
          platform: `${platform()}-${arch()}`,
          diagnosticId,
          included,
          redaction: {
            default:
              "text fields are summarized with length and short previews",
            rawPromptsIncluded: false,
            rawTranscriptsIncluded: false,
          },
        };

        yield* Effect.try(() => {
          writeJson(join(bundleDir, "manifest.json"), manifest);
          writeJson(join(bundleDir, "bundle-summary.json"), bundleSummary);
          writeJson(join(bundleDir, "trace-summary.json"), traceSummary);
          writeJson(join(bundleDir, "recent-errors.json"), recentErrors);
          writeJson(join(bundleDir, "environment.json"), environment);
          writeJson(join(bundleDir, "provider-status.json"), providerStatus);
          if (payload.clientContext !== undefined) {
            writeJson(join(bundleDir, "client-context.json"), payload.clientContext);
          }
          writeJson(
            join(bundleDir, "session-events-redacted.json"),
            sessionEvents,
          );
        });

        const bundlePath = join(
          paths.userData,
          "diagnostics",
          `zuse-diagnostics-${safeIsoForFile(createdAt)}-${diagnosticId}.json`,
        );
        const bundle = {
          manifest,
          artifacts,
        };
        yield* Effect.try(() => {
          writeJson(bundlePath, bundle);
          copyFileSync(bundlePath, join(bundleDir, basename(bundlePath)));
        });

        const summary = buildSummary({
          diagnosticId,
          bundlePath,
          version: packageJson.version,
          platform: platform(),
          arch: arch(),
          osRelease: release(),
          latestFailures,
          providerCount: providers.length,
        });
        return DiagnosticsExportResult.make({
          diagnosticId,
          createdAt,
          bundlePath,
          summary,
          included,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DiagnosticsExportError({
              reason:
                cause instanceof Error
                  ? cause.message
                  : "Failed to export diagnostics.",
            }),
        ),
      );

    return { exportBundle } as const;
  }),
);
