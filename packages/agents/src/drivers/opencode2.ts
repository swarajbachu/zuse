import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	type AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type AttachmentRef,
	type FileRef,
	type OpencodeCustomProvider,
	type OpencodeInventory,
	type OpencodeInventoryAgent,
	type OpencodeInventoryProvider,
	type PermissionKind,
	type PermissionMode,
	type StartSessionInput,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";

import { AttachmentService } from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { isSensitivePath } from "../kernel/permission-policy.ts";
import { CheckpointFlushScheduler } from "../kernel/provider-checkpoint-batcher.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import type { RequestPermission } from "./claude.ts";
import {
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";

/**
 * OpenCode 2 driver. Spawns a private `opencode2 serve` and drives the v2
 * HTTP API (`/api/session`, `/api/event`, `/api/model`, …). The binary is
 * `opencode2` and does not replace OpenCode 1's `opencode`.
 *
 * Docs: https://opencode.ai/v2/docs
 *
 * Conversation identity is the OpenCode session id (`ses_…`), surfaced as
 * `SessionCursor { strategy: "opencode2-session-id" }`. Unlike v1 we try
 * to resume that id from the shared OpenCode database.
 */
export interface Opencode2SessionHandle extends ProviderSessionHandle {
	readonly events: Stream.Stream<AgentEvent>;
	readonly send: (
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
		fileRefs?: ReadonlyArray<FileRef>,
	) => Effect.Effect<void>;
	readonly interrupt: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
}

const OPENCODE2_DEBUG = process.env.MEMOIZE_DEBUG_OPENCODE2 === "1";
const PROVIDER_ID = "opencode2" as const;
const SERVER_READY_REGEX = /listening on (https?:\/\/[^\s]+)/i;
const SERVER_PASSWORD_REGEX = /server password\s+(\S+)/i;
const INVENTORY_RPC_TIMEOUT_MS = 25_000;
const SERVE_TIMEOUT_MS = 15_000;
const CATALOG_WAIT_MS = 8_000;

const LOG_PATH = ((): string => {
	try {
		const base = process.env.HOME ? homedir() : tmpdir();
		const dir = join(base, ".cache", "zuse");
		mkdirSync(dir, { recursive: true });
		return join(dir, "opencode2.log");
	} catch {
		return join(tmpdir(), "zuse-opencode2.log");
	}
})();

const writeLog = (line: string): void => {
	process.stderr.write(line);
	try {
		appendFileSync(LOG_PATH, line);
	} catch {
		// best-effort
	}
};

const dlog = (msg: string): void => {
	if (OPENCODE2_DEBUG) writeLog(`[opencode2] ${msg}\n`);
};

if (OPENCODE2_DEBUG) {
	writeLog(`\n[opencode2] ==== driver loaded; logs at ${LOG_PATH} ====\n`);
}

const OPENCODE_TOOL_NAME: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	multiedit: "MultiEdit",
	bash: "Bash",
	glob: "Glob",
	grep: "Grep",
	task: "Task",
	todowrite: "TodoWrite",
	todoread: "TodoRead",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	list: "ListDir",
};

const asStr = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

const asNonEmptyString = asStr;

const canonicalizeToolInput = (
	canonicalTool: string,
	rawInput: unknown,
	title: string | null,
): unknown => {
	const obj =
		rawInput !== null && typeof rawInput === "object"
			? (rawInput as Record<string, unknown>)
			: {};
	switch (canonicalTool) {
		case "Read": {
			const file_path =
				asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
			const out: Record<string, unknown> = {};
			if (file_path !== null) out["file_path"] = file_path;
			if (typeof obj["offset"] === "number") out["offset"] = obj["offset"];
			if (typeof obj["limit"] === "number") out["limit"] = obj["limit"];
			return out;
		}
		case "Edit": {
			const file_path =
				asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
			const out: Record<string, unknown> = {};
			if (file_path !== null) out["file_path"] = file_path;
			const oldS = asStr(obj["oldString"]) ?? asStr(obj["old_string"]);
			const newS = asStr(obj["newString"]) ?? asStr(obj["new_string"]);
			if (oldS !== null) out["old_string"] = oldS;
			if (newS !== null) out["new_string"] = newS;
			return out;
		}
		case "Write": {
			const file_path =
				asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
			const out: Record<string, unknown> = {};
			if (file_path !== null) out["file_path"] = file_path;
			const content = asStr(obj["content"]);
			if (content !== null) out["content"] = content;
			return out;
		}
		case "Bash": {
			const command = asStr(obj["command"]) ?? asStr(obj["cmd"]) ?? title;
			const out: Record<string, unknown> = {};
			if (command !== null) out["command"] = command;
			const description = asStr(obj["description"]);
			if (description !== null && description !== command)
				out["description"] = description;
			return out;
		}
		case "Grep": {
			const out: Record<string, unknown> = {};
			const pattern = asStr(obj["pattern"]) ?? asStr(obj["regex"]);
			if (pattern !== null) out["pattern"] = pattern;
			const path = asStr(obj["path"]) ?? asStr(obj["directory"]);
			if (path !== null) out["path"] = path;
			const glob = asStr(obj["glob"]) ?? asStr(obj["include"]);
			if (glob !== null) out["glob"] = glob;
			return out;
		}
		case "Glob": {
			const out: Record<string, unknown> = {};
			const pattern = asStr(obj["pattern"]) ?? title;
			if (pattern !== null) out["pattern"] = pattern;
			const path = asStr(obj["path"]) ?? asStr(obj["directory"]);
			if (path !== null) out["path"] = path;
			return out;
		}
		case "WebSearch": {
			const query = asStr(obj["query"]) ?? title;
			return query !== null ? { query } : {};
		}
		case "WebFetch": {
			const url = asStr(obj["url"]) ?? title;
			const out: Record<string, unknown> = {};
			if (url !== null) out["url"] = url;
			const prompt = asStr(obj["prompt"]);
			if (prompt !== null) out["prompt"] = prompt;
			return out;
		}
		default:
			return obj;
	}
};

const canonicalToolName = (name: string): string =>
	OPENCODE_TOOL_NAME[name.toLowerCase()] ?? name;

const splitModelSlug = (
	slug: string | undefined,
): { providerID: string | null; modelID: string | null } => {
	if (slug === undefined || slug.length === 0) {
		return { providerID: null, modelID: null };
	}
	const idx = slug.indexOf("/");
	if (idx < 0) return { providerID: null, modelID: slug };
	return {
		providerID: slug.slice(0, idx),
		modelID: slug.slice(idx + 1),
	};
};

const findFreePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate a free port for opencode2 serve"));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});

const stopChild = (child: ChildProcessWithoutNullStreams): void => {
	try {
		if (process.platform !== "win32" && child.pid !== undefined) {
			process.kill(-child.pid, "SIGTERM");
			return;
		}
		child.kill("SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// ignore
		}
	}
};

interface Opencode2ServerProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly url: string;
	readonly password: string;
}

const spawnOpencode2Server = (
	opencode2Path: string,
	cwd: string,
	timeoutMs = SERVE_TIMEOUT_MS,
): Promise<Opencode2ServerProcess> =>
	findFreePort().then(
		(port) =>
			new Promise<Opencode2ServerProcess>((resolve, reject) => {
				const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];
				let child: ChildProcessWithoutNullStreams;
				try {
					child = spawn(opencode2Path, args, {
						cwd,
						env: { ...process.env },
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch (cause) {
					reject(cause);
					return;
				}
				child.stdout.setEncoding("utf-8");
				child.stderr.setEncoding("utf-8");
				let stdoutBuf = "";
				let stderrBuf = "";
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					stopChild(child);
					const stderrTail = stderrBuf.trim().slice(-512);
					reject(
						new Error(
							`Timed out after ${timeoutMs}ms waiting for opencode2 serve to start` +
								(stderrTail.length > 0 ? ` — stderr: ${stderrTail}` : ""),
						),
					);
				}, timeoutMs);
				const trySettle = (): void => {
					if (settled) return;
					const urlMatch = stdoutBuf.match(SERVER_READY_REGEX);
					const passMatch = stdoutBuf.match(SERVER_PASSWORD_REGEX);
					if (urlMatch === null || passMatch === null) return;
					settled = true;
					clearTimeout(timer);
					child.stdout.off("data", onStdout);
					resolve({
						child,
						url: urlMatch[1]!,
						password: passMatch[1]!,
					});
				};
				const onStdout = (chunk: string): void => {
					if (settled) return;
					stdoutBuf = (stdoutBuf + chunk).slice(-8192);
					if (OPENCODE2_DEBUG)
						process.stderr.write(`[opencode2.stdout] ${chunk}`);
					trySettle();
				};
				child.stdout.on("data", onStdout);
				child.stderr.on("data", (chunk: string) => {
					stderrBuf = (stderrBuf + chunk).slice(-4096);
					if (OPENCODE2_DEBUG)
						process.stderr.write(`[opencode2.stderr] ${chunk}`);
				});
				child.on("error", (err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err);
				});
				child.on("exit", (code, signal) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					const stderrTail = stderrBuf.trim().slice(-512);
					reject(
						new Error(
							`opencode2 serve exited before ready (code ${code ?? "null"}, signal ${signal ?? "null"})` +
								(stderrTail.length > 0 ? ` — stderr: ${stderrTail}` : ""),
						),
					);
				});
			}),
	);

interface HttpJsonOptions {
	readonly method?: string;
	readonly body?: unknown;
	readonly timeoutMs?: number;
	readonly accept?: string;
}

const basicAuthHeader = (password: string): string =>
	`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

class Opencode2HttpError extends Error {
	readonly status: number;
	readonly bodyText: string;
	constructor(status: number, bodyText: string, path: string) {
		super(`opencode2 ${path} failed (${status}): ${bodyText.slice(0, 400)}`);
		this.status = status;
		this.bodyText = bodyText;
	}
}

const requestJson = async (
	baseUrl: string,
	password: string,
	path: string,
	options: HttpJsonOptions = {},
): Promise<unknown> => {
	const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	const method = options.method ?? "GET";
	const payload =
		options.body === undefined ? undefined : JSON.stringify(options.body);
	const timeoutMs = options.timeoutMs ?? 20_000;
	return await new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method,
				headers: {
					authorization: basicAuthHeader(password),
					accept: options.accept ?? "application/json",
					...(payload !== undefined
						? {
								"content-type": "application/json",
								"content-length": Buffer.byteLength(payload),
							}
						: {}),
				},
				timeout: timeoutMs === 0 ? undefined : timeoutMs,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => {
					chunks.push(c);
				});
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					const status = res.statusCode ?? 0;
					if (status === 204 || text.length === 0) {
						if (status >= 200 && status < 300) {
							resolve(undefined);
							return;
						}
						reject(new Opencode2HttpError(status, text, path));
						return;
					}
					if (status < 200 || status >= 300) {
						reject(new Opencode2HttpError(status, text, path));
						return;
					}
					try {
						resolve(JSON.parse(text) as unknown);
					} catch (cause) {
						reject(cause);
					}
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error(`opencode2 ${path} timed out after ${timeoutMs}ms`));
		});
		if (payload !== undefined) req.write(payload);
		req.end();
	});
};

type SseHandler = (event: Record<string, unknown>) => void;

const subscribeSse = (
	baseUrl: string,
	password: string,
	path: string,
	onEvent: SseHandler,
	onError: (message: string) => void,
	signal: AbortSignal,
): void => {
	const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	const req = http.request(
		url,
		{
			method: "GET",
			headers: {
				authorization: basicAuthHeader(password),
				accept: "text/event-stream",
			},
		},
		(res) => {
			const status = res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				onError(`OpenCode 2 event stream failed (${status})`);
				res.resume();
				return;
			}
			res.setEncoding("utf8");
			let buf = "";
			res.on("data", (chunk: string) => {
				buf += chunk;
				for (;;) {
					const idx = buf.indexOf("\n\n");
					if (idx < 0) break;
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data:")) continue;
						const raw = line.slice(5).trim();
						if (raw.length === 0) continue;
						try {
							const parsed = JSON.parse(raw) as unknown;
							if (parsed !== null && typeof parsed === "object") {
								onEvent(parsed as Record<string, unknown>);
							}
						} catch {
							// ignore malformed frames
						}
					}
				}
			});
			res.on("error", (err) => {
				if (signal.aborted) return;
				onError(
					`OpenCode 2 event stream error: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
			res.on("end", () => {
				if (signal.aborted) return;
				onError("OpenCode 2 event stream ended unexpectedly.");
			});
		},
	);
	const abort = (): void => {
		req.destroy();
	};
	if (signal.aborted) {
		abort();
		return;
	}
	signal.addEventListener("abort", abort, { once: true });
	req.on("error", (err) => {
		if (signal.aborted) return;
		onError(
			`OpenCode 2 event stream error: ${err instanceof Error ? err.message : String(err)}`,
		);
	});
	req.end();
};

const unwrapData = (value: unknown): unknown => {
	if (value !== null && typeof value === "object" && "data" in value) {
		return (value as { data: unknown }).data;
	}
	return value;
};

const raceTimeout = <T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const waitForCatalog = async (
	baseUrl: string,
	password: string,
	directory: string,
): Promise<void> => {
	try {
		await requestJson(baseUrl, password, "/api/plugin/await-activation", {
			method: "POST",
			body: {},
			timeoutMs: 15_000,
		});
	} catch {
		// activation wait is best-effort
	}
	const deadline = Date.now() + CATALOG_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const raw = await requestJson(
				baseUrl,
				password,
				`/api/provider?directory=${encodeURIComponent(directory)}`,
			);
			const data = unwrapData(raw);
			if (Array.isArray(data) && data.length > 0) return;
		} catch {
			// retry
		}
		await sleep(250);
	}
};

const v2PackageFor = (npm: string): string => {
	if (npm.length === 0 || npm === "@ai-sdk/openai-compatible") {
		return "@opencode/ai/providers/openai-compatible";
	}
	if (npm === "@openrouter/ai-sdk-provider") {
		return "@opencode/ai/providers/openrouter";
	}
	if (npm === "@ai-sdk/anthropic") {
		return "@opencode/ai/providers/anthropic";
	}
	if (npm === "@ai-sdk/google") {
		return "@opencode/ai/providers/google";
	}
	if (npm === "@ai-sdk/openai") {
		return "@opencode/ai/providers/openai";
	}
	return npm;
};

const globalOpencodeConfigPath = (): string => {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	return join(base, "opencode", "opencode.json");
};

const mergeCustomProviderIntoConfig = async (
	provider: OpencodeCustomProvider,
): Promise<void> => {
	const path = globalOpencodeConfigPath();
	let json: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};
	try {
		const raw = await readFile(path, "utf8");
		try {
			json = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			throw new Error(
				`OpenCode config at ${path} is not valid JSON. JSONC files are not rewritten.`,
			);
		}
	} catch (cause) {
		const code =
			cause !== null &&
			typeof cause === "object" &&
			"code" in cause &&
			typeof (cause as { code?: unknown }).code === "string"
				? (cause as { code: string }).code
				: null;
		if (code !== "ENOENT") throw cause;
	}
	const providers =
		json["providers"] !== null && typeof json["providers"] === "object"
			? { ...(json["providers"] as Record<string, unknown>) }
			: {};
	const models: Record<string, { name: string }> = {};
	for (const m of provider.models) models[m.id] = { name: m.name };
	providers[provider.id] = {
		name: provider.name,
		package: v2PackageFor(provider.npm),
		settings: { baseURL: provider.baseURL },
		models,
	};
	json["providers"] = providers;
	await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
};

const removeCustomProviderFromConfig = async (id: string): Promise<void> => {
	const path = globalOpencodeConfigPath();
	try {
		const raw = await readFile(path, "utf8");
		const json = JSON.parse(raw) as Record<string, unknown>;
		const providers =
			json["providers"] !== null && typeof json["providers"] === "object"
				? { ...(json["providers"] as Record<string, unknown>) }
				: {};
		if (!(id in providers)) return;
		delete providers[id];
		json["providers"] = providers;
		await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
	} catch {
		// missing / jsonc
	}
};

interface InventoryIntegration {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly methods?: ReadonlyArray<{
		readonly type?: unknown;
		readonly names?: ReadonlyArray<unknown>;
	}> | null;
	readonly connections?: ReadonlyArray<unknown> | null;
}

interface InventoryProviderRow {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly activation?: unknown;
}

interface InventoryModelRow {
	readonly id?: unknown;
	readonly modelID?: unknown;
	readonly providerID?: unknown;
	readonly name?: unknown;
	readonly status?: unknown;
	readonly enabled?: unknown;
	readonly capabilities?: { readonly tools?: unknown } | null;
	readonly variants?: ReadonlyArray<{ readonly id?: unknown }> | null;
}

interface InventoryAgentRow {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly mode?: unknown;
	readonly hidden?: unknown;
	readonly description?: unknown;
}

export const isUsableOpencode2Model = (m: InventoryModelRow): boolean => {
	const id = asNonEmptyString(m.id);
	if (id === null) return false;
	if (m.enabled === false) return false;
	if (m.status !== undefined && m.status !== "active") return false;
	if (m.capabilities?.tools === false) return false;
	return true;
};

export const filterOpencode2PrimaryAgents = (
	agents: ReadonlyArray<InventoryAgentRow>,
): ReadonlyArray<OpencodeInventoryAgent> =>
	agents.flatMap((a) => {
		if (a.mode !== "primary" && a.mode !== "all") return [];
		if (a.hidden === true) return [];
		const name = asNonEmptyString(a.id) ?? asNonEmptyString(a.name);
		if (name === null) return [];
		const description = asNonEmptyString(a.description);
		return [
			{
				name,
				mode: a.mode,
				...(description !== null ? { description } : {}),
			},
		];
	});

export const collectOpencode2Inventory = (
	integrations: ReadonlyArray<InventoryIntegration>,
	providers: ReadonlyArray<InventoryProviderRow>,
	models: ReadonlyArray<InventoryModelRow>,
	agents: ReadonlyArray<InventoryAgentRow>,
	customIds: ReadonlySet<string>,
): OpencodeInventory => {
	const providerName = new Map<string, string>();
	const connectedIds = new Set<string>();
	const envById = new Map<string, string>();
	for (const p of providers) {
		const id = asNonEmptyString(p.id);
		if (id === null) continue;
		providerName.set(id, asNonEmptyString(p.name) ?? id);
		if (p.activation === "enabled" || p.activation === "auto") {
			connectedIds.add(id);
		}
	}
	for (const integ of integrations) {
		const id = asNonEmptyString(integ.id);
		if (id === null) continue;
		if (!providerName.has(id)) {
			providerName.set(id, asNonEmptyString(integ.name) ?? id);
		} else if (
			asNonEmptyString(integ.name) !== null &&
			providerName.get(id) === id
		) {
			providerName.set(id, asNonEmptyString(integ.name)!);
		}
		if (Array.isArray(integ.connections) && integ.connections.length > 0) {
			connectedIds.add(id);
		}
		const envMethod = (integ.methods ?? []).find(
			(m) => m?.type === "env" && Array.isArray(m.names) && m.names.length > 0,
		);
		const env0 = envMethod?.names?.[0];
		if (typeof env0 === "string" && env0.length > 0) envById.set(id, env0);
	}
	const modelsByProvider = new Map<
		string,
		OpencodeInventoryProvider["models"][number][]
	>();
	for (const m of models) {
		if (!isUsableOpencode2Model(m)) continue;
		const providerID = asNonEmptyString(m.providerID);
		const modelId = asNonEmptyString(m.id);
		if (providerID === null || modelId === null) continue;
		if (!connectedIds.has(providerID)) continue;
		const variants = (m.variants ?? [])
			.map((v) => asNonEmptyString(v.id))
			.filter((id): id is string => id !== null);
		const list = modelsByProvider.get(providerID) ?? [];
		list.push({
			id: `${providerID}/${modelId}`,
			label: asNonEmptyString(m.name) ?? modelId,
			variants,
		});
		modelsByProvider.set(providerID, list);
	}
	const out: OpencodeInventoryProvider[] = [];
	for (const [id, name] of providerName) {
		const modelsFor = (modelsByProvider.get(id) ?? []).sort((a, b) =>
			a.label.localeCompare(b.label),
		);
		out.push({
			id,
			name,
			connected: connectedIds.has(id),
			custom: customIds.has(id),
			apiKeyEnv: envById.get(id) ?? "",
			apiKeyUrl: "",
			models: connectedIds.has(id) ? modelsFor : [],
		});
	}
	out.sort((a, b) => {
		if (a.connected !== b.connected) return a.connected ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return {
		providers: out,
		agents: filterOpencode2PrimaryAgents(agents),
	};
};

const asArray = <T>(value: unknown): ReadonlyArray<T> =>
	Array.isArray(value) ? (value as ReadonlyArray<T>) : [];

export const loadOpencode2Inventory = (
	opencode2Path: string,
	cwd: string,
	customProviders: ReadonlyArray<OpencodeCustomProvider> = [],
): Effect.Effect<OpencodeInventory, AgentSessionStartError> =>
	Effect.tryPromise({
		try: async () => {
			dlog("inventory: spawning opencode2 server");
			const proc = await spawnOpencode2Server(opencode2Path, cwd);
			try {
				await waitForCatalog(proc.url, proc.password, cwd);
				const dirQ = `directory=${encodeURIComponent(cwd)}`;
				const [providersRaw, modelsRaw, agentsRaw, integRaw] =
					await raceTimeout(
						Promise.all([
							requestJson(proc.url, proc.password, `/api/provider?${dirQ}`),
							requestJson(proc.url, proc.password, `/api/model?${dirQ}`),
							requestJson(proc.url, proc.password, `/api/agent?${dirQ}`),
							requestJson(proc.url, proc.password, `/api/integration?${dirQ}`),
						]),
						INVENTORY_RPC_TIMEOUT_MS,
						`Timed out after ${INVENTORY_RPC_TIMEOUT_MS}ms waiting for opencode2 inventory`,
					);
				const inventory = collectOpencode2Inventory(
					asArray<InventoryIntegration>(unwrapData(integRaw)),
					asArray<InventoryProviderRow>(unwrapData(providersRaw)),
					asArray<InventoryModelRow>(unwrapData(modelsRaw)),
					asArray<InventoryAgentRow>(unwrapData(agentsRaw)),
					new Set(customProviders.map((p) => p.id)),
				);
				dlog(
					`inventory: ${inventory.providers.length} providers, ${inventory.agents.length} agents`,
				);
				return inventory;
			} finally {
				stopChild(proc.child);
			}
		},
		catch: (cause) =>
			new AgentSessionStartError({
				providerId: PROVIDER_ID,
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	});

const withOpencode2Server = <A>(
	opencode2Path: string,
	cwd: string,
	fn: (client: {
		readonly url: string;
		readonly password: string;
	}) => Promise<A>,
): Effect.Effect<A, AgentSessionStartError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = await spawnOpencode2Server(opencode2Path, cwd);
			try {
				await waitForCatalog(proc.url, proc.password, cwd);
				return await fn({ url: proc.url, password: proc.password });
			} finally {
				stopChild(proc.child);
			}
		},
		catch: (cause) =>
			new AgentSessionStartError({
				providerId: PROVIDER_ID,
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	});

export const setOpencode2ProviderAuth = (
	opencode2Path: string,
	cwd: string,
	providerId: string,
	apiKey: string,
): Effect.Effect<void, AgentSessionStartError> =>
	withOpencode2Server(opencode2Path, cwd, async (client) => {
		await requestJson(
			client.url,
			client.password,
			`/api/integration/${encodeURIComponent(providerId)}/connect/key`,
			{
				method: "POST",
				body: { key: apiKey },
				timeoutMs: 20_000,
			},
		);
	});

export const removeOpencode2ProviderAuth = (
	opencode2Path: string,
	cwd: string,
	providerId: string,
): Effect.Effect<void, AgentSessionStartError> =>
	withOpencode2Server(opencode2Path, cwd, async (client) => {
		const raw = await requestJson(
			client.url,
			client.password,
			`/api/integration/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(cwd)}`,
		);
		const info = unwrapData(raw) as InventoryIntegration | undefined;
		const connections = info?.connections ?? [];
		for (const conn of connections) {
			if (conn === null || typeof conn !== "object") continue;
			const rec = conn as { type?: unknown; id?: unknown };
			if (rec.type !== "credential") continue;
			const id = asNonEmptyString(rec.id);
			if (id === null) continue;
			await requestJson(
				client.url,
				client.password,
				`/api/credential/${encodeURIComponent(id)}`,
				{ method: "DELETE" },
			);
		}
	});

export const addOpencode2CustomProvider = (
	opencode2Path: string,
	cwd: string,
	provider: OpencodeCustomProvider,
	apiKey: string,
): Effect.Effect<void, AgentSessionStartError> =>
	Effect.gen(function* () {
		yield* Effect.tryPromise({
			try: () => mergeCustomProviderIntoConfig(provider),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: PROVIDER_ID,
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		yield* setOpencode2ProviderAuth(opencode2Path, cwd, provider.id, apiKey);
	});

export const removeOpencode2CustomProvider = (
	opencode2Path: string,
	cwd: string,
	id: string,
): Effect.Effect<void, AgentSessionStartError> =>
	Effect.gen(function* () {
		yield* removeOpencode2ProviderAuth(opencode2Path, cwd, id);
		yield* Effect.tryPromise({
			try: () => removeCustomProviderFromConfig(id),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: PROVIDER_ID,
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
	});

interface DeltaState {
	textByPartId: Map<string, string>;
	reasoningByPartId: Map<string, string>;
	revisionByPartId: Map<string, number>;
	flushedPartIds: Set<string>;
	turnCompleted: boolean;
}

const makeDeltaState = (): DeltaState => ({
	textByPartId: new Map(),
	reasoningByPartId: new Map(),
	revisionByPartId: new Map(),
	flushedPartIds: new Set(),
	turnCompleted: false,
});

const checkpointDeltaState = (
	state: DeltaState,
	final: boolean,
): AgentEvent[] => {
	const out: AgentEvent[] = [];
	for (const [partId, text] of state.textByPartId) {
		if (text.length === 0) continue;
		const revision = (state.revisionByPartId.get(partId) ?? 0) + 1;
		state.revisionByPartId.set(partId, revision);
		out.push({
			_tag: "AssistantMessage",
			itemId: partId as AgentItemId,
			text,
			checkpoint: { revision, final },
		});
		if (final) state.flushedPartIds.add(partId);
	}
	for (const [partId, text] of state.reasoningByPartId) {
		if (text.length === 0) continue;
		const revision = (state.revisionByPartId.get(partId) ?? 0) + 1;
		state.revisionByPartId.set(partId, revision);
		out.push({
			_tag: "Thinking",
			itemId: partId as AgentItemId,
			text,
			redacted: false,
			checkpoint: { revision, final },
		});
		if (final) state.flushedPartIds.add(partId);
	}
	if (final) {
		state.textByPartId.clear();
		state.reasoningByPartId.clear();
	}
	return out;
};

const eventSessionId = (event: Record<string, unknown>): string | null => {
	const data = event["data"];
	if (data !== null && typeof data === "object") {
		const sid = (data as { sessionID?: unknown }).sessionID;
		if (typeof sid === "string") return sid;
	}
	return null;
};

const eventData = (event: Record<string, unknown>): Record<string, unknown> => {
	const data = event["data"];
	return data !== null && typeof data === "object"
		? (data as Record<string, unknown>)
		: {};
};

const toolContentText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "");
	return content
		.map((part) => {
			if (part !== null && typeof part === "object" && "text" in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			}
			return "";
		})
		.join("");
};

const firstString = (value: unknown): string | null => {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstString(item);
			if (found !== null) return found;
		}
	}
	return null;
};

const permissionPayload = (
	data: Record<string, unknown>,
): Record<string, unknown> => {
	const nested = data["request"];
	return nested !== null && typeof nested === "object"
		? (nested as Record<string, unknown>)
		: data;
};

export const extractOpencode2Permission = (
	data: Record<string, unknown>,
): { action: string; resource: string; sensitive: boolean } => {
	const payload = permissionPayload(data);
	const action =
		asStr(payload["action"]) ??
		asStr(payload["permission"]) ??
		asStr(payload["type"]) ??
		"permission";
	const resourceList = [
		payload["resources"],
		payload["patterns"],
		payload["resource"],
	];
	const resources = resourceList.flatMap((value) => {
		if (typeof value === "string" && value.length > 0) return [value];
		if (!Array.isArray(value)) return [];
		return value.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	});
	const resource = resources[0] ?? firstString(payload["metadata"]) ?? "";
	return {
		action,
		resource,
		sensitive: resources.some((item) => isSensitivePath(item)),
	};
};

const classifyOpencode2Permission = (
	action: string,
	resource: string,
): PermissionKind => {
	const kind = action.toLowerCase();
	if (
		kind === "edit" ||
		kind === "write" ||
		kind === "multiedit" ||
		kind === "create"
	) {
		return { _tag: "FileWrite", path: resource };
	}
	if (kind === "bash" || kind === "shell" || kind === "command") {
		return { _tag: "Bash", command: resource };
	}
	if (
		kind === "webfetch" ||
		kind === "websearch" ||
		kind === "network" ||
		kind === "http"
	) {
		return { _tag: "Network", url: resource };
	}
	return { _tag: "Other", tool: action, summary: resource };
};

const permissionReplyFor = (
	tag: "AllowOnce" | "AllowForSession" | "AlwaysAllow" | "Deny",
): "once" | "always" | "reject" => {
	if (tag === "Deny") return "reject";
	if (tag === "AllowForSession" || tag === "AlwaysAllow") return "always";
	return "once";
};

export const startOpencode2Session = (
	input: StartSessionInput,
	cwd: string,
	_customProviders: ReadonlyArray<OpencodeCustomProvider>,
	opencode2Path: string,
	sessionId: AgentSessionId,
	resumeCursor: string | null = null,
	requestPermission: RequestPermission | null = null,
): Effect.Effect<
	Opencode2SessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();
		let currentMode: PermissionMode = input.permissionMode ?? "default";
		let closed = false;
		const deltaState = makeDeltaState();
		const seenToolUse = new Set<string>();
		const toolNameById = new Map<string, string>();
		let turnGate: {
			resolve: () => void;
			promise: Promise<void>;
		} | null = null;
		const armTurnGate = (): Promise<void> => {
			let resolve = (): void => undefined;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			turnGate = { resolve, promise };
			return promise;
		};
		const releaseTurnGate = (): void => {
			turnGate?.resolve();
			turnGate = null;
		};
		const emit = (event: AgentEvent): void => {
			if (!closed) Queue.offerUnsafe(events, event);
		};
		const checkpointScheduler = new CheckpointFlushScheduler({
			onFlush: () => {
				for (const event of checkpointDeltaState(deltaState, false))
					emit(event);
			},
		});

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: PROVIDER_ID,
			mode: "sdk",
		});

		const booted = yield* Effect.tryPromise({
			try: async () => {
				const server = await spawnOpencode2Server(opencode2Path, cwd);
				const eventAbort = new AbortController();
				try {
					let opencodeSessionId: string | null = null;
					const pendingReplies = new Set<string>();

					const handleEvent = (event: Record<string, unknown>): void => {
						if (closed) return;
						const type = asStr(event["type"]);
						if (type === null) return;
						if (type === "server.connected") return;
						const sid = eventSessionId(event);
						if (
							opencodeSessionId !== null &&
							sid !== null &&
							sid !== opencodeSessionId
						) {
							return;
						}
						const data = eventData(event);
						switch (type) {
							case "session.execution.started":
								deltaState.turnCompleted = false;
								emit({ _tag: "Status", status: "running" });
								return;
							case "session.text.delta": {
								const ordinal = data["ordinal"];
								const msgId = asStr(data["assistantMessageID"]) ?? "text";
								const partId = `${msgId}:text:${String(ordinal ?? 0)}`;
								const delta = asStr(data["delta"]) ?? "";
								if (delta.length === 0) return;
								deltaState.textByPartId.set(
									partId,
									(deltaState.textByPartId.get(partId) ?? "") + delta,
								);
								checkpointScheduler.update(
									[...deltaState.textByPartId.values()].reduce(
										(n, t) => n + t.length,
										0,
									),
								);
								return;
							}
							case "session.text.ended": {
								const ordinal = data["ordinal"];
								const msgId = asStr(data["assistantMessageID"]) ?? "text";
								const partId = `${msgId}:text:${String(ordinal ?? 0)}`;
								const text = asStr(data["text"]);
								if (text !== null) deltaState.textByPartId.set(partId, text);
								return;
							}
							case "session.reasoning.delta": {
								const ordinal = data["ordinal"];
								const msgId = asStr(data["assistantMessageID"]) ?? "think";
								const partId = `${msgId}:reasoning:${String(ordinal ?? 0)}`;
								const delta = asStr(data["delta"]) ?? "";
								if (delta.length === 0) return;
								deltaState.reasoningByPartId.set(
									partId,
									(deltaState.reasoningByPartId.get(partId) ?? "") + delta,
								);
								checkpointScheduler.update(
									[...deltaState.reasoningByPartId.values()].reduce(
										(n, t) => n + t.length,
										0,
									),
								);
								return;
							}
							case "session.reasoning.ended": {
								const ordinal = data["ordinal"];
								const msgId = asStr(data["assistantMessageID"]) ?? "think";
								const partId = `${msgId}:reasoning:${String(ordinal ?? 0)}`;
								const text = asStr(data["text"]);
								if (text !== null)
									deltaState.reasoningByPartId.set(partId, text);
								return;
							}
							case "session.tool.input.started": {
								const id = asStr(data["id"]);
								const name = asStr(data["name"]) ?? "tool";
								if (id !== null) toolNameById.set(id, name);
								return;
							}
							case "session.tool.called": {
								const id = asStr(data["id"]);
								if (id === null || seenToolUse.has(id)) return;
								seenToolUse.add(id);
								const name =
									asStr(data["name"]) ?? toolNameById.get(id) ?? "tool";
								const tool = canonicalToolName(name);
								emit({
									_tag: "ToolUse",
									itemId: id as AgentItemId,
									tool,
									input: canonicalizeToolInput(tool, data["input"], null),
								});
								return;
							}
							case "session.tool.success": {
								const id = asStr(data["id"]);
								if (id === null) return;
								emit({
									_tag: "ToolResult",
									itemId: id as AgentItemId,
									output: toolContentText(data["content"]),
									isError: false,
								});
								return;
							}
							case "session.tool.error":
							case "session.tool.failed": {
								const id = asStr(data["id"]);
								if (id === null) return;
								const err = data["error"];
								const message =
									err !== null && typeof err === "object" && "message" in err
										? String((err as { message?: unknown }).message ?? "error")
										: toolContentText(data["content"]) || "Tool failed";
								emit({
									_tag: "ToolResult",
									itemId: id as AgentItemId,
									output: message,
									isError: true,
								});
								return;
							}
							case "session.step.ended": {
								const tokens = data["tokens"] as
									| {
											input?: number;
											output?: number;
											reasoning?: number;
											cache?: { read?: number; write?: number };
									  }
									| undefined;
								const model = data["model"] as
									| { id?: string; providerID?: string }
									| undefined;
								if (tokens !== undefined) {
									emit({
										_tag: "UsageDelta",
										inputTokens: tokens.input ?? 0,
										outputTokens:
											(tokens.output ?? 0) + (tokens.reasoning ?? 0),
										cacheReadTokens: tokens.cache?.read ?? 0,
										cacheCreationTokens: tokens.cache?.write ?? 0,
										model:
											model?.providerID !== undefined && model.id !== undefined
												? `${model.providerID}/${model.id}`
												: (asStr(model?.id) ?? input.model ?? "unknown"),
									});
								}
								return;
							}
							case "session.execution.succeeded": {
								checkpointScheduler.cancel();
								for (const evt of checkpointDeltaState(deltaState, true))
									emit(evt);
								if (!deltaState.turnCompleted) {
									deltaState.turnCompleted = true;
									emit({ _tag: "Status", status: "idle" });
									emit({ _tag: "Completed", reason: "ended" });
								}
								releaseTurnGate();
								return;
							}
							case "session.execution.failed": {
								checkpointScheduler.cancel();
								for (const evt of checkpointDeltaState(deltaState, true))
									emit(evt);
								const message =
									asStr(data["message"]) ??
									asStr(
										(data["error"] as { message?: string } | undefined)
											?.message,
									) ??
									"OpenCode 2 reported an error on this turn.";
								emit({
									_tag: "Error",
									message,
									providerId: PROVIDER_ID,
								});
								if (!deltaState.turnCompleted) {
									deltaState.turnCompleted = true;
									emit({ _tag: "Status", status: "idle" });
									emit({ _tag: "Completed", reason: "error" });
								}
								releaseTurnGate();
								return;
							}
							case "session.execution.interrupted": {
								checkpointScheduler.cancel();
								for (const evt of checkpointDeltaState(deltaState, true))
									emit(evt);
								emit({ _tag: "Interrupted" });
								if (!deltaState.turnCompleted) {
									deltaState.turnCompleted = true;
									emit({ _tag: "Status", status: "idle" });
									emit({ _tag: "Completed", reason: "interrupted" });
								}
								releaseTurnGate();
								return;
							}
							case "session.permission.asked":
							case "session.permission.requested":
							case "permission.asked":
							case "permission.updated": {
								const permId =
									asStr(permissionPayload(data)["id"]) ?? asStr(data["id"]);
								const extracted = extractOpencode2Permission(data);
								if (permId !== null) {
									emit({
										_tag: "PermissionRequest",
										itemId: permId as AgentItemId,
										kind: extracted.action,
										details: data,
									});
									if (
										opencodeSessionId !== null &&
										!pendingReplies.has(permId)
									) {
										pendingReplies.add(permId);
										void (async () => {
											let reply: "once" | "always" | "reject" = "once";
											if (requestPermission !== null) {
												const decision = await requestPermission(
													sessionId,
													classifyOpencode2Permission(
														extracted.action,
														extracted.resource,
													),
													{
														forcePrompt: extracted.sensitive,
													},
												);
												reply = permissionReplyFor(decision._tag);
											}
											await requestJson(
												server.url,
												server.password,
												`/api/session/${opencodeSessionId}/permission/${permId}/reply`,
												{
													method: "POST",
													body: { reply },
												},
											);
										})().catch((cause) => {
											dlog(
												`permission reply failed: ${cause instanceof Error ? cause.message : String(cause)}`,
											);
										});
									}
								}
								return;
							}
							default:
								return;
						}
					};

					subscribeSse(
						server.url,
						server.password,
						"/api/event",
						handleEvent,
						(message) => {
							if (closed) return;
							emit({
								_tag: "Error",
								message,
								providerId: PROVIDER_ID,
							});
							releaseTurnGate();
						},
						eventAbort.signal,
					);

					const createBody: Record<string, unknown> = {
						title: "Zuse session",
						location: { directory: cwd },
					};
					const agentOpt = input.modelOptions?.["agent"];
					const initialAgent =
						currentMode === "plan"
							? "plan"
							: agentOpt && agentOpt.length > 0
								? agentOpt
								: "build";
					createBody["agent"] = initialAgent;
					const { providerID, modelID } = splitModelSlug(input.model);
					const variantOpt = input.modelOptions?.["reasoning"];
					if (providerID !== null && modelID !== null) {
						createBody["model"] = {
							id: modelID,
							providerID,
							...(variantOpt && variantOpt.length > 0
								? { variant: variantOpt }
								: {}),
						};
					}

					let sid: string | null = null;
					if (resumeCursor !== null && resumeCursor.startsWith("ses")) {
						try {
							const existing = await requestJson(
								server.url,
								server.password,
								`/api/session/${resumeCursor}`,
							);
							const info = unwrapData(existing) as { id?: unknown };
							sid = asStr(info.id);
						} catch {
							sid = null;
						}
					}
					if (sid === null) {
						const created = await requestJson(
							server.url,
							server.password,
							"/api/session",
							{ method: "POST", body: createBody },
						);
						const info = unwrapData(created) as { id?: unknown };
						sid = asStr(info.id);
					}
					if (sid === null) {
						throw new Error("opencode2 session.create returned no session id");
					}
					opencodeSessionId = sid;
					return { server, eventAbort, sid };
				} catch (cause) {
					try {
						eventAbort.abort();
					} catch {
						// ignore
					}
					stopChild(server.child);
					throw cause;
				}
			},
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: PROVIDER_ID,
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});

		const { server, eventAbort, sid: opencodeSessionId } = booted;
		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: opencodeSessionId,
			strategy: "opencode2-session-id",
		});

		server.child.on("exit", (code, signal) => {
			if (closed) return;
			Queue.offerUnsafe(events, {
				_tag: "Error",
				message: `OpenCode 2 server exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`,
				providerId: PROVIDER_ID,
			});
			Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
		});

		let inflight: Promise<void> = Promise.resolve();
		let workspaceInstructionsPending = input.workspaceInstructions;
		const enqueuePrompt = (
			text: string,
			files: ReadonlyArray<{ uri: string; name?: string }> = [],
		): void => {
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
					startCompactEvent({
						providerId: PROVIDER_ID,
						snapshot: compactSnapshot,
					}),
				);
			}
			const promptText =
				compactSnapshot !== null
					? text.trim()
					: prefixFirstPromptWithWorkspaceInstructions(
							workspaceInstructionsPending,
							text,
						);
			if (compactSnapshot === null) workspaceInstructionsPending = undefined;
			inflight = inflight
				.then(async () => {
					if (closed) return;
					deltaState.turnCompleted = false;
					const agentOpt = input.modelOptions?.["agent"];
					const agent =
						currentMode === "plan"
							? "plan"
							: agentOpt && agentOpt.length > 0
								? agentOpt
								: "build";
					const { providerID, modelID } = splitModelSlug(input.model);
					const variantOpt = input.modelOptions?.["reasoning"];
					try {
						await requestJson(
							server.url,
							server.password,
							`/api/session/${opencodeSessionId}/agent`,
							{ method: "POST", body: { agent } },
						);
					} catch (cause) {
						dlog(
							`switch agent failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						);
					}
					if (providerID !== null && modelID !== null) {
						try {
							await requestJson(
								server.url,
								server.password,
								`/api/session/${opencodeSessionId}/model`,
								{
									method: "POST",
									body: {
										model: {
											id: modelID,
											providerID,
											...(variantOpt && variantOpt.length > 0
												? { variant: variantOpt }
												: {}),
										},
									},
								},
							);
						} catch (cause) {
							dlog(
								`switch model failed: ${cause instanceof Error ? cause.message : String(cause)}`,
							);
						}
					}
					try {
						const gated = armTurnGate();
						if (compactSnapshot !== null) {
							await requestJson(
								server.url,
								server.password,
								`/api/session/${opencodeSessionId}/compact`,
								{ method: "POST", body: {} },
							);
						} else {
							await requestJson(
								server.url,
								server.password,
								`/api/session/${opencodeSessionId}/prompt`,
								{
									method: "POST",
									body: {
										text: promptText,
										...(files.length > 0 ? { files } : {}),
									},
								},
							);
						}
						await Promise.race([
							gated,
							new Promise<void>((resolve) =>
								setTimeout(resolve, 10 * 60 * 1000),
							),
						]);
						checkpointScheduler.cancel();
						for (const evt of checkpointDeltaState(deltaState, true)) emit(evt);
						if (compactSnapshot !== null && !closed) {
							Queue.offerUnsafe(
								events,
								finishCompactEvent({
									itemId: compactSnapshot.itemId,
									providerId: PROVIDER_ID,
									snapshot: compactSnapshot,
									afterTokens: null,
								}),
							);
						}
						if (!deltaState.turnCompleted) {
							deltaState.turnCompleted = true;
							releaseTurnGate();
							Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
							Queue.offerUnsafe(events, {
								_tag: "Completed",
								reason: "ended",
							});
						}
					} catch (cause) {
						if (closed) return;
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						const isCancellation = /abort|cancel/i.test(reason);
						if (!isCancellation) {
							dlog(`prompt failed: ${reason}`);
							Queue.offerUnsafe(events, {
								_tag: "Error",
								message: `OpenCode 2 prompt failed: ${reason}`,
								providerId: PROVIDER_ID,
							});
							Queue.offerUnsafe(events, {
								_tag: "Completed",
								reason: "error",
							});
						}
					}
				})
				.catch(() => undefined);
		};

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			enqueuePrompt(input.initialPrompt);
		}

		const handle: Opencode2SessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs, fileRefs) =>
				Effect.gen(function* () {
					const files: { uri: string; name?: string }[] = [];
					for (const ref of fileRefs ?? []) {
						if (ref.kind !== "file") continue;
						files.push({
							uri: pathToFileURL(ref.absPath).href,
							name: basename(ref.absPath),
						});
					}
					for (const att of attachmentRefs ?? []) {
						const resolved = yield* attachments.readPath(att.id);
						if (resolved === null) {
							return yield* Effect.die(
								new Error(
									`Could not attach ${att.originalName} to the OpenCode 2 prompt.`,
								),
							);
						}
						files.push({
							uri: pathToFileURL(resolved.path).href,
							name: att.originalName,
						});
					}
					enqueuePrompt(text, files);
				}),
			interrupt: () =>
				Effect.promise(async () => {
					try {
						await requestJson(
							server.url,
							server.password,
							`/api/session/${opencodeSessionId}/interrupt`,
							{ method: "POST", body: {} },
						);
					} catch (cause) {
						dlog(
							`interrupt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						);
					}
				}),
			close: () =>
				Effect.gen(function* () {
					checkpointScheduler.cancel();
					for (const event of checkpointDeltaState(deltaState, true))
						emit(event);
					closed = true;
					try {
						eventAbort.abort();
					} catch {
						// ignore
					}
					stopChild(server.child);
					yield* Queue.end(events);
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					if (mode === currentMode) return;
					currentMode = mode;
					Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
				}),
			answerQuestion: () => Effect.void,
		};
		return handle;
	});
