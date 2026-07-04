// Root dev orchestrator for the desktop app: starts the Vite renderer, the
// desktop bundle watcher, and Electron as separate visible processes. Keeping
// these as top-level children avoids nested Turbo/Bun task UIs hiding the
// Electron launcher while only showing the bundle watcher.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const RENDERER_PORT = Number(process.env.PORT ?? 5733);
const RENDERER_HOST = process.env.HOST?.trim() || "localhost";
const DEV_SERVER_URL = `http://${RENDERER_HOST}:${RENDERER_PORT}`;

// Force Electron to wait for the bundle produced by this dev run. Otherwise a
// stale dist-electron from a previous build can launch immediately, then the
// watch build writes fresh bundles and triggers a restart, briefly creating two
// Electron dock icons.
rmSync(resolve(repoRoot, "apps", "desktop", "dist-electron"), {
  recursive: true,
  force: true,
});

const children = [];
let shuttingDown = false;

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv, FORCE_COLOR: "1" },
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[${name}] exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
    );
    void shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

run("renderer", "bun", ["run", "--filter", "renderer", "dev"], {
  PORT: String(RENDERER_PORT),
  HOST: RENDERER_HOST,
});
run("desktop:bundle", "bun", ["run", "--filter", "desktop", "dev:bundle"]);
run("desktop:electron", "bun", ["run", "--filter", "desktop", "dev:electron"], {
  VITE_DEV_SERVER_URL: DEV_SERVER_URL,
});

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
