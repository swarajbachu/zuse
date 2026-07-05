import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import * as fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import * as Path from "node:path";

import {
  type FolderId,
  type ProviderId,
  RepositorySettings,
  type RepositorySettingsFile,
  type RepositorySettingsPatch,
  type RuntimeMode,
} from "@zuse/wire";

import { RepositorySettingsService } from "../services/repository-settings-service.ts";

interface Row {
  readonly project_id: string;
  readonly default_provider_id: string | null;
  readonly default_model: string | null;
  readonly default_runtime_mode: string | null;
  readonly auto_create_worktree: number;
  readonly worktree_base_dir: string | null;
  readonly archive_cleanup_script: string | null;
  readonly archive_remove_worktree: number;
  readonly setup_script: string | null;
  readonly run_script: string | null;
  readonly auto_run_after_setup: number;
  readonly environment_variables_json: string | null;
}

type MutableRepositorySettingsFile = {
  -readonly [K in keyof RepositorySettingsFile]: RepositorySettingsFile[K];
} & {
  environmentVariables: Record<string, string>;
};

const isProviderId = (v: unknown): v is ProviderId =>
  v === "claude" ||
  v === "codex" ||
  v === "grok" ||
  v === "cursor" ||
  v === "gemini" ||
  v === "opencode";

const isRuntimeMode = (v: unknown): v is RuntimeMode =>
  v === "approval-required" ||
  v === "auto-accept-edits" ||
  v === "auto-accept-edits-and-bash" ||
  v === "full-access";

const cleanScript = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? value! : null;
};

const emptyFileSettings = (): RepositorySettingsFile => ({
  schemaVersion: 1,
  defaultProviderId: null,
  defaultModel: null,
  defaultRuntimeMode: null,
  autoCreateWorktree: false,
  worktreeBaseDir: null,
  archiveCleanupScript: null,
  archiveRemoveWorktree: false,
  setupScript: null,
  runScript: null,
  autoRunAfterSetup: false,
  environmentVariables: {},
  fileIncludeGlobs: "",
});

const parseEnvJson = (value: string | null): Record<string, string> => {
  if (value === null || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string") out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
};

const parseTomlString = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseTomlNullableString = (raw: string): string | null => {
  if (raw.trim() === "null") return null;
  const parsed = parseTomlString(raw);
  return parsed.length === 0 ? null : parsed;
};

const parseTomlBoolean = (raw: string, fallback: boolean): boolean => {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return fallback;
};

const settingsDir = (repoPath: string): string => Path.join(repoPath, ".zuse");
const jsonPath = (repoPath: string): string =>
  Path.join(settingsDir(repoPath), "settings.json");
const tomlPath = (repoPath: string): string =>
  Path.join(settingsDir(repoPath), "settings.toml");
const worktreeIncludePath = (repoPath: string): string =>
  Path.join(repoPath, ".worktreeinclude");

const readLegacyWorktreeInclude = (repoPath: string): string => {
  const filePath = worktreeIncludePath(repoPath);
  if (!fsSync.existsSync(filePath)) return "";
  try {
    return fsSync
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join("\n");
  } catch {
    return "";
  }
};

const parseTomlSettings = (repoPath: string): RepositorySettingsFile => {
  const filePath = tomlPath(repoPath);
  const fallback: RepositorySettingsFile = {
    ...emptyFileSettings(),
    fileIncludeGlobs: readLegacyWorktreeInclude(repoPath),
  };
  if (!fsSync.existsSync(filePath)) return fallback;
  const settings: MutableRepositorySettingsFile = {
    ...fallback,
    environmentVariables: {},
  };
  let section = "";
  const legacyIncludeSectionValues: string[] = [];
  let pendingArrayKey: "file_include_globs" | null = null;
  let pendingArrayRaw = "";
  const parseTomlStringArray = (raw: string): string[] =>
    [...raw.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/g)]
      .map((match) => parseTomlString(match[0] ?? ""))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  const finishPendingArray = (): void => {
    if (pendingArrayKey === "file_include_globs") {
      settings.fileIncludeGlobs =
        parseTomlStringArray(pendingArrayRaw).join("\n");
    }
    pendingArrayKey = null;
    pendingArrayRaw = "";
  };
  for (const line of fsSync.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (pendingArrayKey !== null) {
      pendingArrayRaw = `${pendingArrayRaw}\n${trimmed}`;
      if (trimmed.includes("]")) finishPendingArray();
      continue;
    }
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (section === "") {
      if (key === "schemaVersion") {
        // v1 is the only supported shape; keep parsing with v1 defaults if a
        // future value appears so a hand-edit does not blank settings.
      } else if (key === "defaultProviderId") {
        const parsed = parseTomlNullableString(value);
        settings.defaultProviderId = isProviderId(parsed)
          ? parsed
          : parsed === null
            ? null
            : settings.defaultProviderId;
      } else if (key === "defaultModel") {
        settings.defaultModel = parseTomlNullableString(value);
      } else if (key === "defaultRuntimeMode") {
        const parsed = parseTomlNullableString(value);
        settings.defaultRuntimeMode = isRuntimeMode(parsed)
          ? parsed
          : parsed === null
            ? null
            : settings.defaultRuntimeMode;
      } else if (key === "autoCreateWorktree") {
        settings.autoCreateWorktree = parseTomlBoolean(
          value,
          settings.autoCreateWorktree,
        );
      } else if (key === "worktreeBaseDir") {
        settings.worktreeBaseDir = parseTomlNullableString(value);
      } else if (key === "archiveRemoveWorktree") {
        settings.archiveRemoveWorktree = parseTomlBoolean(
          value,
          settings.archiveRemoveWorktree,
        );
      } else if (key === "file_include_globs" && value.trim().startsWith("[")) {
        pendingArrayKey = "file_include_globs";
        pendingArrayRaw = value;
        if (value.includes("]")) finishPendingArray();
      } else if (key === "file_include_globs") {
        settings.fileIncludeGlobs = parseTomlString(value);
      }
    } else if (section === "scripts") {
      if (key === "setup")
        settings.setupScript = parseTomlNullableString(value);
      else if (key === "run")
        settings.runScript = parseTomlNullableString(value);
      else if (key === "archive") {
        settings.archiveCleanupScript = parseTomlNullableString(value);
      } else if (key === "auto_run_after_setup") {
        settings.autoRunAfterSetup = value.trim() === "true";
      }
    } else if (section === "environment_variables") {
      settings.environmentVariables[key] = parseTomlString(value);
    } else if (section === "file_include_globs") {
      const parsed = parseTomlNullableString(value)?.trim() ?? "";
      if (parsed.length > 0) legacyIncludeSectionValues.push(parsed);
    }
  }
  if (pendingArrayKey !== null) finishPendingArray();
  if (legacyIncludeSectionValues.length > 0) {
    settings.fileIncludeGlobs = legacyIncludeSectionValues.join("\n");
  }
  return settings;
};

const coerceJsonSettings = (
  raw: unknown,
  fallback: RepositorySettingsFile,
): RepositorySettingsFile => {
  if (raw === null || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const env =
    typeof obj.environmentVariables === "object" &&
    obj.environmentVariables !== null
      ? (obj.environmentVariables as Record<string, unknown>)
      : null;
  const environmentVariables = { ...fallback.environmentVariables };
  if (env !== null) {
    for (const [key, val] of Object.entries(env)) {
      if (typeof val === "string") environmentVariables[key] = val;
    }
  }
  return {
    schemaVersion: 1,
    defaultProviderId: isProviderId(obj.defaultProviderId)
      ? obj.defaultProviderId
      : fallback.defaultProviderId,
    defaultModel:
      typeof obj.defaultModel === "string"
        ? obj.defaultModel
        : obj.defaultModel === null
          ? null
          : fallback.defaultModel,
    defaultRuntimeMode: isRuntimeMode(obj.defaultRuntimeMode)
      ? obj.defaultRuntimeMode
      : fallback.defaultRuntimeMode,
    autoCreateWorktree:
      typeof obj.autoCreateWorktree === "boolean"
        ? obj.autoCreateWorktree
        : fallback.autoCreateWorktree,
    worktreeBaseDir:
      typeof obj.worktreeBaseDir === "string"
        ? obj.worktreeBaseDir
        : obj.worktreeBaseDir === null
          ? null
          : fallback.worktreeBaseDir,
    archiveCleanupScript:
      typeof obj.archiveCleanupScript === "string"
        ? cleanScript(obj.archiveCleanupScript)
        : obj.archiveCleanupScript === null
          ? null
          : fallback.archiveCleanupScript,
    archiveRemoveWorktree:
      typeof obj.archiveRemoveWorktree === "boolean"
        ? obj.archiveRemoveWorktree
        : fallback.archiveRemoveWorktree,
    setupScript:
      typeof obj.setupScript === "string"
        ? cleanScript(obj.setupScript)
        : obj.setupScript === null
          ? null
          : fallback.setupScript,
    runScript:
      typeof obj.runScript === "string"
        ? cleanScript(obj.runScript)
        : obj.runScript === null
          ? null
          : fallback.runScript,
    autoRunAfterSetup:
      typeof obj.autoRunAfterSetup === "boolean"
        ? obj.autoRunAfterSetup
        : fallback.autoRunAfterSetup,
    environmentVariables,
    fileIncludeGlobs:
      typeof obj.fileIncludeGlobs === "string"
        ? obj.fileIncludeGlobs
        : typeof obj.file_include_globs === "string"
          ? obj.file_include_globs
          : fallback.fileIncludeGlobs,
  };
};

const readJsonSettings = (
  repoPath: string,
  fallback: RepositorySettingsFile,
): RepositorySettingsFile | null => {
  const filePath = jsonPath(repoPath);
  if (!fsSync.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
    return coerceJsonSettings(raw, fallback);
  } catch {
    return null;
  }
};

const tomlString = (value: string): string => JSON.stringify(value);

const tomlNullableString = (value: string | null): string =>
  value === null ? '""' : tomlString(value);

const includeGlobValues = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const tomlStringArray = (key: string, values: string[]): string[] => {
  if (values.length === 0) return [`${key} = []`];
  return [
    `${key} = [`,
    ...values.map((value) => `  ${tomlString(value)},`),
    "]",
  ];
};

const writeTomlSettings = (
  repoPath: string,
  settings: RepositorySettingsFile,
): void => {
  const dir = settingsDir(repoPath);
  fsSync.mkdirSync(dir, { recursive: true });
  const filePath = tomlPath(repoPath);
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  const lines = [
    "# Zuse repository settings. Commit this file to share setup with your team.",
    "# Add files below that should be linked from the main checkout into every Zuse worktree.",
    "",
    `schemaVersion = ${settings.schemaVersion}`,
    `defaultProviderId = ${tomlNullableString(settings.defaultProviderId)}`,
    `defaultModel = ${tomlNullableString(settings.defaultModel)}`,
    `defaultRuntimeMode = ${tomlNullableString(settings.defaultRuntimeMode)}`,
    `autoCreateWorktree = ${settings.autoCreateWorktree ? "true" : "false"}`,
    `worktreeBaseDir = ${tomlNullableString(settings.worktreeBaseDir)}`,
    `archiveRemoveWorktree = ${settings.archiveRemoveWorktree ? "true" : "false"}`,
    "",
    ...tomlStringArray(
      "file_include_globs",
      includeGlobValues(settings.fileIncludeGlobs),
    ),
    "",
    "[scripts]",
    `setup = ${tomlNullableString(cleanScript(settings.setupScript))}`,
    `run = ${tomlNullableString(cleanScript(settings.runScript))}`,
    `archive = ${tomlNullableString(cleanScript(settings.archiveCleanupScript))}`,
    `auto_run_after_setup = ${settings.autoRunAfterSetup ? "true" : "false"}`,
    "",
    "[environment_variables]",
    ...Object.entries(settings.environmentVariables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key} = ${tomlString(value)}`),
    "",
  ];
  fsSync.writeFileSync(tmp, lines.join("\n"), "utf8");
  fsSync.renameSync(tmp, filePath);
};

const removeLegacyJsonSettings = (repoPath: string): void => {
  try {
    fsSync.rmSync(jsonPath(repoPath), { force: true });
  } catch {
    // Best-effort migration cleanup only.
  }
};

const fileToSettings = (
  projectId: FolderId,
  file: RepositorySettingsFile,
): RepositorySettings =>
  RepositorySettings.make({
    projectId,
    defaultProviderId: file.defaultProviderId,
    defaultModel: file.defaultModel,
    defaultRuntimeMode: file.defaultRuntimeMode,
    autoCreateWorktree: file.autoCreateWorktree,
    worktreeBaseDir: file.worktreeBaseDir,
    archiveCleanupScript: cleanScript(file.archiveCleanupScript),
    archiveRemoveWorktree: file.archiveRemoveWorktree,
    setupScript: cleanScript(file.setupScript),
    runScript: cleanScript(file.runScript),
    autoRunAfterSetup: file.autoRunAfterSetup,
    environmentVariables: file.environmentVariables,
    fileIncludeGlobs: file.fileIncludeGlobs,
  });

const settingsToFile = (
  settings: RepositorySettings,
): RepositorySettingsFile => ({
  schemaVersion: 1,
  defaultProviderId: settings.defaultProviderId,
  defaultModel: settings.defaultModel,
  defaultRuntimeMode: settings.defaultRuntimeMode,
  autoCreateWorktree: settings.autoCreateWorktree,
  worktreeBaseDir: settings.worktreeBaseDir,
  archiveCleanupScript: cleanScript(settings.archiveCleanupScript),
  archiveRemoveWorktree: settings.archiveRemoveWorktree,
  setupScript: cleanScript(settings.setupScript),
  runScript: cleanScript(settings.runScript),
  autoRunAfterSetup: settings.autoRunAfterSetup,
  environmentVariables: settings.environmentVariables,
  fileIncludeGlobs: settings.fileIncludeGlobs,
});

const rowToFile = (
  row: Row | null,
  fallback: RepositorySettingsFile,
): RepositorySettingsFile => {
  if (row === null) return fallback;
  return {
    schemaVersion: 1,
    defaultProviderId: isProviderId(row.default_provider_id)
      ? row.default_provider_id
      : fallback.defaultProviderId,
    defaultModel: row.default_model ?? fallback.defaultModel,
    defaultRuntimeMode: isRuntimeMode(row.default_runtime_mode)
      ? row.default_runtime_mode
      : fallback.defaultRuntimeMode,
    autoCreateWorktree: row.auto_create_worktree === 1,
    worktreeBaseDir: row.worktree_base_dir ?? fallback.worktreeBaseDir,
    archiveCleanupScript:
      cleanScript(row.archive_cleanup_script) ?? fallback.archiveCleanupScript,
    archiveRemoveWorktree: row.archive_remove_worktree === 1,
    setupScript: cleanScript(row.setup_script) ?? fallback.setupScript,
    runScript: cleanScript(row.run_script) ?? fallback.runScript,
    autoRunAfterSetup:
      row.auto_run_after_setup === 1 || fallback.autoRunAfterSetup,
    environmentVariables: {
      ...fallback.environmentVariables,
      ...parseEnvJson(row.environment_variables_json),
    },
    fileIncludeGlobs: fallback.fileIncludeGlobs,
  };
};

const applyPatch = (
  projectId: FolderId,
  current: RepositorySettings,
  patch: RepositorySettingsPatch,
): RepositorySettings =>
  RepositorySettings.make({
    projectId,
    defaultProviderId:
      "defaultProviderId" in patch
        ? (patch.defaultProviderId ?? null)
        : current.defaultProviderId,
    defaultModel:
      "defaultModel" in patch
        ? (patch.defaultModel ?? null)
        : current.defaultModel,
    defaultRuntimeMode:
      "defaultRuntimeMode" in patch
        ? (patch.defaultRuntimeMode ?? null)
        : current.defaultRuntimeMode,
    autoCreateWorktree: patch.autoCreateWorktree ?? current.autoCreateWorktree,
    worktreeBaseDir:
      "worktreeBaseDir" in patch
        ? (patch.worktreeBaseDir ?? null)
        : current.worktreeBaseDir,
    archiveCleanupScript:
      "archiveCleanupScript" in patch
        ? cleanScript(patch.archiveCleanupScript)
        : current.archiveCleanupScript,
    archiveRemoveWorktree:
      patch.archiveRemoveWorktree ?? current.archiveRemoveWorktree,
    setupScript:
      "setupScript" in patch
        ? cleanScript(patch.setupScript)
        : current.setupScript,
    runScript:
      "runScript" in patch ? cleanScript(patch.runScript) : current.runScript,
    autoRunAfterSetup: patch.autoRunAfterSetup ?? current.autoRunAfterSetup,
    environmentVariables:
      patch.environmentVariables ?? current.environmentVariables,
    fileIncludeGlobs: patch.fileIncludeGlobs ?? current.fileIncludeGlobs,
  });

export const RepositorySettingsServiceLive = Layer.effect(
  RepositorySettingsService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(repository_settings)
    `.pipe(Effect.orDie);
    const hasColumn = (name: string): boolean =>
      columns.some((column) => column.name === name);
    if (!hasColumn("archive_cleanup_script")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN archive_cleanup_script TEXT
      `.pipe(Effect.orDie);
    }
    if (!hasColumn("archive_remove_worktree")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN archive_remove_worktree INTEGER NOT NULL DEFAULT 0
      `.pipe(Effect.orDie);
    }
    if (!hasColumn("setup_script")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN setup_script TEXT
      `.pipe(Effect.orDie);
    }
    if (!hasColumn("run_script")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN run_script TEXT
      `.pipe(Effect.orDie);
    }
    if (!hasColumn("auto_run_after_setup")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN auto_run_after_setup INTEGER NOT NULL DEFAULT 0
      `.pipe(Effect.orDie);
    }
    if (!hasColumn("environment_variables_json")) {
      yield* sql`
        ALTER TABLE repository_settings
          ADD COLUMN environment_variables_json TEXT
      `.pipe(Effect.orDie);
    }

    const projectPath = (projectId: FolderId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly path: string }>`
          SELECT path FROM projects WHERE id = ${projectId} LIMIT 1
        `.pipe(Effect.orDie);
        return rows[0]?.path ?? null;
      });

    const legacyRow = (projectId: FolderId) =>
      sql<Row>`
        SELECT project_id, default_provider_id, default_model,
               default_runtime_mode, auto_create_worktree, worktree_base_dir,
               archive_cleanup_script, archive_remove_worktree,
               setup_script, run_script, auto_run_after_setup,
               environment_variables_json
        FROM repository_settings
        WHERE project_id = ${projectId}
        LIMIT 1
      `.pipe(Effect.orDie);

    const clearLegacyRow = (projectId: FolderId) =>
      sql`DELETE FROM repository_settings WHERE project_id = ${projectId}`.pipe(
        Effect.orDie,
      );

    const resolveFile = (projectId: FolderId, repoPath: string) =>
      Effect.gen(function* () {
        const toml = parseTomlSettings(repoPath);
        const json = readJsonSettings(repoPath, toml);
        if (json !== null) {
          const rows = yield* legacyRow(projectId);
          if (rows[0] !== undefined) yield* clearLegacyRow(projectId);
          return json;
        }

        const rows = yield* legacyRow(projectId);
        if (rows[0] !== undefined) {
          const migrated = rowToFile(rows[0], toml);
          writeTomlSettings(repoPath, migrated);
          yield* clearLegacyRow(projectId);
          return migrated;
        }

        return toml;
      });

    const get: RepositorySettingsService["Type"]["get"] = (projectId) =>
      Effect.gen(function* () {
        const repoPath = yield* projectPath(projectId);
        const file =
          repoPath === null
            ? emptyFileSettings()
            : yield* resolveFile(projectId, repoPath);
        return fileToSettings(projectId, file);
      });

    const update: RepositorySettingsService["Type"]["update"] = (
      projectId,
      patch,
    ) =>
      Effect.gen(function* () {
        const repoPath = yield* projectPath(projectId);
        const current = yield* get(projectId);
        const next = applyPatch(projectId, current, patch);
        if (repoPath !== null) {
          writeTomlSettings(repoPath, settingsToFile(next));
          removeLegacyJsonSettings(repoPath);
          yield* clearLegacyRow(projectId);
        }
        return next;
      });

    return { get, update } as const;
  }),
);
