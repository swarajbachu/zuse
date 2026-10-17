import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ListeningServer {
	readonly name: string;
	readonly port: number;
	/**
	 * True when every listener on this port binds a loopback address. Such a
	 * server is reachable through a local tunnel (which targets the remote
	 * loopback) but not through a per-port public host.
	 */
	readonly loopbackOnly: boolean;
}

interface ListenerEntry {
	readonly name: string;
	readonly port: number;
	readonly loopback: boolean;
}

const validPort = (value: string | undefined): number | null => {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

const isLoopbackHost = (host: string): boolean => {
	const bare = host.replace(/^\[|\]$/gu, "");
	return (
		bare.startsWith("127.") || bare === "::1" || bare === "::ffff:127.0.0.1"
	);
};

const collect = (
	entries: Iterable<ListenerEntry>,
): ReadonlyArray<ListeningServer> => {
	const byPort = new Map<number, { name: string; loopbackOnly: boolean }>();
	for (const entry of entries) {
		const existing = byPort.get(entry.port);
		if (existing === undefined) {
			byPort.set(entry.port, {
				name: entry.name.slice(0, 48),
				loopbackOnly: entry.loopback,
			});
		} else {
			existing.loopbackOnly = existing.loopbackOnly && entry.loopback;
		}
	}
	return [...byPort]
		.map(([port, { name, loopbackOnly }]) => ({ name, port, loopbackOnly }))
		.sort((left, right) => left.port - right.port);
};

export const parseLsofListeners = (
	stdout: string,
): ReadonlyArray<ListeningServer> => {
	const entries: ListenerEntry[] = [];
	for (const line of stdout.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/u);
		const endpoint = parts.find((part) => /:(\d+)$/u.test(part));
		const match = endpoint?.match(/^(.*):(\d+)$/u);
		const port = validPort(match?.[2]);
		if (port === null) continue;
		entries.push({
			name: parts[0] ?? "server",
			port,
			loopback: isLoopbackHost(match?.[1] ?? ""),
		});
	}
	return collect(entries);
};

export const parseSsListeners = (
	stdout: string,
	excludedPid?: number,
): ReadonlyArray<ListeningServer> => {
	const entries: ListenerEntry[] = [];
	const excludedPorts = new Set<number>();
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const endpoint = line.match(/(\[[^\]]+\]|\S+):(\d+)\s/u);
		const port = validPort(endpoint?.[2]);
		if (port === null) continue;
		if (
			excludedPid !== undefined &&
			[...line.matchAll(/pid=(\d+)/gu)].some(
				(match) => Number(match[1]) === excludedPid,
			)
		)
			excludedPorts.add(port);
		entries.push({
			name: line.match(/users:\(\("([^"]+)/u)?.[1] ?? "localhost",
			port,
			loopback: isLoopbackHost(endpoint?.[1] ?? ""),
		});
	}
	return collect(entries).filter((server) => !excludedPorts.has(server.port));
};

/** Windows netstat state labels are localized; use the TCP remote endpoint. */
export const parseWindowsTcpListeners = (stdout: string) => {
	const listeners: { host: string; port: number; pid: number }[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const parts = line.trim().split(/\s+/u);
		if (parts[0]?.toUpperCase() !== "TCP") continue;
		if (!/^(?:0\.0\.0\.0|\[::\]):0$/u.test(parts[2] ?? "")) continue;
		const match = parts[1]?.match(/^(.*):(\d+)$/u);
		const port = validPort(match?.[2]);
		const pid = Number(parts.at(-1));
		if (!match || port === null || !Number.isInteger(pid) || pid <= 0) continue;
		listeners.push({ host: match[1] ?? "", port, pid });
	}
	return listeners;
};

export const parseNetstatListeners = (
	stdout: string,
): ReadonlyArray<ListeningServer> => {
	const entries: ListenerEntry[] = parseWindowsTcpListeners(stdout).map(
		({ host, port }) => ({
			name: "localhost",
			port,
			loopback: isLoopbackHost(host),
		}),
	);
	for (const line of stdout.split("\n")) {
		if (!/\bLISTEN(?:ING)?\b/iu.test(line)) continue;
		const match = line.match(
			/(127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\*)[.:](\d+)/u,
		);
		const port = validPort(match?.[2]);
		if (port === null) continue;
		entries.push({
			name: "localhost",
			port,
			loopback: isLoopbackHost(match?.[1] ?? ""),
		});
	}
	return collect(entries);
};

const isLoopbackHexAddress = (hex: string): boolean =>
	hex === "0100007F" ||
	hex === "00000000000000000000000001000000" ||
	hex === "0000000000000000FFFF00000100007F";

export const parseProcListeners = (
	contents: string,
): ReadonlyArray<ListeningServer> => {
	const entries: ListenerEntry[] = [];
	for (const line of contents.split("\n")) {
		const columns = line.trim().split(/\s+/u);
		if (columns[3] !== "0A") continue;
		const [address, portHex] = columns[1]?.split(":") ?? [];
		const port = Number.parseInt(portHex ?? "", 16);
		if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
		entries.push({
			name: "localhost",
			port,
			loopback: isLoopbackHexAddress((address ?? "").toUpperCase()),
		});
	}
	return collect(entries);
};

export const listListeningServers = async (
	platform: NodeJS.Platform = process.platform,
	excludedPid?: number,
): Promise<ReadonlyArray<ListeningServer>> => {
	if (platform === "darwin") {
		const { stdout } = await execFileAsync("lsof", [
			"-nP",
			"-iTCP",
			"-sTCP:LISTEN",
		]);
		return parseLsofListeners(stdout);
	}
	if (platform === "linux") {
		try {
			const { stdout } = await execFileAsync("ss", ["-ltnpH"], {
				timeout: 2_000,
			});
			return parseSsListeners(stdout, excludedPid);
		} catch {
			if (excludedPid !== undefined) return [];
			const contents = await Promise.all(
				["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
					readFile(path, "utf8").catch(() => ""),
				),
			);
			return parseProcListeners(contents.join("\n"));
		}
	}
	const { stdout } = await execFileAsync("netstat", ["-an"], {
		timeout: 2_000,
	});
	return parseNetstatListeners(stdout);
};

/** Only an HTTP response qualifies a TCP listener as a browser preview.
 * HEAD avoids downloading response bodies; redirects are never followed.
 */
export const isHttpPreview = (
	port: number,
	host = "127.0.0.1",
): Promise<boolean> =>
	new Promise((resolve) => {
		const req = request({ host, port, path: "/", method: "HEAD" });
		const timer = setTimeout(() => req.destroy(), 1500);
		req.once("response", (response) => {
			clearTimeout(timer);
			response.destroy();
			resolve(true);
		});
		req.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		req.once("close", () => {
			clearTimeout(timer);
			resolve(false);
		});
		req.end();
	});
