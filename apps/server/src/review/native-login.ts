import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	lstat,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { validateNativeReviewProfile } from "@zuse/agents/review/claude-profile";
import { extractProviderLoginUrl } from "../provider/services/login-service.ts";

export interface NativeLoginChallenge {
	readonly authorizationUrl: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly expiresAtMs: number;
}

export function parseNativeLoginChallenge(
	raw: string,
	expiresAtMs: number,
): NativeLoginChallenge | null {
	const value = extractProviderLoginUrl(
		raw,
		(url) =>
			url.protocol === "https:" &&
			["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(
				url.hostname,
			),
	);
	if (!value) return null;
	const authorization = new URL(value);
	const redirectUri = authorization.searchParams.get("redirect_uri");
	const state = authorization.searchParams.get("state");
	if (!redirectUri || !state || state.length > 1024) return null;
	let redirect: URL;
	try {
		redirect = new URL(redirectUri);
	} catch {
		return null;
	}
	if (
		redirect.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
		!redirect.port ||
		redirect.username ||
		redirect.password ||
		redirect.hash ||
		redirect.search
	)
		return null;
	return {
		authorizationUrl: value,
		redirectUri: redirect.href,
		state,
		expiresAtMs,
	};
}

export function validateNativeLoginCallback(
	challenge: NativeLoginChallenge,
	value: string,
	nowMs: number,
): URL {
	if (nowMs >= challenge.expiresAtMs || value.length > 16_000)
		throw new Error("Native login challenge expired or invalid");
	const callback = new URL(value);
	const redirect = new URL(challenge.redirectUri);
	if (
		callback.origin !== redirect.origin ||
		callback.pathname !== redirect.pathname ||
		callback.username ||
		callback.password ||
		callback.hash ||
		callback.searchParams.getAll("state").length !== 1 ||
		callback.searchParams.get("state") !== challenge.state ||
		callback.searchParams.getAll("code").length !== 1 ||
		!callback.searchParams.get("code") ||
		[...callback.searchParams.keys()].some(
			(key) => key !== "code" && key !== "state",
		)
	)
		throw new Error("Native login callback does not match challenge");
	return callback;
}

/** Native process owns PKCE and token exchange. The host only relays one callback. */
export async function runNativeLogin(input: {
	readonly executablePath: string;
	readonly authHome: string;
	readonly trustedCwd: string;
	readonly statusFile: string;
	readonly callbackFile: string;
	readonly signal: AbortSignal;
}): Promise<void> {
	await mkdir(input.authHome, { recursive: true, mode: 0o700 });
	await chmod(input.authHome, 0o700);
	await chown(input.authHome, 1000, 1000);
	await mkdir(input.trustedCwd, { recursive: true, mode: 0o700 });
	await chown(input.trustedCwd, 1000, 1000);
	await unlink(input.callbackFile).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	const expiresAtMs = Date.now() + 600_000;
	const status = async (value: object) => {
		await writeFile(`${input.statusFile}.tmp`, JSON.stringify(value), {
			mode: 0o600,
		});
		await rename(`${input.statusFile}.tmp`, input.statusFile);
	};
	await status({ state: "authenticating", expiresAtMs });
	const child = spawn(input.executablePath, ["auth", "login", "--claudeai"], {
		cwd: input.trustedCwd,
		env: {
			HOME: input.trustedCwd,
			CLAUDE_CONFIG_DIR: input.authHome,
			PATH: "/usr/local/bin:/usr/bin:/bin",
			BROWSER: "/bin/false",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		uid: 1000,
		gid: 1000,
	});
	let challenge: NativeLoginChallenge | null = null;
	let buffer = "";
	let consumed = false;
	let polling = false;
	let statusWrite = Promise.resolve();
	const output = (data: Buffer) => {
		buffer = (buffer + data.toString("utf8")).slice(-32_000);
		if (!challenge) {
			challenge = parseNativeLoginChallenge(buffer, expiresAtMs);
			if (challenge)
				statusWrite = status({
					state: "authenticating",
					verificationUrl: challenge.authorizationUrl,
					expiresAtMs,
				});
		}
	};
	child.stdout.on("data", output);
	child.stderr.on("data", output);
	const stop = () => {
		if (child.pid)
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					throw error;
			}
	};
	input.signal.addEventListener("abort", stop, { once: true });
	const timeout = setTimeout(stop, 600_000);
	const interval = setInterval(() => {
		if (polling || consumed || !challenge) return;
		polling = true;
		void (async () => {
			try {
				const meta = await lstat(input.callbackFile);
				if (
					!meta.isFile() ||
					meta.isSymbolicLink() ||
					(meta.mode & 0o077) !== 0 ||
					meta.size > 20_000
				)
					throw new Error("Unsafe native callback file");
				const text = await readFile(input.callbackFile, "utf8");
				await unlink(input.callbackFile);
				const value: unknown = JSON.parse(text);
				if (
					!challenge ||
					typeof value !== "object" ||
					value === null ||
					!("callbackUrl" in value) ||
					typeof value.callbackUrl !== "string"
				)
					throw new Error("Invalid native callback");
				const callback = validateNativeLoginCallback(
					challenge,
					value.callbackUrl,
					Date.now(),
				);
				consumed = true;
				await fetch(callback, {
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
				)
					stop();
			} finally {
				polling = false;
			}
		})();
	}, 250);
	try {
		if (input.signal.aborted) stop();
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error("Native login failed")),
			);
		});
		await statusWrite;
		await validateNativeReviewProfile({
			...input,
			model: "auth-validation",
			nativeUid: 1000,
		});
		const metadataPath = join(input.authHome, ".claude.json");
		const meta = await lstat(metadataPath);
		if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 1_000_000)
			throw new Error("Native account identity unavailable");
		const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
		if (
			typeof metadata !== "object" ||
			metadata === null ||
			!("oauthAccount" in metadata) ||
			typeof metadata.oauthAccount !== "object" ||
			metadata.oauthAccount === null ||
			!("accountUuid" in metadata.oauthAccount) ||
			typeof metadata.oauthAccount.accountUuid !== "string" ||
			!/^[a-f0-9-]{36}$/iu.test(metadata.oauthAccount.accountUuid)
		)
			throw new Error("Native account identity unavailable");
		const providerIdentity = `claude:${createHash("sha256").update(metadata.oauthAccount.accountUuid.toLowerCase()).digest("hex")}`;
		await status({ state: "ready", providerIdentity });
	} catch {
		await statusWrite.catch(() => {});
		await status({ state: "failed", reason: "native-login-incomplete" });
	} finally {
		clearInterval(interval);
		clearTimeout(timeout);
		input.signal.removeEventListener("abort", stop);
		stop();
		await unlink(input.callbackFile).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
