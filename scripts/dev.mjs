// Root dev orchestrator for the desktop app: starts the Vite renderer, the
// desktop bundle watcher, and Electron as separate visible processes. Keeping
// these as top-level children avoids nested Turbo/Bun task UIs hiding the
// Electron launcher while only showing the bundle watcher.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parsePort(name, fallback) {
  const raw = process.env[name] ?? fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[dev] ${name} must be a TCP port number, got ${raw}`);
    process.exit(1);
  }
  return port;
}

function assertPortAvailable(name, host, port) {
  return new Promise((resolveAvailable, rejectUnavailable) => {
    const server = createServer();
    server.once("error", (error) => {
      const reason =
        error && typeof error === "object" && "code" in error
          ? `${error.code}`
          : String(error);
      rejectUnavailable(
        new Error(
          `[dev] ${name} port ${host}:${port} is unavailable (${reason}).`,
        ),
      );
    });
    server.once("listening", () => {
      server.close(() => resolveAvailable());
    });
    server.listen(port, host);
  });
}

const RENDERER_PORT = parsePort("PORT", 5733);
const DESKTOP_WS_PORT = parsePort("ZUSE_DESKTOP_WS_PORT", 8788);
const RENDERER_HOST = process.env.HOST?.trim() || "localhost";
const DEV_SERVER_URL = `http://${RENDERER_HOST}:${RENDERER_PORT}`;
const DESKTOP_WS_HOST = "127.0.0.1";

// Force Electron to wait for the bundle produced by this dev run. Otherwise a
// stale dist-electron from a previous build can launch immediately, then the
// watch build writes fresh bundles and triggers a restart, briefly creating two
// Electron dock icons.
rmSync(resolve(repoRoot, "apps", "desktop", "dist-electron"), {
  recursive: true,
  force: true,
});

try {
  await Promise.all([
    assertPortAvailable("renderer", RENDERER_HOST, RENDERER_PORT),
    assertPortAvailable("desktop websocket", DESKTOP_WS_HOST, DESKTOP_WS_PORT),
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(
  `[dev] using fixed ports: renderer ${RENDERER_HOST}:${RENDERER_PORT}, desktop websocket ${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}`,
);

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
  ZUSE_DESKTOP_WS_PORT: String(DESKTOP_WS_PORT),
});

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
