import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TailnetServeConflict, TailnetShareState } from "@zuse/contracts";

export type TailnetCommandResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly timedOut?: boolean;
	readonly approvalUrl?: string;
};

export type TailnetCommandRunner = (
	args: ReadonlyArray<string>,
	timeoutMs?: number,
) => Promise<TailnetCommandResult>;

export type TailnetDiagnosticEvent = {
	readonly event: "start" | "exit" | "timeout" | "approval" | "spawn-error";
	readonly command: string;
	readonly executable: "bundled-app" | "path";
	readonly durationMs?: number;
	readonly timeoutMs?: number;
	readonly code?: number;
	readonly stdoutBytes?: number;
	readonly stderrBytes?: number;
	readonly errorCode?: string;
	readonly outputHint?:
		| "empty"
		| "permission-denied"
		| "daemon-unavailable"
		| "signed-out"
		| "serve-configuration"
		| "unknown";
};

export type TailnetDiagnosticSink = (event: TailnetDiagnosticEvent) => void;

export const resolveTailnetExecutable = (
	platform: NodeJS.Platform = process.platform,
	canExecute: (path: string) => boolean = (path) => {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
): string => {
	if (platform !== "darwin") return "tailscale";
	const bundledCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	return canExecute(bundledCli) ? bundledCli : "tailscale";
};

type StatusPayload = {
	readonly BackendState?: unknown;
	readonly Self?: {
		readonly DNSName?: unknown;
	};
};

const cleanDnsName = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\.$/u, "").toLowerCase();
	return normalized.length === 0 ? null : normalized;
};

const compactDiagnostic = (value: string): string | null => {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length === 0 ? null : normalized.slice(0, 500);
};

export const extractTailnetApprovalUrl = (value: string): string | null => {
	for (const match of value.matchAll(/https:\/\/[^\s<>"']+/gu)) {
		const candidate = match[0].replace(/[),.;]+$/u, "");
		try {
			const url = new URL(candidate);
			if (
				url.hostname === "login.tailscale.com" &&
				(url.pathname === "/f/serve" ||
					url.pathname.startsWith("/admin/feature/"))
			) {
				return url.toString();
			}
		} catch {
			// Ignore malformed command output and continue looking for a valid URL.
		}
	}
	return null;
};

export const tailnetCommandEnvironment = (
	environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
	...environment,
	TAILSCALE_BE_CLI: "1",
});

export const tailnetCommandLabel = (args: ReadonlyArray<string>): string => {
	if (args[0] === "status") return "status";
	if (args[0] !== "serve") return "unknown";
	if (args[1] === "status") return "serve-status";
	if (args.includes("--bg")) return "serve-enable";
	if (args.at(-1) === "off") return "serve-disable";
	return "serve-other";
};

export const tailnetOutputHint = (
	stdout: string,
	stderr: string,
): NonNullable<TailnetDiagnosticEvent["outputHint"]> => {
	const value = `${stderr}\n${stdout}`.trim().toLowerCase();
	if (value.length === 0) return "empty";
	if (/permission denied|operation not permitted|not authorized/u.test(value)) {
		return "permission-denied";
	}
	if (
		/failed to connect|connection refused|daemon.*(?:unavailable|not running)|tailscaled.*not running/u.test(
			value,
		)
	) {
		return "daemon-unavailable";
	}
	if (/not logged in|logged out|needs? login|sign in/u.test(value)) {
		return "signed-out";
	}
	if (/serve|funnel|https|certificate|proxy/u.test(value)) {
		return "serve-configuration";
	}
	return "unknown";
};

export const isTailnetOperatorPermissionError = (value: string): boolean => {
	const normalized = value.toLowerCase();
	return (
		(normalized.includes("serve config denied") ||
			normalized.includes("access denied")) &&
		(normalized.includes("--operator=") ||
			normalized.includes("not require root"))
	);
};

export type TailnetOperatorAuthorization = {
	readonly authorized: boolean;
	readonly manualCommand: string;
	readonly detail: string | null;
};

const LINUX_TAILSCALE_PATHS = [
	"/usr/bin/tailscale",
	"/usr/sbin/tailscale",
	"/usr/local/bin/tailscale",
] as const;

export const authorizeTailnetOperator = async (
	input: {
		readonly username: string;
		readonly platform?: NodeJS.Platform;
		readonly canExecute?: (path: string) => boolean;
	},
	runElevated: TailnetCommandRunner = (args, timeoutMs) =>
		runTailnetCommand(args, timeoutMs, "/usr/bin/pkexec"),
): Promise<TailnetOperatorAuthorization> => {
	const manualCommand = "sudo tailscale set --operator=$USER";
	if ((input.platform ?? process.platform) !== "linux") {
		return {
			authorized: false,
			manualCommand,
			detail: "Automatic Tailscale authorization is available only on Linux.",
		};
	}
	if (
		!/^[A-Za-z0-9._-]+$/u.test(input.username) ||
		input.username.startsWith("-")
	) {
		return {
			authorized: false,
			manualCommand,
			detail: "The current Linux username cannot be authorized automatically.",
		};
	}
	const canExecute =
		input.canExecute ??
		((path: string): boolean => {
			try {
				accessSync(path, constants.X_OK);
				const stat = statSync(path);
				return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
			} catch {
				return false;
			}
		});
	const executable = LINUX_TAILSCALE_PATHS.find(canExecute);
	if (executable === undefined || !canExecute("/usr/bin/pkexec")) {
		return {
			authorized: false,
			manualCommand,
			detail: "A graphical administrator prompt is unavailable.",
		};
	}
	try {
		const result = await runElevated(
			[executable, "set", `--operator=${input.username}`],
			120_000,
		);
		return {
			authorized: result.code === 0,
			manualCommand,
			detail:
				result.code === 0
					? null
					: (compactDiagnostic(result.stderr || result.stdout) ??
						"Administrator authorization was cancelled."),
		};
	} catch (cause) {
		return {
			authorized: false,
			manualCommand,
			detail: compactDiagnostic(
				cause instanceof Error ? cause.message : String(cause),
			),
		};
	}
};

export const runTailnetCommand = (
	args: ReadonlyArray<string>,
	timeoutMs = 10_000,
	executable = resolveTailnetExecutable(),
	diagnostic: TailnetDiagnosticSink = () => undefined,
): Promise<TailnetCommandResult> =>
	new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const command = tailnetCommandLabel(args);
		const executableKind = executable.startsWith("/Applications/")
			? "bundled-app"
			: "path";
		const emit = (event: TailnetDiagnosticEvent): void => {
			try {
				diagnostic(event);
			} catch {
				// Diagnostics must never affect network setup.
			}
		};
		emit({
			event: "start",
			command,
			executable: executableKind,
			timeoutMs,
		});
		const child = spawn(executable, [...args], {
			env: tailnetCommandEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const finish = (result: TailnetCommandResult | Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		const capturedResult = (
			code: number,
			extra: Pick<TailnetCommandResult, "timedOut" | "approvalUrl"> = {},
		): TailnetCommandResult => ({
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			code,
			...extra,
		});
		const finishForApproval = (): void => {
			if (settled || args[0] !== "serve" || !args.includes("--bg")) return;
			const approvalUrl = extractTailnetApprovalUrl(
				`${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`,
			);
			if (approvalUrl === null) return;
			child.kill("SIGTERM");
			emit({
				event: "approval",
				command,
				executable: executableKind,
				durationMs: Date.now() - startedAt,
				stdoutBytes: Buffer.concat(stdout).byteLength,
				stderrBytes: Buffer.concat(stderr).byteLength,
				outputHint: "serve-configuration",
			});
			finish(capturedResult(75, { approvalUrl }));
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			emit({
				event: "timeout",
				command,
				executable: executableKind,
				durationMs: Date.now() - startedAt,
				stdoutBytes: Buffer.concat(stdout).byteLength,
				stderrBytes: Buffer.concat(stderr).byteLength,
				outputHint: tailnetOutputHint(
					Buffer.concat(stdout).toString("utf8"),
					Buffer.concat(stderr).toString("utf8"),
				),
			});
			finish(capturedResult(124, { timedOut: true }));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout.push(Buffer.from(chunk));
			finishForApproval();
		});
		child.stderr.on("data", (chunk) => {
			stderr.push(Buffer.from(chunk));
			finishForApproval();
		});
		child.once("error", (cause) => {
			emit({
				event: "spawn-error",
				command,
				executable: executableKind,
				durationMs: Date.now() - startedAt,
				errorCode:
					typeof cause === "object" && cause !== null && "code" in cause
						? String(cause.code)
						: "unknown",
			});
			finish(cause);
		});
		child.once("exit", (code) => {
			if (!settled) {
				emit({
					event: "exit",
					command,
					executable: executableKind,
					durationMs: Date.now() - startedAt,
					code: code ?? 1,
					stdoutBytes: Buffer.concat(stdout).byteLength,
					stderrBytes: Buffer.concat(stderr).byteLength,
					outputHint: tailnetOutputHint(
						Buffer.concat(stdout).toString("utf8"),
						Buffer.concat(stderr).toString("utf8"),
					),
				});
			}
			finish(capturedResult(code ?? 1));
		});
	});

export const makeTailnetCommandRunner =
	(
		diagnostic: TailnetDiagnosticSink,
		executable = resolveTailnetExecutable(),
	): TailnetCommandRunner =>
	(args, timeoutMs) =>
		runTailnetCommand(args, timeoutMs, executable, diagnostic);

export const parseTailnetStatus = (
	raw: string,
): {
	readonly backendState: string | null;
	readonly dnsName: string | null;
} => {
	const value = JSON.parse(raw) as StatusPayload;
	return {
		backendState:
			typeof value.BackendState === "string" ? value.BackendState : null,
		dnsName: cleanDnsName(value.Self?.DNSName),
	};
};

export type ServeProxyTarget = {
	readonly host: string;
	readonly port: number;
};

const SERVE_PROXY_TARGET_PATTERN =
	/(?:https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?!\d)/gu;

export const parseServeProxyTargets = (
	raw: string,
): ReadonlyArray<ServeProxyTarget> => {
	const targets: ServeProxyTarget[] = [];
	for (const match of raw.toLowerCase().matchAll(SERVE_PROXY_TARGET_PATTERN)) {
		const host = match[1];
		const port = Number(match[2]);
		if (host !== undefined && port >= 1 && port <= 65_535) {
			targets.push({ host, port });
		}
	}
	return targets;
};

export const serveStatusMatches = (raw: string, port: number): boolean =>
	parseServeProxyTargets(raw).some((target) => target.port === port);

export const serveStatusIsExclusive = (raw: string, port: number): boolean => {
	if (!serveStatusMatches(raw, port)) return false;
	const routes = raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("|--") || line.startsWith("+--"));
	return routes.length === 1;
};

const hasServeConfiguration = (raw: string): boolean => {
	if (raw.trim().length === 0) return false;
	if (parseServeProxyTargets(raw).length > 0) return true;
	return raw
		.split(/\r?\n/u)
		.some(
			(line) => line.trim().startsWith("|--") || line.trim().startsWith("+--"),
		);
};

export type ZuseProbeResult = "zuse" | "other" | "unreachable";
export type ZuseIdentityProbe = (port: number) => Promise<ZuseProbeResult>;

const PROBE_TIMEOUT_MS = 1_500;

type ProbeResponse =
	| { readonly kind: "json"; readonly value: Record<string, unknown> }
	| { readonly kind: "other" }
	| { readonly kind: "unreachable" };

const probeRequest = async (
	port: number,
	path: string,
	init: RequestInit,
): Promise<ProbeResponse> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			signal: controller.signal,
		});
		if (!response.ok) return { kind: "other" };
		const value: unknown = await response.json();
		return typeof value === "object" && value !== null
			? { kind: "json", value: value as Record<string, unknown> }
			: { kind: "other" };
	} catch (cause) {
		// A parse failure on a 200 means "answered, but not as expected".
		if (cause instanceof SyntaxError) return { kind: "other" };
		return { kind: "unreachable" };
	} finally {
		clearTimeout(timer);
	}
};

export const probeZuseLoopback: ZuseIdentityProbe = async (port) => {
	const identity = await probeRequest(port, "/pair/identity", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ challenge: randomBytes(16).toString("hex") }),
	});
	if (identity.kind === "unreachable") return "unreachable";
	if (
		identity.kind === "json" &&
		typeof identity.value.publicKey === "string" &&
		typeof identity.value.signature === "string"
	) {
		return "zuse";
	}
	// Older zuse serve daemons may predate /pair/identity.
	const session = await probeRequest(port, "/auth/session", { method: "GET" });
	if (session.kind === "unreachable") return "unreachable";
	if (
		session.kind === "json" &&
		typeof session.value.authenticated === "boolean" &&
		typeof session.value.authRequired === "boolean"
	) {
		return "zuse";
	}
	return "other";
};

const SERVE_OWNERSHIP_FILE = "tailnet-serve.json";

export const readServeOwnershipMarker = async (
	dir: string,
): Promise<number | null> => {
	try {
		const raw = await readFile(join(dir, SERVE_OWNERSHIP_FILE), "utf8");
		const parsed = JSON.parse(raw) as { readonly port?: unknown };
		return typeof parsed.port === "number" &&
			Number.isInteger(parsed.port) &&
			parsed.port >= 1 &&
			parsed.port <= 65_535
			? parsed.port
			: null;
	} catch {
		return null;
	}
};

export const writeServeOwnershipMarker = async (
	dir: string,
	port: number,
): Promise<void> => {
	const target = join(dir, SERVE_OWNERSHIP_FILE);
	const temporary = `${target}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ port })}\n`, {
		mode: 0o600,
	});
	await rename(temporary, target);
};

export const clearServeOwnershipMarker = async (dir: string): Promise<void> => {
	await rm(join(dir, SERVE_OWNERSHIP_FILE), { force: true });
};

export type ServeOwnership =
	| { readonly kind: "none" }
	| { readonly kind: "active" }
	| { readonly kind: "repair"; readonly previousPort: number }
	| { readonly kind: "zuse-daemon"; readonly port: number }
	| { readonly kind: "dead-target"; readonly port: number }
	| { readonly kind: "foreign"; readonly port: number }
	| { readonly kind: "unrecognized" };

export const resolveServeOwnership = async (input: {
	readonly serveStatusRaw: string;
	readonly requestedPort: number;
	readonly markerPort: number | null;
	readonly probe: ZuseIdentityProbe;
}): Promise<ServeOwnership> => {
	if (!hasServeConfiguration(input.serveStatusRaw)) return { kind: "none" };
	const targets = parseServeProxyTargets(input.serveStatusRaw);
	const target = targets[0];
	if (target === undefined) return { kind: "unrecognized" };
	if (target.port === input.requestedPort) return { kind: "active" };
	// The marker wins even when something else now listens on the old port:
	// that squatter is exactly why the relay port drifted, and the serve route
	// still belongs to Zuse until Zuse repoints or releases it.
	if (target.port === input.markerPort) {
		return { kind: "repair", previousPort: target.port };
	}
	switch (await input.probe(target.port)) {
		case "zuse":
			return { kind: "zuse-daemon", port: target.port };
		case "unreachable":
			return { kind: "dead-target", port: target.port };
		default:
			return { kind: "foreign", port: target.port };
	}
};

export type TailnetShareOptions = {
	readonly ownershipDir?: string;
	readonly probe?: ZuseIdentityProbe;
};

export const inspectTailnetShare = async (
	port: number,
	run: TailnetCommandRunner = runTailnetCommand,
	options: TailnetShareOptions = {},
): Promise<TailnetShareState> => {
	let status: TailnetCommandResult;
	try {
		status = await run(["status", "--json"], 5_000);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return TailnetShareState.make({
			availability: message.includes("ENOENT") ? "not-installed" : "error",
			enabled: false,
			dnsName: null,
			httpsUrl: null,
			backendState: null,
			port,
			detail: compactDiagnostic(message),
			approvalUrl: null,
			managedBy: null,
			conflict: null,
		});
	}
	if (status.code !== 0) {
		const detail = compactDiagnostic(status.stderr || status.stdout);
		return TailnetShareState.make({
			availability: "signed-out",
			enabled: false,
			dnsName: null,
			httpsUrl: null,
			backendState: null,
			port,
			detail,
			approvalUrl: null,
			managedBy: null,
			conflict: null,
		});
	}

	let parsed: ReturnType<typeof parseTailnetStatus>;
	try {
		parsed = parseTailnetStatus(status.stdout);
	} catch (cause) {
		return TailnetShareState.make({
			availability: "error",
			enabled: false,
			dnsName: null,
			httpsUrl: null,
			backendState: null,
			port,
			detail: compactDiagnostic(
				cause instanceof Error ? cause.message : String(cause),
			),
			approvalUrl: null,
			managedBy: null,
			conflict: null,
		});
	}
	if (parsed.backendState !== "Running" || parsed.dnsName === null) {
		return TailnetShareState.make({
			availability: "signed-out",
			enabled: false,
			dnsName: parsed.dnsName,
			httpsUrl: null,
			backendState: parsed.backendState,
			port,
			detail: "Sign in to Tailscale on this computer.",
			approvalUrl: null,
			managedBy: null,
			conflict: null,
		});
	}

	const serve = await run(["serve", "status"], 5_000).catch((cause) => ({
		stdout: "",
		stderr: cause instanceof Error ? cause.message : String(cause),
		code: 1,
	}));
	const base = {
		dnsName: parsed.dnsName,
		backendState: parsed.backendState,
		port,
		approvalUrl: null,
	};
	if (serve.code !== 0) {
		return TailnetShareState.make({
			...base,
			availability: "available",
			enabled: false,
			httpsUrl: null,
			detail: compactDiagnostic(serve.stderr),
			managedBy: null,
			conflict: null,
		});
	}
	const markerPort =
		options.ownershipDir === undefined
			? null
			: await readServeOwnershipMarker(options.ownershipDir);
	const ownership = await resolveServeOwnership({
		serveStatusRaw: serve.stdout,
		requestedPort: port,
		markerPort,
		probe: options.probe ?? probeZuseLoopback,
	});
	switch (ownership.kind) {
		case "none":
			return TailnetShareState.make({
				...base,
				availability: "available",
				enabled: false,
				httpsUrl: null,
				detail: null,
				managedBy: null,
				conflict: null,
			});
		case "active":
			if (options.ownershipDir !== undefined && markerPort !== port) {
				// Existing routes predate the marker; record ownership now so the
				// next port drift repairs silently instead of reporting a conflict.
				await writeServeOwnershipMarker(options.ownershipDir, port).catch(
					() => undefined,
				);
			}
			return TailnetShareState.make({
				...base,
				availability: "available",
				enabled: true,
				httpsUrl: `https://${parsed.dnsName}`,
				detail: null,
				managedBy: "this-app",
				conflict: null,
			});
		case "repair":
			// Zuse owns the route but the local port drifted; enabling again (or
			// repairTailnetShare at startup) repoints it.
			return TailnetShareState.make({
				...base,
				availability: "available",
				enabled: false,
				httpsUrl: null,
				detail: null,
				managedBy: "this-app",
				conflict: null,
			});
		case "zuse-daemon":
			return TailnetShareState.make({
				...base,
				availability: "available",
				enabled: true,
				httpsUrl: `https://${parsed.dnsName}`,
				detail: null,
				managedBy: "zuse-serve",
				conflict: null,
			});
		case "dead-target":
			return TailnetShareState.make({
				...base,
				availability: "conflict",
				enabled: false,
				httpsUrl: null,
				detail: `Tailscale Serve points at port ${ownership.port}, which is not responding.`,
				managedBy: null,
				conflict: TailnetServeConflict.make({
					reason: "unresponsive-owner",
					targetPort: ownership.port,
					canReplace: true,
				}),
			});
		case "foreign":
			return TailnetShareState.make({
				...base,
				availability: "conflict",
				enabled: false,
				httpsUrl: null,
				detail: `Tailscale Serve is used by another app (port ${ownership.port}).`,
				managedBy: null,
				conflict: TailnetServeConflict.make({
					reason: "foreign-app",
					targetPort: ownership.port,
					canReplace: true,
				}),
			});
		case "unrecognized":
			return TailnetShareState.make({
				...base,
				availability: "conflict",
				enabled: false,
				httpsUrl: null,
				detail:
					"Tailscale Serve has an existing configuration Zuse doesn't recognize.",
				managedBy: null,
				conflict: TailnetServeConflict.make({
					reason: "unrecognized-config",
					targetPort: null,
					canReplace: true,
				}),
			});
	}
};

export const setTailnetShareEnabled = async (
	input: {
		readonly enabled: boolean;
		readonly port: number;
		readonly replaceExisting?: boolean;
		readonly ownershipDir?: string;
		readonly probe?: ZuseIdentityProbe;
	},
	run: TailnetCommandRunner = runTailnetCommand,
): Promise<TailnetShareState> => {
	const options: TailnetShareOptions = {
		ownershipDir: input.ownershipDir,
		probe: input.probe,
	};
	const before = await inspectTailnetShare(input.port, run, options);
	if (
		before.availability !== "available" &&
		before.availability !== "conflict"
	) {
		return before;
	}
	if (!input.enabled) {
		if (!before.enabled) return before;
		if (before.managedBy === "zuse-serve") {
			return TailnetShareState.make({
				...before,
				availability: "error",
				detail:
					"Tailscale sharing is managed by zuse serve on this computer. Run `zuse serve --stop` to change it.",
			});
		}
		const existing = await run(["serve", "status"], 5_000);
		if (
			existing.code !== 0 ||
			!serveStatusIsExclusive(existing.stdout, input.port)
		) {
			return TailnetShareState.make({
				...before,
				availability: "error",
				detail:
					"Tailscale Serve contains additional routes. Zuse will not turn them off automatically.",
			});
		}
	}
	if (input.enabled) {
		// Covers both an active route on this port and a live zuse serve daemon;
		// neither should be replaced, and the daemon route stays untouched.
		if (before.enabled) return before;
		if (before.availability === "conflict") {
			const reclaimable = before.conflict?.reason === "unresponsive-owner";
			if (!reclaimable && input.replaceExisting !== true) return before;
		}
	}
	const args = input.enabled
		? ["serve", "--bg", "--yes", `127.0.0.1:${input.port}`]
		: ["serve", "--https=443", "off"];
	const result = await run(args, 90_000);
	if (result.approvalUrl !== undefined) {
		return TailnetShareState.make({
			...before,
			availability: "approval-required",
			detail:
				"Approve Tailscale Serve in your browser, then return here and try again.",
			approvalUrl: result.approvalUrl,
		});
	}
	if (result.code !== 0) {
		return TailnetShareState.make({
			...before,
			availability: "error",
			detail:
				compactDiagnostic(result.stderr || result.stdout) ??
				(result.timedOut === true
					? "Tailscale Serve did not finish setup. Open Tailscale, confirm it is connected, and try again."
					: "Tailscale Serve could not be updated."),
		});
	}
	if (input.ownershipDir !== undefined) {
		if (input.enabled) {
			await writeServeOwnershipMarker(input.ownershipDir, input.port).catch(
				() => undefined,
			);
		} else {
			await clearServeOwnershipMarker(input.ownershipDir).catch(
				() => undefined,
			);
		}
	}
	return inspectTailnetShare(input.port, run, options);
};

/**
 * Repoints a Zuse-owned Serve route after the local port drifted between
 * launches. A no-op unless the current state is exactly the drift signature:
 * available, not enabled for the requested port, but still marked as owned by
 * this app (the persisted ownership marker matches the existing route).
 */
export const repairTailnetShare = async (
	port: number,
	options: TailnetShareOptions,
	run: TailnetCommandRunner = runTailnetCommand,
): Promise<TailnetShareState> => {
	const state = await inspectTailnetShare(port, run, options);
	if (
		state.availability !== "available" ||
		state.enabled ||
		state.managedBy !== "this-app"
	) {
		return state;
	}
	return setTailnetShareEnabled({ enabled: true, port, ...options }, run);
};
