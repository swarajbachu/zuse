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

interface TicketFile {
	wsUrl?: unknown;
	ticket?: unknown;
	expiresAt?: unknown;
}

const fail = (message: string): never => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

const main = (): void => {
	const alias = process.argv[2] ?? "";
	const workspaceId = alias.startsWith("zuse-")
		? alias.slice("zuse-".length)
		: alias;
	if (workspaceId.length === 0) {
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
		fail(`zuse ssh bridge: invalid ticket file at ${ticketPath}`);
		return;
	}
	if (parsed.expiresAt <= Date.now()) {
		fail(
			`zuse ssh bridge: the SSH access ticket for ${workspaceId} has expired. Open the workspace in Zuse and use "Open via SSH" to refresh access.`,
		);
		return;
	}
	const url = new URL(parsed.wsUrl);
	url.searchParams.set("ticket", parsed.ticket);
	const ws = new WebSocket(url.toString());
	ws.binaryType = "arraybuffer";
	const pendingStdin: Array<Buffer> = [];
	let connected = false;
	ws.addEventListener("open", () => {
		connected = true;
		for (const chunk of pendingStdin) ws.send(chunk);
		pendingStdin.length = 0;
	});
	ws.addEventListener("message", (event) => {
		const data: unknown = event.data;
		process.stdout.write(
			typeof data === "string"
				? Buffer.from(data)
				: Buffer.from(data as ArrayBuffer),
		);
	});
	ws.addEventListener("close", () => process.exit(0));
	ws.addEventListener("error", () => {
		fail(
			"zuse ssh bridge: connection to the cloud workspace failed. Make sure the workspace is running in Zuse.",
		);
	});
	process.stdin.on("data", (chunk: Buffer) => {
		if (connected) ws.send(chunk);
		else pendingStdin.push(chunk);
	});
	process.stdin.on("end", () => {
		try {
			ws.close();
		} catch {
			// Already closed.
		}
		process.exit(0);
	});
};

main();
