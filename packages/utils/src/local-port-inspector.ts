import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LocalServerSummary {
	readonly name: string;
	readonly port: number;
}

const validPort = (value: string | undefined): number | null => {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

export const parseLsofListeners = (
	stdout: string,
): ReadonlyArray<LocalServerSummary> => {
	const byPort = new Map<number, string>();
	for (const line of stdout.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/u);
		const endpoint = parts.find((part) => /:(\d+)$/u.test(part));
		const port = validPort(endpoint?.match(/:(\d+)$/u)?.[1]);
		if (port !== null && !byPort.has(port)) {
			byPort.set(port, (parts[0] ?? "server").slice(0, 48));
		}
	}
	return [...byPort].map(([port, name]) => ({ name, port }));
};

export const parseSsListeners = (
	stdout: string,
): ReadonlyArray<LocalServerSummary> => {
	const byPort = new Map<number, string>();
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const endpoint = line.match(/(?:\[[^\]]+\]|\S+):(\d+)\s/u);
		const port = validPort(endpoint?.[1]);
		if (port === null) continue;
		const name = line.match(/users:\(\("([^"]+)/u)?.[1] ?? "localhost";
		if (!byPort.has(port)) byPort.set(port, name.slice(0, 48));
	}
	return [...byPort].map(([port, name]) => ({ name, port }));
};

export const parseNetstatListeners = (
	stdout: string,
): ReadonlyArray<LocalServerSummary> => {
	const byPort = new Map<number, string>();
	for (const line of stdout.split("\n")) {
		if (!/\bLISTEN(?:ING)?\b/iu.test(line)) continue;
		const port = validPort(
			line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\*)[.:](\d+)/u)?.[1],
		);
		if (port !== null && !byPort.has(port)) byPort.set(port, "localhost");
	}
	return [...byPort].map(([port, name]) => ({ name, port }));
};

export const parseProcListeners = (
	contents: string,
): ReadonlyArray<LocalServerSummary> => {
	const ports = new Set<number>();
	for (const line of contents.split("\n").slice(1)) {
		const columns = line.trim().split(/\s+/u);
		if (columns[3] !== "0A") continue;
		const port = Number.parseInt(columns[1]?.split(":")[1] ?? "", 16);
		if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
	}
	return [...ports].map((port) => ({ name: "localhost", port }));
};

const sorted = (servers: ReadonlyArray<LocalServerSummary>) =>
	[...servers].sort((left, right) => left.port - right.port);

export const listLocalServers = async (
	platform: NodeJS.Platform = process.platform,
): Promise<ReadonlyArray<LocalServerSummary>> => {
	if (platform === "darwin") {
		const { stdout } = await execFileAsync("lsof", [
			"-nP",
			"-iTCP",
			"-sTCP:LISTEN",
		]);
		return sorted(parseLsofListeners(stdout));
	}
	if (platform === "linux") {
		try {
			const { stdout } = await execFileAsync("ss", ["-ltnpH"], {
				timeout: 2_000,
			});
			return sorted(parseSsListeners(stdout));
		} catch {
			const contents = await Promise.all(
				["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
					readFile(path, "utf8").catch(() => ""),
				),
			);
			return sorted(parseProcListeners(contents.join("\n")));
		}
	}
	const { stdout } = await execFileAsync("netstat", ["-an"], {
		timeout: 2_000,
	});
	return sorted(parseNetstatListeners(stdout));
};
