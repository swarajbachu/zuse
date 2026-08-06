import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { TailnetShareState } from "@zuse/contracts";

export type TailnetCommandResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
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

export const runTailnetCommand: TailnetCommandRunner = (
	args,
	timeoutMs = 10_000,
) =>
	new Promise((resolve, reject) => {
		const child = spawn(resolveTailnetExecutable(), [...args], {
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
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error("Tailscale command timed out."));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.once("error", finish);
		child.once("exit", (code) =>
			finish({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code: code ?? 1,
			}),
		);
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
	if (!input.enabled && !before.enabled) return before;
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
	const result = await run(args, 20_000);
	if (result.code !== 0) {
		return TailnetShareState.make({
			...before,
			availability: "error",
			detail:
				compactDiagnostic(result.stderr || result.stdout) ??
				"Tailscale Serve could not be updated.",
		});
	}
	return inspectTailnetShare(input.port, run);
};
