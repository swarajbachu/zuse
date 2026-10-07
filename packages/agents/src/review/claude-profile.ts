import { type ChildProcess, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	type Options,
	type Query,
	query,
} from "@anthropic-ai/claude-agent-sdk";

/** Native auth stays inside a dedicated connection sandbox; never serialize it. */
export interface NativeReviewProfile {
	readonly authHome: string;
	readonly trustedCwd: string;
	readonly executablePath: string;
	readonly model: string;
	readonly nativeUid?: number;
}

export async function validateNativeReviewProfile(
	profile: NativeReviewProfile,
): Promise<void> {
	for (const path of [
		profile.authHome,
		profile.trustedCwd,
		profile.executablePath,
	]) {
		if (!isAbsolute(path) || (await realpath(path)) !== resolve(path))
			throw new Error("Review profile path must be canonical");
	}
	const auth = await lstat(profile.authHome);
	const cwd = await lstat(profile.trustedCwd);
	const binary = await lstat(profile.executablePath);
	if (
		!auth.isDirectory() ||
		(auth.mode & 0o077) !== 0 ||
		auth.uid !== (profile.nativeUid ?? process.getuid?.())
	)
		throw new Error("Review auth home must be private and owned by worker");
	if (
		!cwd.isDirectory() ||
		!binary.isFile() ||
		profile.authHome === profile.trustedCwd ||
		!profile.model.trim()
	)
		throw new Error("Invalid native review profile");
	// Do not initialize/replace auth state: missing native login is a reconnect state.
	const credentials = await lstat(
		resolve(profile.authHome, ".credentials.json"),
	);
	if (
		!credentials.isFile() ||
		credentials.isSymbolicLink() ||
		(credentials.mode & 0o077) !== 0 ||
		credentials.uid !== auth.uid
	)
		throw new Error("Native review login unavailable");
}

/** Defense in depth, not a claim that the release confinement probe passed. */
export function nativeReviewOptions(
	profile: NativeReviewProfile,
	controller: AbortController,
): Options {
	return {
		pathToClaudeCodeExecutable: profile.executablePath,
		cwd: profile.trustedCwd,
		model: profile.model,
		env: {
			HOME: profile.trustedCwd,
			CLAUDE_CONFIG_DIR: profile.authHome,
			PATH: "/usr/local/bin:/usr/bin:/bin",
			LANG: "C.UTF-8",
			CLAUDE_AGENT_SDK_CLIENT_APP: "zuse-review/1",
		},
		abortController: controller,
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		plugins: [],
		skills: [],
		agents: {},
		hooks: {},
		settings: {
			disableAllHooks: true,
			disableCommandPluginSources: true,
			autoMemoryEnabled: false,
		},
		persistSession: false,
		enableFileCheckpointing: false,
		permissionMode: "dontAsk",
		maxTurns: 80,
		canUseTool: async (_name, _input) => ({
			behavior: "deny",
			message: "Only the trusted review service is available",
		}),
	};
}

/** One query, one process group, no resume. Parent owns a bounded kill-and-reap. */
export async function createNativeReviewQuery(
	profile: NativeReviewProfile,
	options: Pick<
		Options,
		"mcpServers" | "allowedTools" | "outputFormat" | "systemPrompt"
	>,
	prompt: string,
	signal: AbortSignal,
): Promise<{ query: Query; close: () => Promise<void> }> {
	signal.throwIfAborted();
	const controller = new AbortController();
	let child: ChildProcess | undefined;
	let exited: Promise<void> = Promise.resolve();
	let closing: Promise<void> | undefined;
	const stopGroup = () => {
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					throw error;
			}
		}
	};
	let active: Query;
	try {
		active = query({
			prompt,
			options: {
				...nativeReviewOptions(profile, controller),
				...options,
				spawnClaudeCodeProcess: (input) => {
					if (child || controller.signal.aborted)
						throw new Error("Review subprocess already used or stopped");
					const process = spawn(input.command, input.args, {
						cwd: profile.trustedCwd,
						env: input.env,
						stdio: ["pipe", "pipe", "pipe"],
						detached: true,
						...(profile.nativeUid !== undefined
							? { uid: profile.nativeUid, gid: profile.nativeUid }
							: {}),
					});
					child = process;
					// Never forward native diagnostics: they may include login or repository data.
					process.stderr.resume();
					exited = new Promise<void>((resolve, reject) => {
						process.once("exit", () => resolve());
						process.once("error", reject);
					});
					void exited.catch(() => {});
					return process;
				},
			},
		});
	} catch (error) {
		stopGroup();
		await exited;
		throw error;
	}
	const close = () => {
		closing ??= (async () => {
			signal.removeEventListener("abort", onAbort);
			try {
				controller.abort();
				active.close();
			} finally {
				stopGroup();
				await exited;
			}
		})();
		return closing;
	};
	const onAbort = () => {
		void close().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	return { query: active, close };
}
