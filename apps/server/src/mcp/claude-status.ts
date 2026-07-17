import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";

import { scrubInheritedClaudeMarkers } from "@zuse/agents/drivers/claude-env";
import type {
	McpServerDescriptor,
	McpServerSource,
	McpServerState,
	McpServerStatus,
	McpTransport,
} from "@zuse/contracts";
import { Effect } from "effect";
import * as pty from "node-pty";

export interface ClaudeLiveMcpEntry {
	readonly name: string;
	readonly source: Extract<
		McpServerSource,
		"claude-user" | "claude-plugin" | "claude-app"
	>;
	readonly transport: McpTransport | null;
	readonly command: string | null;
	readonly url: string | null;
	readonly state: McpServerState;
	readonly error: string | null;
	readonly checkedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (filePath: string): unknown => {
	try {
		return JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		return null;
	}
};

const sourceForName = (name: string): ClaudeLiveMcpEntry["source"] =>
	name.startsWith("plugin:")
		? "claude-plugin"
		: name.startsWith("claude.ai ")
			? "claude-app"
			: "claude-user";

const statusFromText = (
	text: string,
): Pick<ClaudeLiveMcpEntry, "state" | "error"> => {
	const normalized = text.toLowerCase();
	if (/(^|\s)connected$/u.test(normalized)) {
		return { state: "connected", error: null };
	}
	if (normalized.includes("needs authentication")) {
		return { state: "needs-auth", error: null };
	}
	if (normalized.includes("disabled")) {
		return { state: "disabled", error: null };
	}
	if (normalized.includes("pending") || normalized.includes("checking")) {
		return { state: "connecting", error: null };
	}
	return { state: "error", error: text.replace(/^[^\p{L}\p{N}]+/u, "") };
};

/** Parse the stable line-oriented output of `claude mcp list`. */
export const parseClaudeMcpList = (
	stdout: string,
	checkedAt: number,
): ReadonlyArray<ClaudeLiveMcpEntry> => {
	const entries: ClaudeLiveMcpEntry[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		const nameEnd = line.indexOf(": ");
		const statusStart = line.lastIndexOf(" - ");
		if (nameEnd <= 0 || statusStart <= nameEnd + 2) continue;
		const name = line.slice(0, nameEnd).trim();
		const endpoint = line.slice(nameEnd + 2, statusStart).trim();
		const statusText = line.slice(statusStart + 3).trim();
		if (name.length === 0 || statusText.length === 0) continue;
		const { state, error } = statusFromText(statusText);
		const urlMatch = endpoint.match(/^https?:\/\/[^\s]+/);
		entries.push({
			name,
			source: sourceForName(name),
			transport:
				urlMatch !== null
					? endpoint.includes("(SSE)")
						? "sse"
						: "http"
					: "stdio",
			command: urlMatch === null ? endpoint : null,
			url: urlMatch?.[0] ?? null,
			state,
			error,
			checkedAt,
		});
	}
	return entries;
};

const managedEntry = (
	name: string,
	needsAuth: boolean,
): ClaudeLiveMcpEntry => ({
	name,
	source: sourceForName(name),
	transport: null,
	command: null,
	url: null,
	state: needsAuth ? "needs-auth" : "connecting",
	error: null,
	checkedAt: 0,
});

/**
 * Read only installed plugins and currently auth-required hosted apps. This
 * makes known managed entries visible immediately without exposing the
 * provider's marketplace or reviving stale previously-connected apps.
 */
export const readClaudeManagedMcpEntries =
	(): ReadonlyArray<ClaudeLiveMcpEntry> => {
		const claudeDir = Path.join(homedir(), ".claude");
		const authCache = readJson(
			Path.join(claudeDir, "mcp-needs-auth-cache.json"),
		);
		const authNames = new Set(
			isRecord(authCache)
				? Object.keys(authCache).filter(
						(name) =>
							name.startsWith("plugin:") || name.startsWith("claude.ai "),
					)
				: [],
		);
		const names = new Set<string>();
		const installed = readJson(
			Path.join(claudeDir, "plugins", "installed_plugins.json"),
		);
		if (isRecord(installed) && isRecord(installed.plugins)) {
			for (const [pluginId, installations] of Object.entries(
				installed.plugins,
			)) {
				if (!Array.isArray(installations)) continue;
				const pluginName = pluginId.split("@")[0];
				for (const installation of installations) {
					if (
						!isRecord(installation) ||
						typeof installation.installPath !== "string"
					) {
						continue;
					}
					const manifest = readJson(
						Path.join(installation.installPath, ".mcp.json"),
					);
					if (!isRecord(manifest) || !isRecord(manifest.mcpServers)) continue;
					for (const serverName of Object.keys(manifest.mcpServers)) {
						names.add(`plugin:${pluginName}:${serverName}`);
					}
				}
			}
		}
		for (const name of authNames) names.add(name);
		return [...names]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => managedEntry(name, authNames.has(name)));
	};

export interface ClaudeManagedInventory {
	readonly descriptors: ReadonlyArray<McpServerDescriptor>;
	readonly statuses: ReadonlyArray<McpServerStatus>;
}

export const reconcileClaudeManagedInventory = (options: {
	readonly configured: ReadonlyArray<McpServerDescriptor>;
	readonly entries: ReadonlyArray<ClaudeLiveMcpEntry>;
}): ClaudeManagedInventory => {
	const configuredByName = new Map(
		options.configured.map((descriptor) => [descriptor.name, descriptor]),
	);
	const descriptors: McpServerDescriptor[] = [];
	const statuses: McpServerStatus[] = [];
	for (const entry of options.entries) {
		const configured = configuredByName.get(entry.name);
		const descriptor: McpServerDescriptor = configured ?? {
			key: `claude-live:${entry.name}`,
			name: entry.name,
			source: entry.source,
			kind: "provider",
			parentKey: null,
			availableProviders: ["claude"],
			transport: entry.transport,
			command: null,
			args: [],
			url: entry.url,
			envVarNames: [],
			enabledInConfig: true,
			disabledByZuse: false,
			toggleSupported: false,
			authenticationAction: "native-oauth",
			manageUrl: null,
		};
		if (configured === undefined) descriptors.push(descriptor);
		statuses.push({
			key: descriptor.key,
			name: descriptor.name,
			source: descriptor.source,
			state: entry.state,
			toolCount: null,
			toolNames: [],
			error: entry.error,
			authMethod: entry.state === "needs-auth" ? "oauth" : null,
			requirements:
				entry.state === "needs-auth"
					? [
							{
								kind: "auth",
								detail: "sign-in required in Claude",
								satisfied: false,
							},
						]
					: [],
			checkedAt: entry.checkedAt,
		});
	}
	return { descriptors, statuses };
};

export const readClaudeLiveMcpSnapshot = (
	claudePath: string | null,
	cwd: string | null,
): Effect.Effect<ReadonlyArray<ClaudeLiveMcpEntry>, Error> =>
	Effect.tryPromise({
		try: (signal) =>
			new Promise<string>((resolve, reject) => {
				execFile(
					claudePath ?? "claude",
					["mcp", "list"],
					{
						cwd: cwd ?? undefined,
						env: scrubInheritedClaudeMarkers(process.env),
						signal,
						timeout: 30_000,
						maxBuffer: 2 * 1024 * 1024,
					},
					(error, stdout) => {
						if (error !== null) reject(error);
						else resolve(stdout);
					},
				);
			}),
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	}).pipe(Effect.map((stdout) => parseClaudeMcpList(stdout, Date.now())));

export interface ClaudeMcpLoginOutcome {
	readonly success: boolean;
	readonly error: string | null;
}

export interface ClaudeMcpLoginOptions {
	readonly onAuthorizationUrl?: (url: string) => void;
}

const ANSI_ESCAPE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
	"g",
);
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

const authorizationUrls = (text: string): ReadonlyArray<string> =>
	(text.replace(ANSI_ESCAPE, "").match(URL_PATTERN) ?? []).map((url) =>
		url.replace(/[),.;]+$/u, ""),
	);

const redactUrls = (text: string): string =>
	text.replace(URL_PATTERN, (raw) => {
		try {
			const url = new URL(raw.replace(/[),.;]+$/u, ""));
			return `${url.origin}${url.pathname}${url.search.length > 0 ? "?[redacted]" : ""}`;
		} catch {
			return "[url redacted]";
		}
	});

const ptyEnvironment = (): Record<string, string> =>
	Object.fromEntries(
		Object.entries(scrubInheritedClaudeMarkers(process.env)).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);

/**
 * Authenticate a provider-managed server through Claude's native credential
 * store. The CLI launches the system browser and waits for its OAuth callback.
 */
export const claudeMcpLogin = (
	claudePath: string | null,
	cwd: string | null,
	serverName: string,
	options: ClaudeMcpLoginOptions = {},
): Effect.Effect<ClaudeMcpLoginOutcome, Error> =>
	Effect.tryPromise({
		try: (signal) =>
			new Promise<ClaudeMcpLoginOutcome>((resolve) => {
				let settled = false;
				let output = "";
				let authorizationUrlSent = false;
				let timeout: ReturnType<typeof setTimeout> | null = null;
				let child: pty.IPty | null = null;
				const abort = (): void => {
					try {
						child?.kill();
					} catch {
						// The process may have exited between the signal and cleanup.
					}
				};
				const finish = (outcome: ClaudeMcpLoginOutcome): void => {
					if (settled) return;
					settled = true;
					if (timeout !== null) clearTimeout(timeout);
					signal.removeEventListener("abort", abort);
					resolve(outcome);
				};
				const receive = (text: string): void => {
					output += text;
					if (authorizationUrlSent) return;
					const url = authorizationUrls(text)[0];
					if (url !== undefined) {
						authorizationUrlSent = true;
						options.onAuthorizationUrl?.(url);
					}
				};
				child = pty.spawn(
					claudePath ?? "claude",
					["mcp", "login", serverName],
					{
						name: "xterm-256color",
						cols: 100,
						rows: 24,
						cwd: cwd ?? process.cwd(),
						env: { ...ptyEnvironment(), TERM: "xterm-256color" },
					},
				);
				child.onData(receive);
				child.onExit(({ exitCode }) => {
					finish({
						success: exitCode === 0,
						error:
							exitCode === 0
								? null
								: redactUrls(output.replace(ANSI_ESCAPE, "")).trim() ||
									`native login exited with code ${exitCode}`,
					});
				});
				signal.addEventListener("abort", abort, { once: true });
				timeout = setTimeout(() => {
					abort();
					finish({ success: false, error: "sign-in timed out" });
				}, 5 * 60_000);
			}),
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});
