import { Effect, Schema } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  reason: Schema.String,
}) {}

export type SshResolvedHost = {
  host: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

export type LaunchResult = {
  remotePort: number;
  serverKind: "zuse";
};

export type TunnelHandle = {
  localPort: number;
  remotePort: number;
  process: ChildProcessWithoutNullStreams;
  wsBaseUrl: string;
  close: () => Promise<void>;
};

export const parseSshGConfig = (
  host: string,
  output: string,
): SshResolvedHost => {
  const entries = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(" ");
    if (index <= 0) continue;
    entries.set(trimmed.slice(0, index).toLowerCase(), trimmed.slice(index + 1));
  }
  const port = Number(entries.get("port"));
  return {
    host,
    hostname: entries.get("hostname") ?? host,
    user: entries.get("user"),
    port: Number.isFinite(port) ? port : undefined,
    identityFile: entries.get("identityfile"),
  };
};

export const parseHostAliases = (config: string): string[] => {
  const aliases = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^host\s+/i.test(trimmed)) continue;
    for (const token of trimmed.slice(4).trim().split(/\s+/)) {
      if (token.includes("*") || token.includes("?") || token.startsWith("!")) {
        continue;
      }
      aliases.add(token);
    }
  }
  return [...aliases].sort((a, b) => a.localeCompare(b));
};

export const readHostAliases = (path = join(homedir(), ".ssh", "config")) =>
  Effect.tryPromise({
    try: async () => parseHostAliases(await readFile(path, "utf8")),
    catch: (cause) =>
      new SshError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const sshGArgs = (host: string): string[] => ["-G", host];

export const remoteLaunchScript = (): string => String.raw`
set -eu
ROOT="$HOME/.zuse"
mkdir -p "$ROOT"
pick_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})"
}
find_node() {
  for cmd in node "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node"; do
    if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  done
  return 1
}
find_zuse() {
  for cmd in zuse "$HOME/.zuse/bin/zuse"; do
    if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  done
  echo "zuse executable not found on remote host" >&2
  return 1
}
NODE_BIN="$(find_node)"
ZUSE_BIN="$(find_zuse)"
PORT="$(pick_port)"
LOG="$ROOT/zuse-serve-$PORT.log"
ZUSE_USER_DATA_DIR="$ROOT/data" "$ZUSE_BIN" serve \
  --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
SERVER_PID="$!"
for i in $(seq 1 50); do
  if "$NODE_BIN" -e "const s=require('net').connect($PORT,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));" >/dev/null 2>&1; then
    printf '{"remotePort":%s,"serverKind":"zuse","pid":%s}\n' "$PORT" "$SERVER_PID"
    exit 0
  fi
  sleep 0.1
done
cat "$LOG" >&2 || true
exit 1
`;

export const parseLaunchResult = (line: string): LaunchResult => {
  const value = JSON.parse(line) as Partial<LaunchResult>;
  if (
    typeof value.remotePort !== "number" ||
    value.serverKind !== "zuse"
  ) {
    throw new Error("invalid launch response");
  }
  return { remotePort: value.remotePort, serverKind: value.serverKind };
};

export const tunnelArgs = (input: {
  host: string;
  localPort: number;
  remotePort: number;
}): string[] => [
  "-N",
  "-L",
  `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  input.host,
];

export const randomLocalPort = (): number => randomInt(20_000, 60_000);

export const openTunnel = (input: {
  host: string;
  remotePort: number;
  localPort?: number;
  sshPath?: string;
}): Effect.Effect<TunnelHandle, SshError> =>
  Effect.tryPromise({
    try: async () => {
      const localPort = input.localPort ?? randomLocalPort();
      const child = spawn(
        input.sshPath ?? "ssh",
        tunnelArgs({ host: input.host, localPort, remotePort: input.remotePort }),
        { stdio: "pipe" },
      );
      const close = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await once(child, "exit").catch(() => {});
        clearTimeout(timeout);
      };
      return {
        localPort,
        remotePort: input.remotePort,
        process: child,
        wsBaseUrl: `ws://127.0.0.1:${localPort}/rpc`,
        close,
      };
    },
    catch: (cause) =>
      new SshError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
