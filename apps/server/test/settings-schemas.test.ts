import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("public settings schemas", () => {
  it("are generated and committed", () => {
    execFileSync("node", ["scripts/generate-settings-schemas.mjs", "--check"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  it("exposes stable schema ids", () => {
    const schemaDir = join(repoRoot, "apps", "web", "public", "schemas");
    const repository = JSON.parse(
      readFileSync(join(schemaDir, "repository-settings.schema.json"), "utf8"),
    ) as { $id?: string };
    const settings = JSON.parse(
      readFileSync(join(schemaDir, "settings.schema.json"), "utf8"),
    ) as { $id?: string };
    const keybindings = JSON.parse(
      readFileSync(join(schemaDir, "keybindings.schema.json"), "utf8"),
    ) as { $id?: string };

    expect(repository.$id).toBe(
      "https://zuse.dev/schemas/repository-settings.schema.json",
    );
    expect(settings.$id).toBe("https://zuse.dev/schemas/settings.schema.json");
    expect(keybindings.$id).toBe(
      "https://zuse.dev/schemas/keybindings.schema.json",
    );
  });
});
