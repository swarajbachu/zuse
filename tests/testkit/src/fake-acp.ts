import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	symlinkSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, URL as NodeUrl } from "node:url";

export type FakeAcpScenario =
	| "complete"
	| "hold"
	| "permission"
	| "crash"
	| "malformed"
	| "stall";

export type FakeAcpInstallation = {
	readonly binDirectory: string;
	readonly executable: string;
	readonly environment: Readonly<Record<string, string>>;
};

export type FakeAcpEvent = {
	readonly event: string;
	readonly [key: string]: unknown;
};

export type FakeAcpController = {
	readonly port: number;
	readonly waitFor: (
		event: string,
		predicate?: (value: FakeAcpEvent) => boolean,
		timeoutMs?: number,
	) => Promise<FakeAcpEvent>;
	readonly send: (command: Readonly<Record<string, unknown>>) => void;
	readonly events: (event?: string) => ReadonlyArray<FakeAcpEvent>;
	readonly close: () => Promise<void>;
};

const requiredSystemTools = [
	"bun",
	"env",
	"git",
	"node",
	"sh",
	"which",
] as const;

const resolveExecutable = (name: string): string => {
	const executable = execFileSync("/bin/sh", ["-lc", `command -v ${name}`], {
		encoding: "utf8",
	}).trim();
	if (executable.length === 0 || !executable.startsWith("/")) {
		throw new Error(
			`Could not resolve required system-test executable: ${name}`,
		);
	}
	return executable;
};

/**
 * Build the complete PATH used by process-shaped tests. Only the deterministic
 * provider and the small set of tools needed by the application are present,
 * so provider discovery can never reach executables installed on the host.
 */
export const installHermeticProcessPath = (root: string): string => {
	const binDirectory = join(root, "bin");
	mkdirSync(binDirectory, { recursive: true });
	for (const name of requiredSystemTools) {
		const destination = join(binDirectory, name);
		if (!existsSync(destination))
			symlinkSync(resolveExecutable(name), destination);
	}
	return binDirectory;
};

const fixture = fileURLToPath(
	new NodeUrl("../fixtures/fake-acp-provider.mjs", import.meta.url),
);

export const installFakeAcpProvider = (options: {
	readonly root: string;
	readonly scenario?: FakeAcpScenario;
	readonly controlPort?: number;
}): FakeAcpInstallation => {
	const binDirectory = installHermeticProcessPath(options.root);
	const executable = join(binDirectory, "gemini");
	mkdirSync(dirname(executable), { recursive: true });
	copyFileSync(fixture, executable);
	chmodSync(executable, 0o755);
	return {
		binDirectory,
		executable,
		environment: {
			ZUSE_FAKE_ACP_SCENARIO: options.scenario ?? "complete",
			ZUSE_FAKE_ACP_STATE_DIR: join(options.root, "fake-acp-state"),
			...(options.controlPort === undefined
				? {}
				: { ZUSE_FAKE_ACP_CONTROL_PORT: String(options.controlPort) }),
		},
	};
};

export const startFakeAcpController = async (): Promise<FakeAcpController> => {
	let closed = false;
	const sockets = new Set<Socket>();
	const history: Array<FakeAcpEvent> = [];
	const waiters = new Set<{
		readonly event: string;
		readonly predicate: (value: FakeAcpEvent) => boolean;
		readonly resolve: (value: FakeAcpEvent) => void;
	}>();
	const accept = (value: FakeAcpEvent): void => {
		history.push(value);
		for (const waiter of waiters) {
			if (waiter.event !== value.event || !waiter.predicate(value)) continue;
			waiters.delete(waiter);
			waiter.resolve(value);
		}
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += String(chunk);
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line.length === 0) continue;
				accept(JSON.parse(line) as FakeAcpEvent);
			}
		});
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("Fake ACP controller did not bind a TCP port.");
	}
	return {
		port: address.port,
		events: (event) =>
			history.filter((value) => event === undefined || value.event === event),
		waitFor: (event, predicate = () => true, timeoutMs = 10_000) => {
			const existing = history.find(
				(value) => value.event === event && predicate(value),
			);
			if (existing !== undefined) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const waiter: {
					readonly event: string;
					readonly predicate: (value: FakeAcpEvent) => boolean;
					resolve: (value: FakeAcpEvent) => void;
				} = { event, predicate, resolve: (value) => resolve(value) };
				waiters.add(waiter);
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(
						new Error(
							`Timed out waiting for fake ACP event ${event}. History: ${JSON.stringify(history)}`,
						),
					);
				}, timeoutMs);
				waiter.resolve = (value: FakeAcpEvent) => {
					clearTimeout(timer);
					resolve(value);
				};
			});
		},
		send: (command) => {
			const line = `${JSON.stringify(command)}\n`;
			for (const socket of sockets) socket.write(line);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
};
