/**
 * Terminal support for ACP clients (Grok, Gemini, Cursor, etc.).
 *
 * Implements the canonical ACP terminal lifecycle backed by node:child_process:
 *   terminal/create      → spawn a process, return { terminalId }
 *   terminal/output      → { output, truncated, exitStatus }
 *   terminal/wait_for_exit → await exit, return { exitStatus }
 *   terminal/kill        → SIGTERM (+SIGKILL fallback)
 *   terminal/release     → kill if running + drop the record
 *
 * This is what lets ACP agents actually run shell commands (e.g. `gh pr create`,
 * `git push`) and read their output — previously these were stubs that returned
 * fake success and never executed anything, so the agent reported the shell as
 * blocked.
 *
 * Execution is gated through the shared Bash permission policy + PermissionService
 * (via ctx.requestPermission) exactly like Claude/Codex Bash and ACP fs writes.
 * When the permission callbacks are not wired by the driver (transitional state),
 * we fall back to auto-allow so existing sessions keep working.
 *
 * Security: the working directory is forced under the session cwd via
 * ensureUnderCwd (shared with acp/fs.ts).
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AcpPermissionContext } from "../../kernel/acp-permission-context.ts";
import { getBashPolicy } from "../../kernel/policy.ts";
import { ensureUnderCwd } from "./fs.ts";

export type TerminalHandleContext = AcpPermissionContext;

interface ExitStatus {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

interface TerminalRecord {
	readonly child: ChildProcess;
	output: string;
	truncated: boolean;
	readonly byteLimit: number;
	exitStatus: ExitStatus | null;
	/** Resolves once the child closes; resolves immediately if already exited. */
	readonly exited: Promise<ExitStatus>;
}

/** Default cap on captured output (most-recent bytes are kept). */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024; // 1 MiB

/** Live terminals keyed by the id we hand back to the agent. */
const terminals = new Map<string, TerminalRecord>();
let terminalCounter = 0;
const nextTerminalId = (): string => `term_${Date.now()}_${++terminalCounter}`;

/** Append output, keeping only the most-recent `byteLimit` bytes. */
const appendOutput = (rec: TerminalRecord, chunk: string): void => {
	rec.output += chunk;
	if (Buffer.byteLength(rec.output, "utf8") > rec.byteLimit) {
		const buf = Buffer.from(rec.output, "utf8");
		rec.output = buf.subarray(buf.length - rec.byteLimit).toString("utf8");
		rec.truncated = true;
	}
};

/**
 * Normalize the `env` param into a plain record. The ACP spec models env as
 * `Array<{ name, value }>`, but agents have also been seen to pass a plain
 * object — accept both.
 */
const normalizeEnv = (raw: unknown): Record<string, string> => {
	const out: Record<string, string> = {};
	if (raw == null) return out;
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			const name = (entry as { name?: unknown })?.name;
			const value = (entry as { value?: unknown })?.value;
			if (typeof name === "string") {
				out[name] = typeof value === "string" ? value : String(value ?? "");
			}
		}
		return out;
	}
	if (typeof raw === "object") {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			out[k] = typeof v === "string" ? v : String(v ?? "");
		}
	}
	return out;
};

/** Pull the terminal id out of params under any of the shapes agents use. */
const idOf = (params: unknown): string | undefined => {
	const p = params as Record<string, unknown> | null | undefined;
	const id = p?.terminalId ?? p?.processId ?? p?.id;
	return typeof id === "string" ? id : undefined;
};

const recordOf = (params: unknown, method: string): TerminalRecord => {
	const id = idOf(params);
	if (id === undefined) throw new Error(`${method}: missing terminalId`);
	const rec = terminals.get(id);
	if (rec === undefined) throw new Error(`${method}: unknown terminalId ${id}`);
	return rec;
};

/**
 * Gate command execution through the shared Bash policy + PermissionService.
 * Throws on Deny so the JSON-RPC reply to the agent becomes an error.
 */
async function ensureBashPermission(
	ctx: TerminalHandleContext,
	command: string,
): Promise<void> {
	const requestPermission = ctx.requestPermission;
	const getRuntimeMode = ctx.getRuntimeMode;

	// Transitional: no permission service wired yet → auto-allow.
	if (!requestPermission || !getRuntimeMode) return;

	const policy = getBashPolicy(
		command,
		getRuntimeMode(),
		ctx.getPermissionMode?.(),
	);

	if (policy.kind === "auto-allow") return;

	const decision = await requestPermission(
		{ _tag: "Bash", command },
		{ forcePrompt: policy.forcePrompt },
	);

	if (decision._tag === "Deny") {
		throw new Error(`Permission denied for command: ${command}`);
	}
}

async function createTerminal(
	params: unknown,
	ctx: TerminalHandleContext,
): Promise<unknown> {
	const p = (params ?? {}) as Record<string, unknown>;

	const command = typeof p.command === "string" ? p.command : "";
	if (command.length === 0) throw new Error("terminal/create: missing command");

	const args = Array.isArray(p.args)
		? p.args.filter((a): a is string => typeof a === "string")
		: [];
	const env = normalizeEnv(p.env);
	const byteLimit =
		typeof p.outputByteLimit === "number" && p.outputByteLimit > 0
			? p.outputByteLimit
			: DEFAULT_OUTPUT_BYTE_LIMIT;
	const requestedCwd =
		typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : ctx.cwd;
	const spawnCwd = ensureUnderCwd(requestedCwd, ctx.cwd);

	// Human-readable command for the permission prompt.
	const displayCommand =
		args.length > 0 ? `${command} ${args.join(" ")}` : command;
	await ensureBashPermission(ctx, displayCommand);

	// If the agent gave us argv, run the program directly. Otherwise treat
	// `command` as a shell line so `gh pr create ... && git push` style commands
	// (pipes, &&, env expansion) work as the agent expects.
	const useShell = args.length === 0;
	const child = useShell
		? spawn(command, {
				cwd: spawnCwd,
				env: { ...process.env, ...env },
				shell: true,
				stdio: ["pipe", "pipe", "pipe"],
			})
		: spawn(command, args, {
				cwd: spawnCwd,
				env: { ...process.env, ...env },
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

	const terminalId = nextTerminalId();

	let resolveExit!: (status: ExitStatus) => void;
	const exited = new Promise<ExitStatus>((resolve) => {
		resolveExit = resolve;
	});

	const rec: TerminalRecord = {
		child,
		output: "",
		truncated: false,
		byteLimit,
		exitStatus: null,
		exited,
	};
	terminals.set(terminalId, rec);

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => appendOutput(rec, chunk));
	child.stderr?.on("data", (chunk: string) => appendOutput(rec, chunk));
	child.on("error", (err) => {
		appendOutput(
			rec,
			`\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`,
		);
		if (rec.exitStatus === null) {
			const status: ExitStatus = { exitCode: null, signal: null };
			rec.exitStatus = status;
			resolveExit(status);
		}
	});
	child.on("close", (code, signal) => {
		if (rec.exitStatus !== null) return;
		const status: ExitStatus = { exitCode: code, signal: signal ?? null };
		rec.exitStatus = status;
		resolveExit(status);
	});

	// Return terminalId (canonical ACP) plus a processId alias for any agent
	// variant still keyed on the old exec/run_command shape.
	return { terminalId, processId: terminalId };
}

function terminalOutput(params: unknown): unknown {
	const rec = recordOf(params, "terminal/output");
	return {
		output: rec.output,
		truncated: rec.truncated,
		exitStatus: rec.exitStatus,
	};
}

async function waitForExit(params: unknown): Promise<unknown> {
	const rec = recordOf(params, "terminal/wait_for_exit");
	const status = rec.exitStatus ?? (await rec.exited);
	return { exitStatus: status };
}

function writeInput(params: unknown): unknown {
	const rec = recordOf(params, "terminal/write");
	const p = params as Record<string, unknown>;
	const data = p?.data ?? p?.input ?? p?.text;
	if (typeof data === "string") rec.child.stdin?.write(data);
	return { status: "written" };
}

function killTerminal(params: unknown): unknown {
	const rec = recordOf(params, "terminal/kill");
	if (rec.exitStatus === null) {
		rec.child.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (rec.exitStatus === null) rec.child.kill("SIGKILL");
		}, 2000);
		timer.unref?.();
	}
	return {};
}

function releaseTerminal(params: unknown): unknown {
	const id = idOf(params);
	if (id !== undefined) {
		const rec = terminals.get(id);
		if (rec !== undefined && rec.exitStatus === null) {
			rec.child.kill("SIGKILL");
		}
		terminals.delete(id);
	}
	return {};
}

export async function handleTerminalRequest(
	method: string,
	params: unknown,
	ctx: TerminalHandleContext,
): Promise<unknown> {
	try {
		switch (method) {
			case "terminal/create":
			case "terminal/createSession":
			// Legacy aliases that also embed a command to run.
			case "terminal/exec":
			case "terminal/run_command":
				return await createTerminal(params, ctx);

			case "terminal/output":
				return terminalOutput(params);

			case "terminal/wait_for_exit":
				return await waitForExit(params);

			case "terminal/write":
			case "terminal/input":
				return writeInput(params);

			case "terminal/kill":
				return killTerminal(params);

			case "terminal/release":
			case "terminal/close":
				return releaseTerminal(params);

			default:
				throw new Error(`Method not implemented by Zuse ACP client: ${method}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(message);
	}
}
