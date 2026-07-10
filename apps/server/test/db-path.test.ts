import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as Path from "node:path";

import {
  ensureSqliteRenameCompatibility as ensureSqliteRenameCompatibilityEffect,
  sqliteDbPath,
} from "../src/persistence/db-path.ts";

const ensureSqliteRenameCompatibility = (userData: string): Promise<void> =>
  Effect.runPromise(ensureSqliteRenameCompatibilityEffect(userData));

const createProjectsDb = (path: string, projectCount: number): void => {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        default_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      "INSERT INTO projects (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < projectCount; i += 1) {
      insert.run(
        `p${i}`,
        `/tmp/project-${i}`,
        `Project ${i}`,
        "2026-06-30T00:00:00.000Z",
        "2026-06-30T00:00:00.000Z",
      );
    }
    if (projectCount > 0) {
      db.exec("CREATE TABLE migration_padding (content TEXT NOT NULL)");
      db.prepare("INSERT INTO migration_padding (content) VALUES (?)").run(
        "x".repeat(80 * 1024),
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
};

describe("ensureSqliteRenameCompatibility", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), "zuse-db-path-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("copies memoize.sqlite to zuse.sqlite once and records the migration", async () => {
    const legacyPath = Path.join(dir, "memoize.sqlite");
    await fs.writeFile(legacyPath, "legacy-db");

    await ensureSqliteRenameCompatibility(dir);

    expect(await fs.readFile(sqliteDbPath(dir), "utf8")).toBe("legacy-db");

    const state = JSON.parse(
      await fs.readFile(Path.join(dir, "zuse-migration-state.json"), "utf8"),
    ) as {
      kind?: string;
      from?: string;
      to?: string;
      migratedAt?: string;
    };
    expect(state.kind).toBe("memoize-to-zuse-sqlite-copy");
    expect(state.from).toBe(legacyPath);
    expect(state.to).toBe(sqliteDbPath(dir));
    expect(typeof state.migratedAt).toBe("string");

    await fs.writeFile(sqliteDbPath(dir), "current-db");
    await ensureSqliteRenameCompatibility(dir);

    expect(await fs.readFile(sqliteDbPath(dir), "utf8")).toBe("current-db");
  });

  it("replaces an empty Zuse db from a non-empty legacy app support db", async () => {
    const appSupport = await fs.mkdtemp(
      Path.join(os.tmpdir(), "zuse-app-support-"),
    );
    const zuseDir = Path.join(appSupport, "Zuse Alpha");
    const legacyDir = Path.join(appSupport, "memoize Alpha");
    await fs.mkdir(zuseDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });

    try {
      const current = sqliteDbPath(zuseDir);
      const legacy = Path.join(legacyDir, "memoize.sqlite");
      createProjectsDb(current, 0);
      createProjectsDb(legacy, 1);

      await ensureSqliteRenameCompatibility(zuseDir);

      const migrated = new Database(current, { readonly: true });
      try {
        const row = migrated
          .query("SELECT count(*) AS count FROM projects")
          .get() as { count: number };
        expect(row.count).toBe(1);
      } finally {
        migrated.close();
      }

      const state = JSON.parse(
        await fs.readFile(
          Path.join(zuseDir, "zuse-migration-state.json"),
          "utf8",
        ),
      ) as { kind?: string; from?: string; to?: string };
      expect(state.kind).toBe("memoize-app-support-to-zuse-sqlite-copy");
      expect(state.from).toBe(legacy);
      expect(state.to).toBe(current);

      const backups = (await fs.readdir(zuseDir)).filter((name) =>
        name.startsWith("zuse.sqlite.empty-before-zuse-migration-"),
      );
      expect(backups).toHaveLength(1);
    } finally {
      await fs.rm(appSupport, { recursive: true, force: true });
    }
  });

  it("does nothing when there is no legacy database", async () => {
    await ensureSqliteRenameCompatibility(dir);

    expect(fsSync.existsSync(sqliteDbPath(dir))).toBe(false);
    expect(fsSync.existsSync(Path.join(dir, "zuse-migration-state.json"))).toBe(
      false,
    );
  });
});
