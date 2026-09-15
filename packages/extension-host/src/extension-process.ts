import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import type {
	ExtensionInvocationContext,
	ExtensionProviderAdapter,
	ExtensionProviderDescriptor,
	ExtensionRpcContract,
	ExtensionServerContext,
	ExtensionServerContribution,
} from "@zuse/extension-sdk";
import * as ExtensionSdk from "@zuse/extension-sdk";
import * as ExtensionSdkServer from "@zuse/extension-sdk/server";
import { readWorkspaceText, workspaceFiles } from "@zuse/utils/workspace-files";
import { Schema } from "effect";
import type {
	ExtensionToHostMessage,
	HostToExtensionMessage,
} from "./process-protocol.ts";

const require = createRequire(import.meta.url);
const MAX_STORAGE_BYTES = 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_BLOB_TOTAL_BYTES = 10 * 1024 * 1024;
const STORAGE_VERSION_KEY = "$schemaVersion";

const send = (message: ExtensionToHostMessage): void => {
	process.send?.(message);
};

const describe = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

class JsonStorage {
	private values: Record<string, unknown> | null = null;
	private writes = Promise.resolve();

	constructor(private readonly path: string) {}

	private async load(): Promise<Record<string, unknown>> {
		if (this.values !== null) return this.values;
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.values =
				parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {};
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
			this.values = {};
		}
		return this.values;
	}

	async get(key: string): Promise<unknown> {
		return (await this.load())[key];
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.mutate((values) => ({ ...values, [key]: value }));
	}

	async delete(key: string): Promise<void> {
		await this.mutate((values) => {
			const next = { ...values };
			delete next[key];
			return next;
		});
	}

	private async mutate(
		update: (values: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void> {
		const operation = this.writes.then(async () => {
			const next = update(await this.load());
			const serialized = `${JSON.stringify(next, null, 2)}\n`;
			if (Buffer.byteLength(serialized) > MAX_STORAGE_BYTES) {
				throw new Error("Extension storage quota exceeded (1 MiB).");
			}
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const temporary = `${this.path}.tmp.${process.pid}`;
			try {
				await writeFile(temporary, serialized, { mode: 0o600 });
				await rename(temporary, this.path);
				this.values = next;
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		});
		this.writes = operation.catch(() => {});
		await operation;
	}
}

class BlobStorage {
	constructor(private readonly directory: string) {}
	private path(key: string): string {
		if (!key || key.length > 200)
			throw new Error("Invalid extension blob key.");
		return join(this.directory, Buffer.from(key).toString("base64url"));
	}
	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw cause;
		}
	}
	async set(key: string, value: Uint8Array): Promise<void> {
		if (!(value instanceof Uint8Array))
			throw new Error("Extension blobs must be Uint8Array values.");
		if (value.byteLength > MAX_BLOB_BYTES)
			throw new Error("Extension blob exceeds the 2 MiB item quota.");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const path = this.path(key);
		let total = 0;
		for (const entry of await readdir(this.directory)) {
			const candidate = join(this.directory, entry);
			if (candidate === path) continue;
			total += (await stat(candidate)).size;
		}
		if (total + value.byteLength > MAX_BLOB_TOTAL_BYTES) {
			throw new Error("Extension blob storage quota exceeded (10 MiB).");
		}
		const temporary = `${path}.tmp.${process.pid}`;
		try {
			await writeFile(temporary, value, { mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}
	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}
}

let cleanup: (() => void | Promise<void>) | null = null;
const handlers = new Map<
	string,
	{
		readonly contract: ExtensionRpcContract<unknown, unknown>;
		readonly handler: (
			input: unknown,
			context: ExtensionInvocationContext,
		) => unknown | Promise<unknown>;
	}
>();
const providers = new Map<
	string,
	{
		readonly descriptor: ExtensionProviderDescriptor;
		readonly adapter: ExtensionProviderAdapter;
	}
>();
const pendingSecrets = new Map<
	string,
	{
		readonly resolve: (value: string | null) => void;
		readonly reject: (cause: Error) => void;
	}
>();
let requestSequence = 0;

const secret = (
	operation: "get" | "set" | "delete",
	key: string,
	value?: string,
): Promise<string | null> =>
	new Promise((resolve, reject) => {
		const requestId = `secret-${++requestSequence}`;
		pendingSecrets.set(requestId, { resolve, reject });
		send({
			type: "secret",
			requestId,
			operation,
			key,
			...(value === undefined ? {} : { value }),
		});
	});

const providerMethod = async (
	method: string,
	input: unknown,
): Promise<unknown> => {
	const [, providerId, operation] = method.split(":", 3);
	const provider = providerId ? providers.get(providerId) : undefined;
	if (!provider || !operation)
		throw new Error(`Unknown extension provider method: ${method}`);
	const value = input as Record<string, unknown>;
	switch (operation) {
		case "probe":
			return provider.adapter.probe();
		case "start":
			return provider.adapter.start(value.input as never);
		case "send":
			return provider.adapter.send(String(value.sessionId), String(value.text));
		case "interrupt":
			return provider.adapter.interrupt(
				String(value.sessionId),
				typeof value.turnId === "string" ? value.turnId : undefined,
			);
		case "close":
			return provider.adapter.close(String(value.sessionId));
		case "answerQuestion":
			if (!provider.adapter.answerQuestion)
				throw new Error("Provider does not support questions.");
			return provider.adapter.answerQuestion(
				String(value.sessionId),
				String(value.itemId),
				value.answers,
			);
		case "respondToPlan":
			if (!provider.adapter.respondToPlan)
				throw new Error("Provider does not support plans.");
			return provider.adapter.respondToPlan(
				String(value.sessionId),
				String(value.itemId),
				value.outcome === "approved" ? "approved" : "rejected",
				typeof value.feedback === "string" ? value.feedback : undefined,
			);
		case "getGoal":
			if (!provider.adapter.getGoal)
				throw new Error("Provider does not support goals.");
			return provider.adapter.getGoal(String(value.sessionId));
		case "setGoal":
			if (!provider.adapter.setGoal)
				throw new Error("Provider does not support goals.");
			return provider.adapter.setGoal(String(value.sessionId), value.goal);
		case "clearGoal":
			if (!provider.adapter.clearGoal)
				throw new Error("Provider does not support goals.");
			return provider.adapter.clearGoal(String(value.sessionId));
		case "updateMcpServers":
			if (!provider.adapter.updateMcpServers)
				throw new Error("Provider does not support MCP refresh.");
			return provider.adapter.updateMcpServers(
				String(value.sessionId),
				Array.isArray(value.servers) ? value.servers : [],
			);
		default:
			throw new Error(`Unknown extension provider operation: ${operation}`);
	}
};

const initialize = async (
	message: Extract<HostToExtensionMessage, { type: "initialize" }>,
): Promise<void> => {
	const storage = new JsonStorage(message.storagePath);
	const blobs = new BlobStorage(join(dirname(message.storagePath), "blobs"));
	const capabilities = new Set(message.capabilities);
	const requireCapability = (
		capability: (typeof message.capabilities)[number],
	) => {
		if (!capabilities.has(capability)) {
			throw new Error(`Extension capability is not granted: ${capability}`);
		}
	};
	const context: ExtensionServerContext & { readonly target: "server" } = {
		target: "server",
		handle(contract, handler) {
			requireCapability("rpc");
			if (handlers.has(contract.name))
				throw new Error(`Duplicate extension RPC: ${contract.name}`);
			handlers.set(contract.name, {
				contract: contract as ExtensionRpcContract<unknown, unknown>,
				handler: handler as (
					input: unknown,
					context: ExtensionInvocationContext,
				) => unknown | Promise<unknown>,
			});
		},
		addProvider(descriptor, adapter) {
			requireCapability("providers");
			if (providers.has(descriptor.id))
				throw new Error(`Duplicate extension provider: ${descriptor.id}`);
			providers.set(descriptor.id, { descriptor, adapter });
		},
		storage: {
			get: async (key) => {
				requireCapability("storage");
				return storage.get(key);
			},
			set: async (key, value) => {
				requireCapability("storage");
				await storage.set(key, value);
			},
			delete: async (key) => {
				requireCapability("storage");
				await storage.delete(key);
			},
			version: async () => {
				requireCapability("storage");
				const version = await storage.get(STORAGE_VERSION_KEY);
				return typeof version === "number" && Number.isSafeInteger(version)
					? version
					: 0;
			},
			migrate: async (targetVersion, migration) => {
				requireCapability("storage");
				if (!Number.isSafeInteger(targetVersion) || targetVersion < 0)
					throw new Error("Invalid storage schema version.");
				const version = await storage.get(STORAGE_VERSION_KEY);
				const current =
					typeof version === "number" && Number.isSafeInteger(version)
						? version
						: 0;
				if (targetVersion <= current) return;
				await migration(current);
				await storage.set(STORAGE_VERSION_KEY, targetVersion);
			},
		},
		blobs: {
			get: (key) => {
				requireCapability("storage");
				return blobs.get(key);
			},
			set: (key, value) => {
				requireCapability("storage");
				return blobs.set(key, value);
			},
			delete: (key) => {
				requireCapability("storage");
				return blobs.delete(key);
			},
		},
		secrets: {
			get: (key) => {
				requireCapability("credentials");
				return secret("get", key);
			},
			set: async (key, value) => {
				requireCapability("credentials");
				await secret("set", key, value);
			},
			delete: async (key) => {
				requireCapability("credentials");
				await secret("delete", key);
			},
		},
		credentials: {
			get: (providerId) => {
				requireCapability("credentials");
				if (!providers.has(providerId)) {
					throw new Error(
						`Credential access is limited to a registered provider: ${providerId}`,
					);
				}
				return secret("get", `provider:${providerId}`);
			},
		},
		emitProviderEvent(sessionId, event) {
			requireCapability("providers");
			send({ type: "provider-event", sessionId, event });
		},
	};
	const runtimeRequire = (name: string): unknown => {
		if (name === "effect") return require("effect");
		if (isBuiltin(name)) return require(name);
		if (name === "@zuse/extension-sdk/server") return ExtensionSdkServer;
		if (name === "@zuse/extension-sdk") {
			return { ...ExtensionSdk, extensionTarget: "server" as const };
		}
		throw new Error(
			`Module ${name} is not available in extension server code.`,
		);
	};
	// The bundle is trusted code and evaluates in this dedicated child process;
	// the supplied require function is still restricted to host APIs.
	// biome-ignore lint/security/noGlobalEval: trusted extension factory boundary
	const evaluate = globalThis.eval as (source: string) => unknown;
	const factory = evaluate(message.bundle);
	if (typeof factory !== "function")
		throw new Error("Extension server bundle is not executable.");
	const exports = (factory as (require: (name: string) => unknown) => unknown)(
		runtimeRequire,
	);
	const setup =
		exports && typeof exports === "object"
			? Reflect.get(exports, "default")
			: undefined;
	if (typeof setup !== "function")
		throw new Error("Extension must default export a contribution function.");
	const result = await (setup as ExtensionServerContribution)(context);
	if (typeof result !== "function")
		throw new Error("Extension contribution must return cleanup.");
	cleanup = result;
	send({
		type: "ready",
		methods: [...handlers.keys()].sort(),
		providers: [...providers.values()].map(({ descriptor }) => descriptor),
	});
};

let filesystemGranted = false;
const requests = new Map<string, AbortController>();
process.on("message", (raw: HostToExtensionMessage) => {
	void (async () => {
		if (raw.type === "initialize") {
			filesystemGranted = raw.capabilities.includes("filesystem");
			await initialize(raw);
			return;
		}
		if (raw.type === "secret-result") {
			const pending = pendingSecrets.get(raw.requestId);
			if (!pending) return;
			pendingSecrets.delete(raw.requestId);
			if (raw.error) pending.reject(new Error(raw.error));
			else pending.resolve(raw.value ?? null);
			return;
		}
		if (raw.type === "cancel") {
			requests.get(raw.requestId)?.abort();
			return;
		}
		if (raw.type === "invoke") {
			const controller = new AbortController();
			requests.set(raw.requestId, controller);
			try {
				let output: unknown;
				if (raw.method.startsWith("provider:")) {
					output = await providerMethod(raw.method, raw.input);
				} else {
					const registered = handlers.get(raw.method);
					if (!registered)
						throw new Error(`Unknown extension RPC: ${raw.method}`);
					const input = await Schema.decodeUnknownPromise(
						registered.contract.input,
					)(raw.input);
					const root = raw.workspace?.workspacePath;
					const requireRoot = () => {
						if (!filesystemGranted)
							throw new Error("Filesystem capability is not granted.");
						if (!root) throw new Error("Select a local workspace first.");
						return root;
					};
					output = await registered.handler(input, {
						workspace: raw.workspace ?? null,
						signal: controller.signal,
						files: {
							list: async () => {
								const paths: string[] = [];
								for await (const path of workspaceFiles(
									requireRoot(),
									controller.signal,
								)) {
									if (paths.length === 10000) return { paths, truncated: true };
									paths.push(path);
								}
								return { paths, truncated: false };
							},
							read: (path) =>
								readWorkspaceText(requireRoot(), path, controller.signal),
						},
					});
					output = await Schema.decodeUnknownPromise(
						registered.contract.output,
					)(output);
				}
				send({ type: "result", requestId: raw.requestId, output });
			} catch (cause) {
				send({
					type: "result",
					requestId: raw.requestId,
					error: describe(cause),
				});
			}
			requests.delete(raw.requestId);
			return;
		}
		if (raw.type === "stop") {
			for (const controller of requests.values()) controller.abort();
			await cleanup?.();
			process.disconnect?.();
			process.exit(0);
		}
	})().catch((cause) => send({ type: "fatal", error: describe(cause) }));
});
