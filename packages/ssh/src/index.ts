import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DiscoveredSshHost, SshEnvironmentTarget } from "@zuse/contracts";
import { Effect, Schema } from "effect";

export class SshError extends Schema.TaggedErrorClass<SshError>()("SshError", {
	reason: Schema.String,
}) {}

export type SshResolvedHost = {
	host: string;
	hostname: string;
	user?: string;
	port?: number;
	identityFile?: string;
};

type TailscalePeer = {
	readonly DNSName?: unknown;
	readonly HostName?: unknown;
	readonly TailscaleIPs?: unknown;
	readonly Online?: unknown;
	readonly OS?: unknown;
};

type TailscaleStatusJson = {
	readonly Self?: TailscalePeer;
	readonly Peer?: unknown;
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

export const validateSshTargetSafety = (target: SshEnvironmentTarget): void => {
	Schema.decodeUnknownSync(SshEnvironmentTarget)(target);
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
		entries.set(
			trimmed.slice(0, index).toLowerCase(),
			trimmed.slice(index + 1),
		);
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

const normalizeDnsName = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\.$/u, "").toLowerCase();
	return normalized.length > 0 ? normalized : null;
};

const normalizeDisplayName = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
};

const tailnetIpv4 = (value: unknown): string | null => {
	if (!Array.isArray(value)) return null;
	return (
		value.find(
			(candidate): candidate is string =>
				typeof candidate === "string" &&
				/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/u.test(
					candidate,
				),
		) ?? null
	);
};

export const parseTailscaleStatus = (raw: string): DiscoveredSshHost[] => {
	const value = JSON.parse(raw) as TailscaleStatusJson;
	const selfDns = normalizeDnsName(value.Self?.DNSName);
	const selfIp = tailnetIpv4(value.Self?.TailscaleIPs);
	const peers =
		typeof value.Peer === "object" && value.Peer !== null
			? Object.values(value.Peer as Record<string, unknown>)
			: [];
	const discovered = new Map<string, DiscoveredSshHost>();
	for (const candidate of peers) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const peer = candidate as TailscalePeer;
		if (peer.Online !== true) continue;
		const dnsName = normalizeDnsName(peer.DNSName);
		const ip = tailnetIpv4(peer.TailscaleIPs);
		if (
			(dnsName !== null && dnsName === selfDns) ||
			(ip !== null && ip === selfIp)
		) {
			continue;
		}
		const hostname = dnsName ?? ip;
		if (hostname === null) continue;
		const displayName = normalizeDisplayName(peer.HostName) ?? hostname;
		discovered.set(hostname, {
			alias: hostname,
			hostname,
			username: null,
			port: null,
			source: "tailscale",
			online: true,
			os: typeof peer.OS === "string" ? peer.OS : null,
			displayName,
		});
	}
	return [...discovered.values()].sort((left, right) =>
		left.displayName.localeCompare(right.displayName),
	);
};

const collectCommand = async (
	command: string,
	args: ReadonlyArray<string>,
	timeoutMs = 5_000,
): Promise<string> => {
	const child = spawn(command, [...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${command} timed out`));
		}, timeoutMs);
		child.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.once("exit", (result) => {
			clearTimeout(timer);
			resolve(result);
		});
	});
	if (code !== 0) {
		throw new Error(
			Buffer.concat(stderr).toString("utf8").trim() ||
				`${command} exited with ${code}`,
		);
	}
	return Buffer.concat(stdout).toString("utf8");
};

export const readTailscaleHosts = (): Effect.Effect<
	DiscoveredSshHost[],
	never
> =>
	Effect.tryPromise(() =>
		collectCommand("tailscale", ["status", "--json"]),
	).pipe(
		Effect.flatMap((raw) => Effect.try(() => parseTailscaleStatus(raw))),
		Effect.orElseSucceed(() => []),
	);

export const resolveSshTarget = (
	target: SshEnvironmentTarget,
): Effect.Effect<SshEnvironmentTarget, SshError> =>
	Effect.tryPromise({
		try: async () => {
			validateSshTargetSafety(target);
			const resolved = parseSshGConfig(
				target.alias,
				await collectCommand("ssh", sshGArgs(target.alias)),
			);
			return {
				alias: target.alias,
				hostname: resolved.hostname,
				username: target.username ?? resolved.user ?? null,
				port: target.port ?? resolved.port ?? null,
			};
		},
		catch: (cause) =>
			new SshError({
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	});

export const mergeDiscoveredHosts = (
	aliases: ReadonlyArray<string>,
	tailnet: ReadonlyArray<DiscoveredSshHost>,
): DiscoveredSshHost[] => {
	const hosts = new Map<string, DiscoveredSshHost>();
	for (const alias of aliases) {
		hosts.set(alias.toLowerCase(), {
			alias,
			hostname: alias,
			username: null,
			port: null,
			source: "ssh-config",
			online: null,
			os: null,
			displayName: alias,
		});
	}
	for (const target of tailnet) {
		const aliasKey = target.alias.toLowerCase();
		const hostnameKey = target.hostname.toLowerCase();
		if (!hosts.has(aliasKey) && !hosts.has(hostnameKey)) {
			hosts.set(aliasKey, target);
		}
	}
	return [...hosts.values()];
};

export const discoverSshHosts = (): Effect.Effect<DiscoveredSshHost[], never> =>
	Effect.all([
		readHostAliases().pipe(Effect.orElseSucceed(() => [])),
		readTailscaleHosts(),
	]).pipe(
		Effect.map(([aliases, tailnet]) => mergeDiscoveredHosts(aliases, tailnet)),
	);

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

export const remoteBootstrapScript = (version: string): string => {
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
		throw new Error("Invalid compatible Serve runtime version");
	}
	return String.raw`
set -eu
ROOT="$HOME/.zuse/ssh"
VERSION="${version}"
PORT="4859"
PREFIX="$ROOT/runtime/$VERSION"
ZUSE_BIN="$PREFIX/node_modules/@zusehq/serve/dist/bin.mjs"
DATA_DIR="$ROOT/data"
mkdir -p "$ROOT" "$DATA_DIR"
find_node() {
  for cmd in node "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node"; do
    if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  done
  echo "Node 22.5 or newer is required on the remote computer" >&2
  return 1
}
NODE_BIN="$(find_node)"
"$NODE_BIN" -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<5))process.exit(1)" || {
  echo "Node 22.5 or newer is required on the remote computer" >&2
  exit 1
}
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then
  echo "npm is required on the remote computer" >&2
  exit 1
fi
if [ ! -f "$ZUSE_BIN" ]; then
  "$NPM_BIN" install --prefix "$PREFIX" --no-audit --no-fund --save-exact "@zusehq/serve@$VERSION" >&2
fi
is_ready() {
  "$NODE_BIN" -e "const s=require('net').connect($PORT,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));" >/dev/null 2>&1
}
if ! is_ready; then
  if command -v launchctl >/dev/null 2>&1 || { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }; then
    "$NODE_BIN" "$ZUSE_BIN" serve start --ssh-managed --data-dir "$DATA_DIR" >&2
  else
    LOG="$ROOT/serve.log"
    nohup "$NODE_BIN" "$ZUSE_BIN" serve --foreground --ssh-managed --data-dir "$DATA_DIR" >"$LOG" 2>&1 </dev/null &
  fi
fi
for i in $(seq 1 150); do
  if is_ready; then
    printf '{"remotePort":%s,"serverKind":"zuse"}\n' "$PORT"
    exit 0
  fi
  sleep 0.2
done
echo "Remote Zuse Serve did not become ready" >&2
exit 1
`;
};

export const parseLaunchResult = (line: string): LaunchResult => {
	const value = JSON.parse(line) as Partial<LaunchResult>;
	if (typeof value.remotePort !== "number" || value.serverKind !== "zuse") {
		throw new Error("invalid launch response");
	}
	return { remotePort: value.remotePort, serverKind: value.serverKind };
};

export const tunnelArgs = (input: {
	host: string;
	username?: string | null;
	port?: number | null;
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
	...(input.port === null || input.port === undefined
		? []
		: ["-p", String(input.port)]),
	input.username ? `${input.username}@${input.host}` : input.host,
];

export const randomLocalPort = (): number => randomInt(20_000, 60_000);

const waitForTunnelReady = (
	child: ChildProcessWithoutNullStreams,
	localPort: number,
	timeoutMs = 15_000,
): Promise<void> =>
	new Promise((resolve, reject) => {
		let diagnostic = "";
		let settled = false;
		child.stderr.on("data", (chunk) => {
			diagnostic = `${diagnostic}${Buffer.from(chunk).toString("utf8")}`.slice(
				-32_768,
			);
		});
		const finish = (cause?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			child.off("error", onError);
			child.off("exit", onExit);
			if (cause === undefined) resolve();
			else reject(cause);
		};
		const onError = (cause: Error): void => finish(cause);
		const onExit = (code: number | null): void =>
			finish(
				new Error(
					diagnostic.trim() ||
						`SSH tunnel exited before it was ready (${code}).`,
				),
			);
		child.once("error", onError);
		child.once("exit", onExit);
		const probe = (): void => {
			if (settled) return;
			const socket = connect({ host: "127.0.0.1", port: localPort });
			socket.once("connect", () => {
				socket.destroy();
				finish();
			});
			socket.once("error", () => {
				socket.destroy();
				setTimeout(probe, 100);
			});
		};
		const deadline = setTimeout(
			() => finish(new Error("SSH tunnel timed out before it became ready.")),
			timeoutMs,
		);
		probe();
	});

export const openTunnel = (input: {
	target?: SshEnvironmentTarget;
	host?: string;
	remotePort: number;
	localPort?: number;
	sshPath?: string;
}): Effect.Effect<TunnelHandle, SshError> =>
	Effect.tryPromise({
		try: async () => {
			const target = input.target ?? {
				alias: input.host ?? "",
				hostname: input.host ?? "",
				username: null,
				port: null,
			};
			validateSshTargetSafety(target);
			if (target.hostname.trim().length === 0)
				throw new Error("SSH host is required");
			const localPort = input.localPort ?? randomLocalPort();
			const child = spawn(
				input.sshPath ?? "ssh",
				tunnelArgs({
					host: target.alias,
					username: target.username,
					port: target.port,
					localPort,
					remotePort: input.remotePort,
				}),
				{ stdio: "pipe" },
			);
			try {
				await waitForTunnelReady(child, localPort);
			} catch (cause) {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGTERM");
				throw cause;
			}
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
