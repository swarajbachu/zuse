// Keeps a node:sqlite handle open across the fork and writes one row per
// second — the stand-in for zuse serve's event store. verify-fork.sh checks
// that the counter keeps advancing post-fork and that descendant histories
// diverge (each process stamps rows with its boot identity).

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? "/opt/spike/spike.db";
const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const db = new DatabaseSync(dbPath);
db.exec(
	"CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, boot_id TEXT, pid INTEGER, wall_clock TEXT, monotonic_ms REAL)",
);
const insert = db.prepare(
	"INSERT INTO ticks (boot_id, pid, wall_clock, monotonic_ms) VALUES (?, ?, ?, ?)",
);

setInterval(() => {
	insert.run(bootId, process.pid, new Date().toISOString(), performance.now());
}, 1000);

console.log(`sqlite-writer up: db=${dbPath} pid=${process.pid} boot=${bootId}`);
