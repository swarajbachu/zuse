import * as fsSync from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";

import type { McpServerSource, McpTransport } from "@zuse/contracts";
import { parse as parseToml } from "smol-toml";

/**
 * One MCP server as read from a native config file, before Zuse's
 * enable/disable overrides or secret resolution are applied. Env/header
 * values stay server-side; `envVarNames` feeds the requirements UI.
 *
 * Zuse keeps no MCP registry of its own — these files are the source of
 * truth (see ADR 0032):
 *   - `~/.claude.json`               → `mcpServers` (user scope) and
 *                                      `projects[<cwd>].mcpServers` (local scope)
 *   - `<cwd>/.mcp.json`              → project scope
 *   - `~/.codex/config.toml`         → `[mcp_servers.<name>]`
 */
export interface NativeMcpServer {
	readonly name: string;
	readonly source: McpServerSource;
	readonly transport: McpTransport;
	readonly command: string | null;
	readonly args: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string>>;
	readonly url: string | null;
	readonly headers: Readonly<Record<string, string>>;
	/** Codex `enabled = false` (claude configs have no such flag → true). */
	readonly enabledInConfig: boolean;
	/** `${VAR}` references found anywhere in the entry (requirements UI). */
	readonly envVarNames: ReadonlyArray<string>;
	/** Codex `bearer_token_env_var` — resolved from the env at spawn time. */
	readonly bearerTokenEnvVar: string | null;
	/** Codex `startup_timeout_sec`, when present. */
	readonly startupTimeoutMs: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> => {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
};

const stringArray = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const collectEnvRefs = (entry: {
	command: string | null;
	args: ReadonlyArray<string>;
	env: Readonly<Record<string, string>>;
	url: string | null;
	headers: Readonly<Record<string, string>>;
}): string[] => {
	const refs = new Set<string>();
	const scan = (text: string | null): void => {
		if (text === null) return;
		for (const match of text.matchAll(ENV_REF)) {
			const name = match[1];
			if (name !== undefined) refs.add(name);
		}
	};
	scan(entry.command);
	for (const arg of entry.args) scan(arg);
	for (const value of Object.values(entry.env)) scan(value);
	scan(entry.url);
	for (const value of Object.values(entry.headers)) scan(value);
	return [...refs];
};

/**
 * `${VAR}` expansion, matching Claude Code's config semantics: values come
 * from the entry's own `env` block first, then the process environment.
 * Unresolvable references are left verbatim (and reported as an unmet
 * requirement by the status layer).
 */
export const expandEnvRefs = (
	text: string,
	localEnv: Readonly<Record<string, string>>,
): string =>
	text.replace(
		ENV_REF,
		(whole, name: string) => localEnv[name] ?? process.env[name] ?? whole,
	);

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const claudeEntry = (
	name: string,
	raw: unknown,
	source: McpServerSource,
): NativeMcpServer | null => {
	if (!isRecord(raw) || !VALID_NAME.test(name)) return null;
	const type = typeof raw.type === "string" ? raw.type : null;
	const url = typeof raw.url === "string" ? raw.url : null;
	const command = typeof raw.command === "string" ? raw.command : null;
	// Claude Code treats a missing `type` as stdio when `command` is present
	// and http when only `url` is.
	const transport: McpTransport | null =
		type === "http" || type === "sse"
			? type
			: type === "stdio" || (type === null && command !== null)
				? "stdio"
				: type === null && url !== null
					? "http"
					: null;
	if (transport === null) return null;
	if (transport === "stdio" && command === null) return null;
	if (transport !== "stdio" && url === null) return null;
	const base = {
		command: transport === "stdio" ? command : null,
		args: transport === "stdio" ? stringArray(raw.args) : [],
		env: stringRecord(raw.env),
		url: transport === "stdio" ? null : url,
		headers: transport === "stdio" ? {} : stringRecord(raw.headers),
	};
	return {
		name,
		source,
		transport,
		...base,
		enabledInConfig: true,
		envVarNames: collectEnvRefs(base),
		bearerTokenEnvVar: null,
		startupTimeoutMs: null,
	};
};

const entriesFrom = (
	raw: unknown,
	source: McpServerSource,
): NativeMcpServer[] => {
	if (!isRecord(raw)) return [];
	const out: NativeMcpServer[] = [];
	for (const [name, value] of Object.entries(raw)) {
		const entry = claudeEntry(name, value, source);
		if (entry !== null) out.push(entry);
	}
	return out;
};

/**
 * Claude-source servers effective for `cwd`, already collapsed by Claude
 * Code's own precedence: local (`~/.claude.json#projects[cwd]`) > project
 * (`<cwd>/.mcp.json`) > user (`~/.claude.json#mcpServers`). One entry per
 * name; `source` records the winning scope.
 */
export const parseClaudeServers = (
	claudeJson: unknown,
	mcpJson: unknown,
	cwd: string | null,
): NativeMcpServer[] => {
	const byName = new Map<string, NativeMcpServer>();
	const add = (entries: NativeMcpServer[]): void => {
		for (const entry of entries) byName.set(entry.name, entry);
	};
	if (isRecord(claudeJson)) {
		add(entriesFrom(claudeJson.mcpServers, "claude-user"));
	}
	if (isRecord(mcpJson)) {
		add(entriesFrom(mcpJson.mcpServers, "claude-project"));
	}
	if (cwd !== null && isRecord(claudeJson) && isRecord(claudeJson.projects)) {
		const project = (claudeJson.projects as Record<string, unknown>)[cwd];
		if (isRecord(project)) {
			add(entriesFrom(project.mcpServers, "claude-local"));
		}
	}
	return [...byName.values()];
};

/**
 * Codex-source servers from `[mcp_servers.*]`. Zuse's own gateway entries
 * (`zuse`, `zuse-orchestration`) are written into this file by the Codex
 * driver at session start — they are excluded here and rendered as static
 * `builtin` rows instead.
 */
export const parseCodexServers = (
	configToml: string,
	excludeNames: ReadonlyArray<string>,
): NativeMcpServer[] => {
	let parsed: unknown;
	try {
		parsed = parseToml(configToml);
	} catch {
		return [];
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) return [];
	const out: NativeMcpServer[] = [];
	for (const [name, raw] of Object.entries(parsed.mcp_servers)) {
		if (!isRecord(raw) || !VALID_NAME.test(name)) continue;
		if (excludeNames.includes(name)) continue;
		const command = typeof raw.command === "string" ? raw.command : null;
		const url = typeof raw.url === "string" ? raw.url : null;
		const transport: McpTransport | null =
			command !== null ? "stdio" : url !== null ? "http" : null;
		if (transport === null) continue;
		const base = {
			command,
			args: stringArray(raw.args),
			env: stringRecord(raw.env),
			url,
			headers: stringRecord(raw.http_headers),
		};
		const startupTimeoutSec =
			typeof raw.startup_timeout_sec === "number"
				? raw.startup_timeout_sec
				: null;
		out.push({
			name,
			source: "codex",
			transport,
			...base,
			enabledInConfig: raw.enabled !== false,
			envVarNames: collectEnvRefs(base),
			bearerTokenEnvVar:
				typeof raw.bearer_token_env_var === "string"
					? raw.bearer_token_env_var
					: null,
			startupTimeoutMs:
				startupTimeoutSec !== null ? startupTimeoutSec * 1000 : null,
		});
	}
	return out;
};

export const claudeJsonPath = (): string =>
	Path.join(homedir(), ".claude.json");
export const codexConfigPath = (): string =>
	Path.join(homedir(), ".codex", "config.toml");
export const projectMcpJsonPath = (cwd: string): string =>
	Path.join(cwd, ".mcp.json");

const readJsonFile = (filePath: string): unknown => {
	try {
		return JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		return null;
	}
};

const readTextFile = (filePath: string): string => {
	try {
		return fsSync.readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
};

/**
 * Synchronous read of every native source for one working directory. All
 * reads are tolerant: a missing or malformed file contributes no servers
 * rather than failing the inventory.
 */
export const readNativeServers = (options: {
	readonly cwd: string | null;
	readonly excludeCodexNames: ReadonlyArray<string>;
}): NativeMcpServer[] => {
	const claudeJson = readJsonFile(claudeJsonPath());
	const mcpJson =
		options.cwd !== null ? readJsonFile(projectMcpJsonPath(options.cwd)) : null;
	const claude = parseClaudeServers(claudeJson, mcpJson, options.cwd);
	const codex = parseCodexServers(
		readTextFile(codexConfigPath()),
		options.excludeCodexNames,
	);
	return [...claude, ...codex];
};
