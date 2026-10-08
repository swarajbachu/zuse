import { spawn } from "node:child_process";
import { decodeJsonRpcLine } from "./protocol.js";
import { AcpRpcClient, type AcpRpcMessage } from "./rpc-client.js";

export interface AcpLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** Some ACP bridges reject all per-session MCP servers, including stdio. */
	readonly mcpEnabled?: boolean;
}

/** Bounds a stderr line when an agent never writes a newline. */
const MAX_STDERR_LINE = 16_384;

/**
 * One process/connection per session; also used for short-lived discovery probes.
 * `onStderr` receives complete lines so URLs split across chunks stay intact.
 */
export const launchAcpProcess = (
	launch: AcpLaunch,
	cwd: string,
	receive: (message: AcpRpcMessage) => void,
	onClose: (error: Error) => void = () => {},
	onStderr: (text: string) => void = () => {},
) => {
	const child = spawn(launch.command, [...launch.args], {
		cwd,
		env: { ...process.env, ...launch.env },
		stdio: "pipe",
		shell: false,
		detached: process.platform !== "win32",
	});
	let closed = false;
	let stopped = false;
	let buffer = "";
	let stderr = "";
	const rpc = new AcpRpcClient((message) => {
		if (closed || !child.stdin.writable)
			throw new Error("ACP connection closed");
		child.stdin.write(`${JSON.stringify(message)}\n`);
	});
	const finish = (error: Error) => {
		if (closed) return;
		closed = true;
		rpc.rejectAll(error);
		onClose(error);
	};
	const close = () => {
		if (stopped) return;
		stopped = true;
		finish(new Error("ACP connection closed"));
		child.stdin.end();
		const signal = (value: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, value);
				else child.kill(value);
			} catch {
				/* Already exited. */
			}
		};
		signal("SIGTERM");
		const timer = setTimeout(() => {
			signal("SIGKILL");
		}, 2000);
		timer.unref();
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > 8 * 1024 * 1024) {
			finish(new Error("ACP frame exceeds 8 MiB"));
			close();
			return;
		}
		while (true) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!line.trim()) continue;
			const message = decodeJsonRpcLine(line);
			if (!message) {
				finish(new Error("Agent returned malformed ACP JSON"));
				close();
				return;
			}
			try {
				if (typeof message.method === "string") receive(message);
				else rpc.acceptResponse(message);
			} catch (cause) {
				finish(cause instanceof Error ? cause : new Error(String(cause)));
				close();
				return;
			}
		}
	});
	child.stderr.setEncoding("utf8");
	let pendingLine = "";
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
		const lines = (pendingLine + chunk).split(/\r\n|\n|\r/);
		pendingLine = lines.pop() ?? "";
		if (pendingLine.length > MAX_STDERR_LINE) {
			lines.push(pendingLine);
			pendingLine = "";
		}
		for (const line of lines) onStderr(line);
	});
	child.stderr.on("end", () => {
		if (pendingLine) onStderr(pendingLine);
		pendingLine = "";
	});
	child.stdin.on("error", (error) => {
		finish(error);
		close();
	});
	child.on("error", finish);
	child.on("close", (code, signal) => {
		const lastLine = stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 200);
		finish(
			new Error(
				`ACP process exited (${code ?? signal ?? "unknown"})${lastLine ? `: ${lastLine}` : ""}`,
			),
		);
	});
	return {
		rpc,
		close,
		get diagnostics() {
			return stderr;
		},
	};
};
