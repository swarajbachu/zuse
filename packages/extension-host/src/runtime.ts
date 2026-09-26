import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killAcpProcess } from "@zuse/acp/process";
import {
	type ExtensionCapability,
	type ExtensionLogEntry,
	ProviderId,
	type ExtensionProviderDescriptor as WireProviderDescriptor,
} from "@zuse/contracts";
import type { ExtensionProviderDescriptor } from "@zuse/extension-sdk";
import { unpackedPath } from "@zuse/utils/unpacked-path";
import { Schema } from "effect";
import type {
	ExtensionToHostMessage,
	HostToExtensionMessage,
} from "./process-protocol.ts";
import type { CompiledExtension, ExtensionSecretStore } from "./types.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;

interface Pending {
	readonly resolve: (output: unknown) => void;
	readonly reject: (cause: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

export interface RunningExtension {
	readonly id: string;
	readonly clientBundle: string;
	readonly clientCss: string;
	readonly providers: ReadonlyArray<WireProviderDescriptor>;
	readonly methods: ReadonlyArray<string>;
	readonly activate: () => void;
	readonly cancel: (requestId: string) => void;
	readonly invoke: (
		method: string,
		input: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
		requestId?: string,
	) => Promise<unknown>;
	readonly stop: () => Promise<void>;
	readonly logs: () => ReadonlyArray<ExtensionLogEntry>;
	readonly onProviderEvent: (
		listener: (sessionId: string, event: unknown) => void,
	) => () => void;
}

const packagedWorkerUrl = new URL(
	"./extension-process-child.cjs",
	import.meta.url,
);
const workerUrl = existsSync(fileURLToPath(packagedWorkerUrl))
	? packagedWorkerUrl
	: new URL("./extension-process.ts", import.meta.url);
const workerExecArgv = (): string[] =>
	workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : [];

const toWireProvider = (
	descriptor: ExtensionProviderDescriptor,
): WireProviderDescriptor => ({
	id: Schema.decodeUnknownSync(ProviderId)(descriptor.id),
	displayName: descriptor.displayName,
	iconAssetUrl: descriptor.iconAsset ?? null,
	order: descriptor.order ?? 1000,
	authentication:
		descriptor.authentication.kind === "none"
			? { _tag: "none" }
			: descriptor.authentication.kind === "api-key"
				? {
						_tag: "api-key",
						label: descriptor.authentication.label,
						placeholder: descriptor.authentication.placeholder ?? null,
					}
				: {
						_tag: "extension-managed",
						settingsSurfaceId: descriptor.authentication.settingsSurfaceId,
					},
	capabilities: [...descriptor.capabilities],
	models: descriptor.models.map((model) => ({
		id: model.id,
		label: model.label,
		defaultVisible: model.defaultVisible ?? true,
		defaultModel: model.defaultModel ?? false,
		supportsPlanMode: model.supportsPlanMode ?? false,
		supportsWebSearch: model.supportsWebSearch ?? null,
	})),
});

export const startExtensionProcess = async (input: {
	readonly id: string;
	readonly compiled: CompiledExtension;
	readonly capabilities: ReadonlyArray<ExtensionCapability>;
	readonly storagePath: string;
	readonly secretStore: ExtensionSecretStore;
	readonly now: () => Date;
	readonly onExit: (error: string) => void;
	readonly startupTimeoutMs?: number;
}): Promise<RunningExtension> => {
	const child = fork(unpackedPath(fileURLToPath(workerUrl)), [], {
		execArgv: workerExecArgv(),
		serialization: "advanced",
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const managedProcesses = new Set<number>();
	const cleanupProcesses = () => {
		for (const pid of managedProcesses) killAcpProcess(pid);
		managedProcesses.clear();
	};
	const pending = new Map<string, Pending>();
	const providerListeners = new Set<
		(sessionId: string, event: unknown) => void
	>();
	const entries: ExtensionLogEntry[] = [];
	const redactions = new Set<string>();
	let logBytes = 0;
	let sequence = 0;
	let stopping = false;
	let ready = false;
	let active = false;

	const append = (stream: "stdout" | "stderr", value: string): void => {
		for (const rawLine of value.split(/\r?\n/)) {
			if (!rawLine) continue;
			let message = Buffer.from(rawLine)
				.subarray(0, MAX_LOG_LINE_BYTES)
				.toString("utf8");
			for (const secret of redactions) {
				if (secret.length >= 4)
					message = message.split(secret).join("[REDACTED]");
			}
			message = message.replace(
				/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
				"[REDACTED]",
			);
			const bytes = Buffer.byteLength(message);
			entries.push({
				sequence: ++sequence,
				timestamp: input.now().toISOString() as ExtensionLogEntry["timestamp"],
				stream,
				message,
			});
			logBytes += bytes;
			while (entries.length > MAX_LOG_ENTRIES || logBytes > MAX_LOG_BYTES) {
				const removed = entries.shift();
				if (removed) logBytes -= Buffer.byteLength(removed.message);
			}
		}
	};
	child.stdout?.on("data", (chunk) => append("stdout", String(chunk)));
	child.stderr?.on("data", (chunk) => append("stderr", String(chunk)));

	let resolveReady!: (ready: {
		readonly providers: ReadonlyArray<WireProviderDescriptor>;
		readonly methods: ReadonlyArray<string>;
	}) => void;
	let rejectReady!: (cause: Error) => void;
	const initialized = new Promise<{
		readonly providers: ReadonlyArray<WireProviderDescriptor>;
		readonly methods: ReadonlyArray<string>;
	}>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const startTimeout = setTimeout(
		() => rejectReady(new Error(`Extension ${input.id} did not initialize.`)),
		input.startupTimeoutMs ?? START_TIMEOUT_MS,
	);

	child.on("message", (raw: ExtensionToHostMessage) => {
		if (raw.type === "managed-process") {
			if (
				!Number.isSafeInteger(raw.pid) ||
				raw.pid <= 0 ||
				raw.pid === process.pid ||
				raw.pid === child.pid
			)
				return;
			if (!raw.running) managedProcesses.delete(raw.pid);
			else if (stopping) killAcpProcess(raw.pid);
			else managedProcesses.add(raw.pid);
			return;
		}
		if (raw.type === "ready") {
			if (ready) return;
			ready = true;
			clearTimeout(startTimeout);
			try {
				resolveReady({
					providers: raw.providers.map(toWireProvider),
					methods: raw.methods,
				});
			} catch (cause) {
				rejectReady(cause instanceof Error ? cause : new Error(String(cause)));
			}

			return;
		}
		if (raw.type === "fatal") {
			if (!ready) rejectReady(new Error(raw.error));
			append("stderr", raw.error);
			return;
		}
		if (raw.type === "result") {
			const request = pending.get(raw.requestId);
			if (!request) return;
			pending.delete(raw.requestId);
			clearTimeout(request.timeout);
			if (raw.error) request.reject(new Error(raw.error));
			else request.resolve(raw.output);
			return;
		}
		if (raw.type === "provider-event") {
			for (const listener of providerListeners)
				listener(raw.sessionId, raw.event);
			return;
		}
		if (raw.type === "secret") {
			void (async () => {
				try {
					if (!input.capabilities.includes("credentials"))
						throw new Error(
							"Secret access requires the credentials capability.",
						);
					if (raw.operation !== "get" && !active)
						throw new Error(
							"Secret writes are unavailable during extension preparation.",
						);
					let value: string | null = null;
					if (raw.operation === "get") {
						value = await input.secretStore.get(input.id, raw.key);
						if (value) redactions.add(value);
					} else if (raw.operation === "set")
						await input.secretStore.set(input.id, raw.key, raw.value ?? "");
					else await input.secretStore.delete(input.id, raw.key);
					child.send({
						type: "secret-result",
						requestId: raw.requestId,
						value,
					} satisfies HostToExtensionMessage);
				} catch (cause) {
					child.send({
						type: "secret-result",
						requestId: raw.requestId,
						error: cause instanceof Error ? cause.message : String(cause),
					} satisfies HostToExtensionMessage);
				}
			})();
		}
	});
	child.on("error", (cause) => {
		if (!ready) rejectReady(cause);
	});
	child.on("close", (code, signal) => {
		cleanupProcesses();
		clearTimeout(startTimeout);
		const error = `Extension ${input.id} exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
		if (!ready) rejectReady(new Error(error));
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.reject(new Error(error));
		}
		pending.clear();
		if (!stopping) input.onExit(error);
	});

	child.send({
		type: "initialize",
		extensionId: input.id,
		bundle: input.compiled.serverBundle,
		storagePath: input.storagePath,
		capabilities: input.capabilities,
	} satisfies HostToExtensionMessage);

	const initializedExtension = await initialized.catch((cause) => {
		cleanupProcesses();
		child.kill("SIGKILL");
		const detail = entries
			.slice(-10)
			.map((entry) => entry.message)
			.join("\n");
		throw new Error(
			`${cause instanceof Error ? cause.message : String(cause)}${detail ? `\n${detail}` : ""}`,
		);
	});
	const invoke = (
		method: string,
		value: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
		token?: string,
	): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (!child.connected || stopping || !active) {
				reject(new Error(`Extension ${input.id} is not connected.`));
				return;
			}
			if (pending.size >= 128) {
				reject(new Error("Extension RPC queue is full."));
				return;
			}
			const requestId = token ?? randomUUID();
			if (pending.has(requestId)) {
				reject(new Error("Duplicate extension invocation."));
				return;
			}
			const timeout = setTimeout(() => {
				pending.delete(requestId);
				if (child.connected) child.send({ type: "cancel", requestId });
				reject(new Error(`Extension RPC timed out: ${input.id}.${method}`));
			}, REQUEST_TIMEOUT_MS);
			pending.set(requestId, { resolve, reject, timeout });
			child.send({
				type: "invoke",
				requestId,
				method,
				input: value,
				workspace,
			} satisfies HostToExtensionMessage);
		});

	return {
		id: input.id,
		activate: () => {
			active = true;
		},
		clientBundle: input.compiled.clientBundle,
		clientCss: input.compiled.clientCss,
		providers: initializedExtension.providers,
		methods: initializedExtension.methods,
		cancel: (requestId) => {
			const request = pending.get(requestId);
			if (!request) return;
			pending.delete(requestId);
			clearTimeout(request.timeout);
			if (child.connected) child.send({ type: "cancel", requestId });
			request.reject(new Error("Extension request cancelled."));
		},
		invoke,
		logs: () => [...entries],
		onProviderEvent(listener) {
			providerListeners.add(listener);
			return () => providerListeners.delete(listener);
		},
		stop: async () => {
			if (stopping) return;
			stopping = true;
			if (child.exitCode !== null || child.signalCode !== null) return;
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					cleanupProcesses();
					child.kill("SIGKILL");
				}, STOP_TIMEOUT_MS);
				child.once("close", () => {
					clearTimeout(timeout);
					resolve();
				});
				if (child.connected)
					child.send({ type: "stop" } satisfies HostToExtensionMessage);
				else {
					cleanupProcesses();
					child.kill("SIGKILL");
				}
			});
		},
	};
};
