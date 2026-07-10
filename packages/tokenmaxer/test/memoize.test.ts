import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMemoizeUsage } from "../src/index.ts";

describe("zuse source", () => {
  it("reads usage rows from zuse.sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenmaxer-"));
    const dbPath = join(dir, "zuse.sqlite");
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO projects (id, path, name) VALUES (?, ?, ?)").run("p1", "/repo", "repo");
      db.prepare("INSERT INTO sessions (id, project_id, provider_id, model) VALUES (?, ?, ?, ?)").run(
        "s1",
        "p1",
        "grok",
        "grok-build",
      );
      db.prepare(
        "INSERT INTO messages (id, session_id, role, kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "m1",
        "s1",
        "meta",
        "usage",
        JSON.stringify({
          _tag: "usage",
          inputTokens: 42,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          model: "grok-build",
        }),
        "2026-06-21T00:00:00.000Z",
      );
      db.close();

      const result = readMemoizeUsage(dbPath);
      expect(result.status.detected).toBe(true);
      expect(result.status.id).toBe("zuse");
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.sourceId).toBe("zuse");
      expect(result.records[0]?.providerId).toBe("grok");
      expect(result.records[0]?.inputTokens).toBe(42);
      expect(result.records[0]?.projectPath).toBe("/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
