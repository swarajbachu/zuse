import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AccountProfile } from "./contracts.ts";

export async function readCredential(path: string) {
	const resolved = path.startsWith("~/")
		? join(homedir(), path.slice(2))
		: path;
	if (!isAbsolute(resolved))
		throw new Error(
			"Enter an absolute credential-file path, or start it with ~/.",
		);
	const file = await open(
		resolved,
		constants.O_RDONLY | constants.O_NONBLOCK,
	).catch((cause: unknown) => {
		throw new Error(
			"Cannot open this profile's credential file. Check its path and permissions.",
			{ cause },
		);
	});
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 65536)
			throw new Error(
				"Credential source must be a JSON file smaller than 64 KiB.",
			);
		const bytes = new Uint8Array(65537);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 65536) throw new Error("Credential file is too large.");
		try {
			return JSON.parse(
				new TextDecoder().decode(bytes.subarray(0, bytesRead)),
			) as unknown;
		} catch {
			throw new Error("Credential file contains invalid JSON.");
		}
	} finally {
		await file.close();
	}
}

const execute = promisify(execFile);
class MissingLogin extends Error {}
const missingFile = (error: unknown) =>
	error instanceof Error &&
	error.cause !== null &&
	typeof error.cause === "object" &&
	"code" in error.cause &&
	error.cause.code === "ENOENT";

export async function readKeychain(
	service: string,
	account: string | undefined,
	signal: AbortSignal,
): Promise<unknown> {
	signal.throwIfAborted();
	let stdout: string;
	try {
		({ stdout } = await execute(
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				service,
				...(account ? ["-a", account] : []),
				"-w",
			],
			{ encoding: "utf8", timeout: 15000, maxBuffer: 65536, signal },
		));
	} catch (error) {
		signal.throwIfAborted();
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === 44
		)
			throw new MissingLogin();
		throw new Error(
			"Keychain access was denied or timed out. Click Connect again and allow access in the macOS dialog.",
		);
	}
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		throw new Error(
			"The saved login is unreadable. Sign in again in your agent, then retry.",
		);
	}
}

/** Called only after Connect/Refresh, never while listing profiles or starting Zuse. */
export async function readCurrentCredential(
	provider: AccountProfile["provider"],
	signal: AbortSignal,
	options: {
		home?: string;
		platform?: string;
		env?: Readonly<Record<string, string | undefined>>;
		keychain?: typeof readKeychain;
	} = {},
): Promise<unknown> {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const keychain = options.keychain ?? readKeychain;
	const directory =
		provider === "codex"
			? env.CODEX_HOME?.trim() || join(home, ".codex")
			: env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
	const file = join(
		directory,
		provider === "codex" ? "auth.json" : ".credentials.json",
	);
	signal.throwIfAborted();
	// Claude uses Keychain on macOS. Custom config directories use explicit file profiles.
	if (
		provider === "claude" &&
		platform === "darwin" &&
		!env.CLAUDE_CONFIG_DIR?.trim()
	) {
		try {
			return await keychain("Claude Code-credentials", undefined, signal);
		} catch (error) {
			if (!(error instanceof MissingLogin)) throw error;
		}
	}
	try {
		return await readCredential(file);
	} catch (error) {
		if (!missingFile(error)) throw error;
	}
	if (provider === "codex" && platform === "darwin") {
		const canonical = await realpath(directory).catch(() => directory);
		const account = `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
		try {
			return await keychain("Codex Auth", account, signal);
		} catch (error) {
			if (!(error instanceof MissingLogin)) throw error;
		}
	}
	throw new Error(
		provider === "codex"
			? "No Codex login found. Run codex login in Terminal, then click Connect Codex."
			: "No Claude Code login found. Open Claude Code and run /login, then click Connect Claude Code.",
	);
}

export function readAccountCredential(
	account: AccountProfile,
	signal: AbortSignal,
) {
	return account.usesCurrentLogin
		? readCurrentCredential(account.provider, signal)
		: readCredential(account.credentialPath);
}
