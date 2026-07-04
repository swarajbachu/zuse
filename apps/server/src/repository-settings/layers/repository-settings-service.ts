import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import * as fsSync from "node:fs";
import * as Path from "node:path";

import {
  type FolderId,
  type ProviderId,
  RepositorySettings,
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

const isProviderId = (v: unknown): v is ProviderId =>
  v === "claude" || v === "codex";

const isRuntimeMode = (v: unknown): v is RuntimeMode =>
  v === "approval-required" ||
  v === "auto-accept-edits" ||
  v === "auto-accept-edits-and-bash" ||
  v === "full-access";

interface RepoFileSettings {
  readonly setupScript: string | null;
  readonly runScript: string | null;
  readonly archiveScript: string | null;
  readonly autoRunAfterSetup: boolean;
  readonly environmentVariables: Record<string, string>;
}

const emptyRepoFileSettings = (): RepoFileSettings => ({
  setupScript: null,
  runScript: null,
  archiveScript: null,
  autoRunAfterSetup: false,
  environmentVariables: {},
});

const cleanScript = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? value! : null;
};

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
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseRepoFileSettings = (repoPath: string): RepoFileSettings => {
  const filePath = Path.join(repoPath, ".zuse", "settings.toml");
  if (!fsSync.existsSync(filePath)) return emptyRepoFileSettings();
  const settings = emptyRepoFileSettings();
  let section = "";
  for (const line of fsSync.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (section === "scripts") {
      if (key === "setup") {
        (settings as { setupScript: string | null }).setupScript =
          parseTomlString(value);
      } else if (key === "run") {
        (settings as { runScript: string | null }).runScript =
          parseTomlString(value);
      } else if (key === "archive") {
        (settings as { archiveScript: string | null }).archiveScript =
          parseTomlString(value);
      } else if (key === "auto_run_after_setup") {
        (settings as { autoRunAfterSetup: boolean }).autoRunAfterSetup =
          value.trim() === "true";
      }
    } else if (section === "environment_variables") {
      settings.environmentVariables[key] = parseTomlString(value);
    }
  }
  return settings;
};

const rowToSettings = (
  projectId: FolderId,
  row: Row | null,
  repoFile: RepoFileSettings,
): RepositorySettings =>
  RepositorySettings.make({
    projectId,
    defaultProviderId: isProviderId(row?.default_provider_id)
      ? row!.default_provider_id
      : null,
    defaultModel: row?.default_model ?? null,
    defaultRuntimeMode: isRuntimeMode(row?.default_runtime_mode)
      ? row!.default_runtime_mode
      : null,
    autoCreateWorktree: (row?.auto_create_worktree ?? 0) === 1,
    worktreeBaseDir: row?.worktree_base_dir ?? null,
    archiveCleanupScript:
      cleanScript(row?.archive_cleanup_script) ?? repoFile.archiveScript,
    archiveRemoveWorktree: (row?.archive_remove_worktree ?? 0) === 1,
    setupScript: cleanScript(row?.setup_script) ?? repoFile.setupScript,
    runScript: cleanScript(row?.run_script) ?? repoFile.runScript,
    autoRunAfterSetup:
      row?.auto_run_after_setup === 1 || repoFile.autoRunAfterSetup,
    environmentVariables: {
      ...repoFile.environmentVariables,
      ...parseEnvJson(row?.environment_variables_json ?? null),
    },
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

    const get: RepositorySettingsService["Type"]["get"] = (projectId) =>
      Effect.gen(function* () {
        const path = yield* projectPath(projectId);
        const repoFile =
          path === null ? emptyRepoFileSettings() : parseRepoFileSettings(path);
        const rows = yield* sql<Row>`
          SELECT project_id, default_provider_id, default_model,
                 default_runtime_mode, auto_create_worktree, worktree_base_dir,
                 archive_cleanup_script, archive_remove_worktree,
                 setup_script, run_script, auto_run_after_setup,
                 environment_variables_json
          FROM repository_settings
          WHERE project_id = ${projectId}
          LIMIT 1
        `.pipe(Effect.orDie);
        return rowToSettings(projectId, rows[0] ?? null, repoFile);
      });

    const update: RepositorySettingsService["Type"]["update"] = (
      projectId,
      patch,
    ) =>
      Effect.gen(function* () {
        const current = yield* get(projectId);
        const next = RepositorySettings.make({
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
          autoCreateWorktree:
            patch.autoCreateWorktree ?? current.autoCreateWorktree,
          worktreeBaseDir:
            "worktreeBaseDir" in patch
              ? (patch.worktreeBaseDir ?? null)
              : current.worktreeBaseDir,
          archiveCleanupScript:
            "archiveCleanupScript" in patch
              ? patch.archiveCleanupScript?.trim()
                ? patch.archiveCleanupScript
                : null
              : current.archiveCleanupScript,
          archiveRemoveWorktree:
            patch.archiveRemoveWorktree ?? current.archiveRemoveWorktree,
          setupScript:
            "setupScript" in patch ? cleanScript(patch.setupScript) : current.setupScript,
          runScript:
            "runScript" in patch ? cleanScript(patch.runScript) : current.runScript,
          autoRunAfterSetup:
            patch.autoRunAfterSetup ?? current.autoRunAfterSetup,
          environmentVariables:
            patch.environmentVariables ?? current.environmentVariables,
        });

        yield* sql`
          INSERT INTO repository_settings
            (project_id, default_provider_id, default_model,
             default_runtime_mode, auto_create_worktree, worktree_base_dir,
             archive_cleanup_script, archive_remove_worktree,
             setup_script, run_script, auto_run_after_setup,
             environment_variables_json)
          VALUES
            (${projectId}, ${next.defaultProviderId}, ${next.defaultModel},
             ${next.defaultRuntimeMode}, ${next.autoCreateWorktree ? 1 : 0},
             ${next.worktreeBaseDir}, ${next.archiveCleanupScript},
             ${next.archiveRemoveWorktree ? 1 : 0},
             ${next.setupScript}, ${next.runScript},
             ${next.autoRunAfterSetup ? 1 : 0},
             ${JSON.stringify(next.environmentVariables)})
          ON CONFLICT(project_id) DO UPDATE SET
            default_provider_id = excluded.default_provider_id,
            default_model = excluded.default_model,
            default_runtime_mode = excluded.default_runtime_mode,
            auto_create_worktree = excluded.auto_create_worktree,
            worktree_base_dir = excluded.worktree_base_dir,
            archive_cleanup_script = excluded.archive_cleanup_script,
            archive_remove_worktree = excluded.archive_remove_worktree,
            setup_script = excluded.setup_script,
            run_script = excluded.run_script,
            auto_run_after_setup = excluded.auto_run_after_setup,
            environment_variables_json = excluded.environment_variables_json
        `.pipe(Effect.orDie);

        return next;
      });

    return { get, update } as const;
  }),
);
