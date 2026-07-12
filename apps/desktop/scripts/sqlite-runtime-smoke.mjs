import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.versions.electron === undefined) {
	const { default: electronPath } = await import("electron");
	const result = spawnSync(electronPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		stdio: "inherit",
	});
	if (result.error !== undefined) throw result.error;
	process.exit(result.status ?? 1);
}

const { DatabaseSync } = await import("node:sqlite");
const directory = mkdtempSync(join(tmpdir(), "zuse-electron-sqlite-"));
try {
	const database = new DatabaseSync(join(directory, "smoke.sqlite"));
	database.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
	database.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
	const row = database.prepare("SELECT value FROM smoke").get();
	database.close();
	if (row?.value !== "ok") throw new Error("node:sqlite smoke query failed");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
