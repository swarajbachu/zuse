#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const usage = `Usage:
  bun run kill-port -- <port>
  bun run kill-port -- <port> --force

Examples:
  bun run kill-port -- 5733
  bun run kill-port -- 5733 --force`;

const args = process.argv.slice(2);
const portArg = args.find((arg) => arg !== "--force");
const force = args.includes("--force");
const port = Number(portArg);

if (!Number.isInteger(port) || port <= 0) {
  console.error(usage);
  process.exit(1);
}

let output = "";
try {
  output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  }).trim();
} catch {
  console.log(`No listener found on port ${port}.`);
  process.exit(0);
}

console.log(output);

const pids = [
  ...new Set(
    output
      .split("\n")
      .slice(1)
      .map((line) => Number(line.trim().split(/\s+/)[1]))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  ),
];

if (pids.length === 0) {
  console.log(`No killable listener found on port ${port}.`);
  process.exit(0);
}

if (!force) {
  console.log(
    `\nRun with --force to kill ${pids.length === 1 ? "PID" : "PIDs"} ${pids.join(", ")}.`,
  );
  process.exit(0);
}

for (const pid of pids) {
  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to PID ${pid}.`);
}
