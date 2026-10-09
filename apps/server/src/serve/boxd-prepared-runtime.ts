import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
	BOXD_RUNTIME_PROTOCOL,
	BOXD_RUNTIME_SOCKET,
	type BoxdRuntimeActivation,
	type BoxdRuntimeFile,
} from "@zuse/utils/boxd-runtime-protocol";

const exec = promisify(execFile);
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

/** No service layers, database, key material or outbound connections exist here. */
export const prepareBoxdRuntime = async (input: {
	readonly socketPath?: string;
	readonly files: ReadonlyArray<string>;
	readonly activate: (activation: BoxdRuntimeActivation) => Promise<void>;
}) => {
	if (input.files.length === 0)
		throw new Error("prepared runtime requires bootstrap files");
	const socketPath = input.socketPath ?? BOXD_RUNTIME_SOCKET;
	const files: BoxdRuntimeFile[] = await Promise.all(
		input.files.map(async (path) => ({
			path,
			sha256: digest(await readFile(path, "utf8")),
		})),
	);
	let identity: string | undefined;
	let failed = false;
	let retired = false;
	const server = createServer((socket) => {
		let bytes = Buffer.alloc(0);
		let handled = false;
		socket.setTimeout(15_000, () => socket.destroy());
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			if (handled) return;
			bytes = Buffer.concat([bytes, chunk]);
			if (bytes.length > 131_072) {
				socket.destroy();
				return;
			}
			const newline = bytes.indexOf(10);
			if (newline < 0) return;
			handled = true;
			const reply = (state: string) =>
				socket.end(
					`${JSON.stringify({ version: BOXD_RUNTIME_PROTOCOL, state, pid: process.pid })}\n`,
				);
			try {
				const request = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
				if (retired) {
					reply("cold");
					return;
				}
				if (request.version !== BOXD_RUNTIME_PROTOCOL) {
					retired = identity === undefined;
					reply(retired ? "cold" : "conflict");
					return;
				}
				if (request.action === "status") {
					reply(
						failed ? "failed" : identity === undefined ? "prepared" : "active",
					);
					return;
				}
				if (
					request.action !== "activate" ||
					!request.env ||
					typeof request.env !== "object" ||
					Array.isArray(request.env) ||
					Object.entries(request.env).some(
						([key, value]) =>
							!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
							typeof value !== "string" ||
							value.includes("\0"),
					) ||
					![
						"ZUSE_CLOUD_WORKSPACE_ID",
						"ZUSE_RUNTIME_GENERATION",
						"ZUSE_GATEWAY_EPOCH",
						"ZUSE_RUNTIME_BOOT_TOKEN",
						"ZUSE_CLOUD_WORKSPACE_ROOT",
						"ZUSE_API_URL",
					].every((key) => request.env[key]?.length > 0)
				) {
					reply("invalid");
					return;
				}
				const activation = request as BoxdRuntimeActivation;
				const nextIdentity = digest(
					JSON.stringify([
						activation.env.ZUSE_CLOUD_WORKSPACE_ID,
						activation.env.ZUSE_RUNTIME_GENERATION,
						activation.env.ZUSE_GATEWAY_EPOCH,
						activation.env.ZUSE_RUNTIME_BOOT_TOKEN,
					]),
				);
				if (identity !== undefined) {
					reply(identity === nextIdentity && !failed ? "active" : "conflict");
					return;
				}
				if (
					!files.some((file) => file.path === activation.bootstrap) ||
					JSON.stringify(activation.files) !== JSON.stringify(files)
				) {
					// Reserve the idle process for replacement before acknowledging it.
					retired = true;
					reply("cold");
					return;
				}
				// Claim before any await. A lost acknowledgement cannot launch twice.
				identity = nextIdentity;
				reply("active");
				void input.activate(activation).catch(async () => {
					failed = true;
					// Do not log the activation payload or an exec error containing env.
					console.error("[boxd-runtime] activation failed");
					await writeFile("/var/lib/zuse/workspace/failed", "", {
						mode: 0o600,
					}).catch(() => {});
				});
			} catch {
				reply("invalid");
			}
		});
	});
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// Never unlink a possibly live listener during a retried image build.
		server.listen(socketPath, resolve);
	});
	await chmod(socketPath, 0o600);
	return server;
};

/** Restored OpenSSL state can repeat keys. Always exec a fresh runtime process. */
export const activateBoxdRuntime = async (
	activation: BoxdRuntimeActivation,
) => {
	const prepared = await exec(
		"/bin/bash",
		[activation.bootstrap, "--prepare-boxd-runtime"],
		{
			env: { ...process.env, ...activation.env },
			cwd: "/home/zuse",
			maxBuffer: 262_144,
			timeout: 30_000,
		},
	);
	const environment = JSON.parse(
		prepared.stdout.trim().split("\n").at(-1) ?? "null",
	) as NodeJS.ProcessEnv;
	if (
		!environment ||
		environment.ZUSE_CLOUD_WORKSPACE_ID !==
			activation.env.ZUSE_CLOUD_WORKSPACE_ID
	)
		throw new Error("invalid bootstrap environment");
	// NODE_COMPILE_CACHE and the snapshot's page cache retain the expensive code
	// work. A new process gives OpenSSL and UUID pools fresh random state.
	const runtime = spawn(
		process.execPath,
		["/opt/zuse/current/bin.mjs", "serve"],
		{
			env: environment,
			cwd: "/home/zuse",
			stdio: "inherit",
		},
	);
	const runtimeExited = new Promise<never>((_resolve, reject) => {
		runtime.once("error", () => reject(new Error("runtime launch failed")));
		runtime.once("exit", () => reject(new Error("runtime exited")));
	});
	// Repository setup overlaps runtime service acquisition and enrollment.
	const repository = exec(
		"/bin/bash",
		["/var/lib/zuse/project-build/workspace-repository.sh"],
		{
			env: environment,
			cwd: "/home/zuse",
			timeout: 120_000,
		},
	).then(async () => {
		await writeFile("/var/lib/zuse/workspace/repository-ready", "");
	});
	await Promise.all([repository, runtimeExited]);
};
