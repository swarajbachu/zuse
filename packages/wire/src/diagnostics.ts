import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

const DiagnosticArtifactName = Schema.Literals([
  "manifest",
  "bundle-summary",
  "trace-summary",
  "recent-errors",
  "environment",
  "provider-status",
  "client-context",
  "redacted-session-events",
]);

const DiagnosticsLogEntry = Schema.Struct({
  createdAt: Schema.String,
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  source: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
});

const DiagnosticsUiAction = Schema.Struct({
  createdAt: Schema.String,
  action: Schema.String,
  detail: Schema.optional(Schema.String),
});

const DiagnosticsClientContext = Schema.Struct({
  view: Schema.optional(Schema.String),
  settingsSection: Schema.optional(Schema.String),
  activeMainTab: Schema.optional(Schema.String),
  selectedFolderId: Schema.optional(Schema.NullOr(Schema.String)),
  selectedChatId: Schema.optional(Schema.NullOr(Schema.String)),
  activeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  openFile: Schema.optional(Schema.NullOr(Schema.String)),
  rightSidebarOpen: Schema.optional(Schema.Boolean),
  leftSidebarOpen: Schema.optional(Schema.Boolean),
  recentUiActions: Schema.Array(DiagnosticsUiAction),
  rendererLogs: Schema.Array(DiagnosticsLogEntry),
  mainProcessLogs: Schema.Array(DiagnosticsLogEntry),
});

export class DiagnosticsExportResult extends Schema.Class<DiagnosticsExportResult>(
  "DiagnosticsExportResult",
)({
  diagnosticId: Schema.String,
  createdAt: Schema.DateFromString,
  bundlePath: Schema.String,
  summary: Schema.String,
  included: Schema.Array(DiagnosticArtifactName),
}) {}

export class DiagnosticsExportError extends Schema.TaggedErrorClass<DiagnosticsExportError>()(
  "DiagnosticsExportError",
  {
    reason: Schema.String,
  },
) {}

export const DiagnosticsExportRpc = Rpc.make("diagnostics.export", {
  payload: Schema.Struct({
    clientContext: Schema.optional(DiagnosticsClientContext),
  }),
  success: DiagnosticsExportResult,
  error: DiagnosticsExportError,
});
