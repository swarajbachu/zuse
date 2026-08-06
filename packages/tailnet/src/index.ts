import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { TailnetShareState } from "@zuse/contracts";

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
				url.pathname.startsWith("/admin/feature/")
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

export const runTailnetCommand = (
	args: ReadonlyArray<string>,
	timeoutMs = 10_000,
	executable = resolveTailnetExecutable(),
): Promise<TailnetCommandResult> =>
	new Promise((resolve, reject) => {
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
			finish(capturedResult(75, { approvalUrl }));
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
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
		child.once("error", finish);
		child.once("exit", (code) => finish(capturedResult(code ?? 1)));
	});

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

export const serveStatusMatches = (raw: string, port: number): boolean => {
	const normalized = raw.toLowerCase();
	return (
		normalized.includes(`127.0.0.1:${port}`) ||
		normalized.includes(`localhost:${port}`)
	);
};

export const serveStatusIsExclusive = (raw: string, port: number): boolean => {
	if (!serveStatusMatches(raw, port)) return false;
	const routes = raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("|--") || line.startsWith("+--"));
	return routes.length === 1;
};

const hasServeConfiguration = (raw: string): boolean => {
	const normalized = raw.trim().toLowerCase();
	return normalized.length > 0 && !normalized.includes("no serve config");
};

export const inspectTailnetShare = async (
	port: number,
	run: TailnetCommandRunner = runTailnetCommand,
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
		});
	}

	const serve = await run(["serve", "status"], 5_000).catch((cause) => ({
		stdout: "",
		stderr: cause instanceof Error ? cause.message : String(cause),
		code: 1,
	}));
	const enabled = serve.code === 0 && serveStatusMatches(serve.stdout, port);
	return TailnetShareState.make({
		availability: "available",
		enabled,
		dnsName: parsed.dnsName,
		httpsUrl: enabled ? `https://${parsed.dnsName}` : null,
		backendState: parsed.backendState,
		port,
		detail: serve.code === 0 ? null : compactDiagnostic(serve.stderr),
		approvalUrl: null,
	});
};

export const setTailnetShareEnabled = async (
	input: {
		readonly enabled: boolean;
		readonly port: number;
	},
	run: TailnetCommandRunner = runTailnetCommand,
): Promise<TailnetShareState> => {
	const before = await inspectTailnetShare(input.port, run);
	if (before.availability !== "available") return before;
	if (!input.enabled) {
		if (!before.enabled) return before;
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
	if (input.enabled && !before.enabled) {
		const existing = await run(["serve", "status"], 5_000);
		if (existing.code === 0 && hasServeConfiguration(existing.stdout)) {
			return TailnetShareState.make({
				...before,
				availability: "error",
				detail:
					"Tailscale Serve is already configured for another app. Turn it off before sharing Zuse.",
			});
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
	return inspectTailnetShare(input.port, run);
};
