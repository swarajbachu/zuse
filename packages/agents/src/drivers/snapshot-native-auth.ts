import { execFile } from "node:child_process";
import { CodexAppServerClient } from "./codex-app-server-client.ts";

export type SnapshotAgentAccess =
	| "detected"
	| "verified"
	| "authentication-required"
	| "expired"
	| "unavailable"
	| "missing-tool";

/** Probe native account state without exporting credentials or sending a prompt. */
export const checkSnapshotAgentAccess = async (
	providerId: "claude" | "codex",
): Promise<SnapshotAgentAccess> => {
	if (providerId === "claude")
		return new Promise((resolve) => {
			execFile(
				"claude",
				["auth", "status", "--json"],
				{ timeout: 8000, maxBuffer: 16384 },
				(error, stdout) => {
					if (error?.code === "ENOENT") return resolve("missing-tool");
					if (error?.killed) return resolve("unavailable");
					try {
						const status = JSON.parse(stdout);
						resolve(
							status.loggedIn === true ? "detected" : "authentication-required",
						);
					} catch {
						resolve("unavailable");
					}
				},
			);
		});
	let client: CodexAppServerClient | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		client = await CodexAppServerClient.start({
			codexPath: null,
			startupTimeoutMs: 8000,
			onNotification: () => {},
			onServerRequest: (_request, respond) => respond(null),
			onStderr: () => {},
		});
		const account = await Promise.race([
			client.request<{ account: { type: string } | null }>("account/read", {
				refreshToken: true,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 8000);
			}),
		]);
		return account.account === null ? "authentication-required" : "detected";
	} catch (cause) {
		if (
			cause instanceof Error &&
			/refresh token.*(?:expired|revoked|used)|401|unauthorized|authentication required/i.test(
				cause.message,
			)
		)
			return "expired";
		return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
			? "missing-tool"
			: "unavailable";
	} finally {
		if (timer) clearTimeout(timer);
		client?.close();
	}
};
