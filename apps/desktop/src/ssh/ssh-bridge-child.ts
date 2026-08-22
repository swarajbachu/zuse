/**
 * ssh ProxyCommand bridge for cloud workspaces.
 *
 * ssh runs this script (via `ELECTRON_RUN_AS_NODE=1 <app binary> <script> %n`)
 * and speaks the SSH wire protocol over its stdio. The script pumps those
 * bytes over a WebSocket to the workspace runtime's ticket-gated `/ssh` route,
 * which spawns `sshd -i` inside the sandbox. It runs OUTSIDE the Electron app
 * (and outside the asar), so it must stay dependency-free.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitizedSshBridgeFailure } from "./ssh-bridge-errors";

interface TicketFile {
	wsUrl?: unknown;
	ticket?: unknown;
	expiresAt?: unknown;
}

const fail = (message: string): never => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

const configuredTimeout = Number.parseInt(
	process.env.ZUSE_SSH_BRIDGE_CONNECT_TIMEOUT_MS ?? "",
	10,
);
const CONNECT_TIMEOUT_MS =
	Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: 15_000;
const BUFFER_LOW_WATERMARK_BYTES = 1024 * 1024;
const BUFFER_HIGH_WATERMARK_BYTES = 8 * 1024 * 1024;
const BUFFER_HARD_LIMIT_BYTES = 32 * 1024 * 1024;

const errorDetail = (event: Event): string => {
	const candidate = event as Event & {
		readonly message?: unknown;
		readonly error?: { readonly message?: unknown };
	};
	if (typeof candidate.message === "string") return candidate.message;
	if (typeof candidate.error?.message === "string")
		return candidate.error.message;
	return "";
};

const diagnoseHandshakeFailure = async (url: URL): Promise<string> => {
	try {
		const diagnosticUrl = new URL(url);
		diagnosticUrl.protocol =
			diagnosticUrl.protocol === "wss:" ? "https:" : "http:";
		const response = await fetch(diagnosticUrl, {
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
		});
		const reader = response.body?.getReader();
		let detail = `${response.status}`;
		if (reader !== undefined) {
			const { value } = await reader.read();
			await reader.cancel().catch(() => undefined);
			if (value !== undefined) {
				detail = `${detail} ${Buffer.from(value)
					.subarray(0, 4_096)
					.toString("utf8")}`;
			}
		}
		return detail;
	} catch (cause) {
		return cause instanceof Error ? cause.message : "network failure";
	}
};

const main = (): void => {
	const alias = process.argv[2] ?? "";
	const workspaceId = alias.startsWith("zuse-")
		? alias.slice("zuse-".length)
		: alias;
	if (!/^[A-Za-z0-9_-]+$/u.test(workspaceId)) {
		fail("zuse ssh bridge: missing workspace host alias");
		return;
	}
	const ticketPath = join(
		homedir(),
		".zuse",
		"ssh",
		"tickets",
		`${workspaceId}.json`,
	);
	let parsed: TicketFile;
	try {
		parsed = JSON.parse(readFileSync(ticketPath, "utf8")) as TicketFile;
	} catch {
		fail(
			`zuse ssh bridge: no SSH access ticket for ${workspaceId}. Open the workspace in Zuse and use "Open via SSH" to refresh access.`,
		);
		return;
	}
	if (
		typeof parsed.wsUrl !== "string" ||
		typeof parsed.ticket !== "string" ||
		typeof parsed.expiresAt !== "number"
	) {
		fail(
			"zuse ssh bridge: the managed SSH access ticket is invalid. Refresh workspace access in Zuse.",
		);
		return;
	}
	if (parsed.expiresAt <= Date.now()) {
		fail(
			`zuse ssh bridge: the SSH access ticket for ${workspaceId} has expired. Open the workspace in Zuse and use "Open via SSH" to refresh access.`,
		);
		return;
	}
	let url: URL;
	try {
		url = new URL(parsed.wsUrl);
		if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error();
	} catch {
		fail(
			"zuse ssh bridge: the managed SSH access ticket is invalid. Refresh workspace access in Zuse.",
		);
		return;
	}
	url.searchParams.set("ticket", parsed.ticket);
	const ws = new WebSocket(url.toString());
	ws.binaryType = "arraybuffer";
	const pendingStdin: Array<Buffer> = [];
	let pendingStdinBytes = 0;
	const pendingStdout: Array<Buffer> = [];
	let pendingStdoutBytes = 0;
	let stdoutWriting = false;
	let connected = false;
	let ending = false;
	let settled = false;
	let backpressureTimer: NodeJS.Timeout | undefined;
	const connectionTimer = setTimeout(() => {
		settled = true;
		try {
			ws.close();
		} catch {
			// The socket never opened.
		}
		fail(sanitizedSshBridgeFailure({ timedOut: true }));
	}, CONNECT_TIMEOUT_MS);

	const stopBackpressureTimer = (): void => {
		if (backpressureTimer !== undefined) clearInterval(backpressureTimer);
		backpressureTimer = undefined;
	};
	const failConnection = (message: string): never => {
		settled = true;
		clearTimeout(connectionTimer);
		stopBackpressureTimer();
		process.stdin.pause();
		return fail(message);
	};
	const diagnoseConnection = (detail: string): void => {
		settled = true;
		clearTimeout(connectionTimer);
		stopBackpressureTimer();
		process.stdin.pause();
		void diagnoseHandshakeFailure(url).then((diagnostic) =>
			fail(
				sanitizedSshBridgeFailure({
					detail: `${detail} ${diagnostic}`,
				}),
			),
		);
	};
	const monitorWebSocketBackpressure = (): void => {
		if (ws.bufferedAmount > BUFFER_HARD_LIMIT_BYTES) {
			failConnection(
				"zuse ssh bridge: the cloud connection stopped accepting data.",
			);
		}
		if (ws.bufferedAmount <= BUFFER_HIGH_WATERMARK_BYTES) return;
		process.stdin.pause();
		if (backpressureTimer !== undefined) return;
		backpressureTimer = setInterval(() => {
			if (ws.bufferedAmount > BUFFER_HARD_LIMIT_BYTES) {
				failConnection(
					"zuse ssh bridge: the cloud connection stopped accepting data.",
				);
			}
			if (ws.bufferedAmount <= BUFFER_LOW_WATERMARK_BYTES) {
				stopBackpressureTimer();
				process.stdin.resume();
			}
		}, 10);
	};
	const send = (chunk: Buffer): void => {
		try {
			ws.send(chunk);
			monitorWebSocketBackpressure();
		} catch {
			failConnection(
				sanitizedSshBridgeFailure({ detail: "network send failed" }),
			);
		}
	};
	const flushStdout = (): void => {
		if (stdoutWriting) return;
		const chunk = pendingStdout.shift();
		if (chunk === undefined) return;
		stdoutWriting = true;
		pendingStdoutBytes -= chunk.byteLength;
		process.stdout.write(chunk, () => {
			stdoutWriting = false;
			flushStdout();
		});
	};
	ws.addEventListener("open", () => {
		clearTimeout(connectionTimer);
		connected = true;
		for (const chunk of pendingStdin) send(chunk);
		pendingStdin.length = 0;
		pendingStdinBytes = 0;
	});
	ws.addEventListener("message", (event) => {
		const data: unknown = event.data;
		const chunk =
			typeof data === "string"
				? Buffer.from(data)
				: Buffer.from(data as ArrayBuffer);
		pendingStdoutBytes += chunk.byteLength;
		if (pendingStdoutBytes > BUFFER_HARD_LIMIT_BYTES) {
			failConnection(
				"zuse ssh bridge: the local SSH client stopped accepting data.",
			);
		}
		pendingStdout.push(chunk);
		flushStdout();
	});
	ws.addEventListener("close", (event) => {
		clearTimeout(connectionTimer);
		stopBackpressureTimer();
		if (settled) return;
		settled = true;
		if (ending && event.code === 1000) process.exit(0);
		fail(sanitizedSshBridgeFailure({ closeCode: event.code }));
	});
	ws.addEventListener("error", (event) => {
		if (settled) return;
		diagnoseConnection(errorDetail(event));
	});
	process.stdin.on("data", (chunk: Buffer) => {
		if (connected) {
			send(chunk);
			return;
		}
		pendingStdinBytes += chunk.byteLength;
		if (pendingStdinBytes > BUFFER_HIGH_WATERMARK_BYTES) {
			failConnection(
				"zuse ssh bridge: too much data was buffered before connecting.",
			);
		}
		pendingStdin.push(chunk);
	});
	process.stdin.on("end", () => {
		ending = true;
		try {
			ws.close(1000);
		} catch {
			process.exit(connected ? 0 : 1);
		}
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			ending = true;
			try {
				ws.close(1000);
			} finally {
				setTimeout(() => process.exit(0), 1_000).unref();
			}
		});
	}
};

main();
