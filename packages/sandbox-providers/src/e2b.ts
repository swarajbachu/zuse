import { Effect, Redacted, Schema } from "effect";
import {
	type ProviderSandbox,
	type SandboxNetworkPolicy,
	type SandboxProcessInput,
	type SandboxProcessSelector,
	type SandboxProviderAdapter,
	SandboxProviderError,
} from "./index.ts";

const SandboxMetadata = Schema.optional(
	Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
);

const CreatedSandbox = Schema.Struct({
	sandboxID: Schema.String,
	domain: Schema.optional(Schema.NullOr(Schema.String)),
	envdAccessToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const CreateResponse = CreatedSandbox;

const SandboxDetail = Schema.Struct({
	sandboxID: Schema.String,
	state: Schema.Literals(["running", "paused"]),
	domain: Schema.optional(Schema.NullOr(Schema.String)),
	metadata: SandboxMetadata,
	envdAccessToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const SandboxListResponse = Schema.Array(SandboxDetail);

const SnapshotResponse = Schema.Struct({
	snapshotID: Schema.String,
});

const ProcessInfo = Schema.Struct({
	config: Schema.Struct({
		cmd: Schema.String,
		args: Schema.optional(Schema.Array(Schema.String)),
	}),
	pid: Schema.Number,
	tag: Schema.optional(Schema.NullOr(Schema.String)),
});
const ProcessListResponse = Schema.Struct({
	processes: Schema.Array(ProcessInfo),
});

type SandboxDetail = Schema.Schema.Type<typeof SandboxDetail>;

export interface E2bSandboxConfig {
	readonly apiKey: Redacted.Redacted<string>;
	readonly templateId: string;
	readonly templateVersion?: string;
	readonly apiBaseUrl?: string;
	// Fallback for composing per-port hosts when the API omits `domain`.
	readonly sandboxDomain?: string;
}

export interface E2bHttpClient {
	readonly fetch: typeof globalThis.fetch;
}

const defaultHttpClient: E2bHttpClient = {
	fetch: (input, init) => globalThis.fetch(input, init),
};

const providerError = (
	code: SandboxProviderError["code"],
): SandboxProviderError => new SandboxProviderError({ code });

const errorForStatus = (status: number): SandboxProviderError =>
	status === 404
		? providerError("not-found")
		: status === 400 ||
				status === 401 ||
				status === 403 ||
				status === 409 ||
				status === 422
			? providerError("rejected")
			: providerError("transient");

const reportRequestFailure = (input: {
	readonly method: string;
	readonly phase: "network" | "response" | "decode";
	readonly status?: number;
}): void => {
	console.warn("[zuse:sandbox-provider] request failed", {
		method: input.method,
		phase: input.phase,
		status: input.status,
	});
};

// updateNetwork replaces the whole egress config on the provider side, so
// every policy maps to one complete body — never an incremental "clear then
// add" sequence (ADR 0033 quarantine caveat).
const e2bRestrictedNetwork = (
	network: Extract<SandboxNetworkPolicy, { readonly kind: "restricted" }>,
): {
	readonly allowOut: ReadonlyArray<string>;
	readonly denyOut: string[];
} => ({
	allowOut: network.allowOut,
	// The current E2B network API rejects the IPv6 catch-all even though it
	// accepts the equivalent IPv4 CIDR. E2B documents `allow_internet_access:
	// false` as equivalent to denying 0.0.0.0/0, so the IPv4 rule is the
	// provider-compatible universal deny used by restricted policies.
	denyOut: network.denyOut.filter((entry) => entry !== "::/0"),
});

const networkUpdateBody = (network: SandboxNetworkPolicy): unknown => {
	switch (network.kind) {
		case "quarantined":
			return { allow_internet_access: false };
		case "open":
			return { allow_internet_access: true };
		case "restricted":
			return e2bRestrictedNetwork(network);
	}
};

const networkCreateFields = (
	network: SandboxNetworkPolicy,
): Record<string, unknown> => {
	switch (network.kind) {
		case "quarantined":
			return { allow_internet_access: false };
		case "open":
			return { allow_internet_access: true };
		case "restricted":
			return {
				network: e2bRestrictedNetwork(network),
			};
	}
};

const connectJsonEnvelope = (value: unknown): Uint8Array<ArrayBuffer> => {
	const payload = new TextEncoder().encode(JSON.stringify(value));
	const envelope = new Uint8Array(5 + payload.byteLength);
	new DataView(envelope.buffer).setUint32(1, payload.byteLength, false);
	envelope.set(payload, 5);
	return envelope;
};

const readConnectJsonEnvelope = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> => {
	let bytes = new Uint8Array(0);
	let payloadLength: number | undefined;
	while (payloadLength === undefined || bytes.byteLength < payloadLength + 5) {
		const next = await reader.read();
		if (next.done) throw new Error("Connect stream ended before an event");
		const merged = new Uint8Array(bytes.byteLength + next.value.byteLength);
		merged.set(bytes);
		merged.set(next.value, bytes.byteLength);
		bytes = merged;
		if (bytes.byteLength >= 5 && payloadLength === undefined) {
			if ((bytes[0] ?? 0) !== 0) {
				throw new Error("Connect stream returned an end-stream envelope");
			}
			payloadLength = new DataView(bytes.buffer).getUint32(1, false);
			if (payloadLength > 1_048_576) {
				throw new Error("Connect stream event exceeded the size limit");
			}
		}
	}
	return JSON.parse(
		new TextDecoder().decode(bytes.slice(5, 5 + (payloadLength ?? 0))),
	);
};

const isProcessStartEvent = (
	value: unknown,
): value is {
	readonly event: { readonly start: { readonly pid: number } };
} => {
	if (typeof value !== "object" || value === null) return false;
	const event = Reflect.get(value, "event");
	if (typeof event !== "object" || event === null) return false;
	const start = Reflect.get(event, "start");
	return (
		typeof start === "object" &&
		start !== null &&
		typeof Reflect.get(start, "pid") === "number"
	);
};

export const E2B_API_BASE_URL = "https://api.e2b.app";
export const E2B_DEFAULT_SANDBOX_DOMAIN = "e2b.app";
export const E2B_PROVIDER_ID = "e2b" as const;

const LABEL_METADATA_KEY = "zuse-label";
const SANDBOX_ID_METADATA_KEY = "zuse-sandbox-id";

export const makeE2bSandboxProvider = (
	config: E2bSandboxConfig,
	http: E2bHttpClient = defaultHttpClient,
): SandboxProviderAdapter => {
	const apiBaseUrl = (config.apiBaseUrl ?? E2B_API_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const endpointDomain = (domain: string | null | undefined): string =>
		domain ?? config.sandboxDomain ?? E2B_DEFAULT_SANDBOX_DOMAIN;
	const controlTokens = new Map<string, string>();

	const send = (
		method: string,
		path: string,
		body?: unknown,
	): Effect.Effect<Response, SandboxProviderError> =>
		Effect.tryPromise({
			try: () =>
				http.fetch(`${apiBaseUrl}${path}`, {
					method,
					headers: {
						"x-api-key": Redacted.value(config.apiKey),
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => {
				reportRequestFailure({ method, phase: "network" });
				return providerError("transient");
			},
		});
	const failForResponse = (
		method: string,
		response: Response,
	): Effect.Effect<never, SandboxProviderError> =>
		Effect.sync(() => {
			reportRequestFailure({
				method,
				phase: "response",
				status: response.status,
			});
		}).pipe(Effect.andThen(Effect.fail(errorForStatus(response.status))));

	const request = <A, I>(
		method: string,
		path: string,
		schema: Schema.Codec<A, I>,
		body?: unknown,
	): Effect.Effect<A, SandboxProviderError> =>
		send(method, path, body).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.tryPromise({
							try: (): Promise<unknown> => response.json(),
							catch: () => {
								reportRequestFailure({
									method,
									phase: "decode",
									status: response.status,
								});
								return providerError("transient");
							},
						})
					: failForResponse(method, response),
			),
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
			Effect.mapError((error) => {
				if (error instanceof SandboxProviderError) return error;
				reportRequestFailure({ method, phase: "decode" });
				return providerError("transient");
			}),
		);

	const requestVoid = (
		method: string,
		path: string,
		body?: unknown,
		toleratedStatuses: ReadonlyArray<number> = [],
	): Effect.Effect<void, SandboxProviderError> =>
		send(method, path, body).pipe(
			Effect.flatMap((response) =>
				response.ok || toleratedStatuses.includes(response.status)
					? Effect.void
					: failForResponse(method, response),
			),
		);

	const toProviderSandbox = (detail: SandboxDetail): ProviderSandbox => ({
		providerSandboxId: detail.sandboxID,
		providerLabel: detail.metadata?.[LABEL_METADATA_KEY] ?? "",
		state: detail.state,
	});

	const createSandbox = (input: {
		readonly sandboxId: string;
		readonly providerLabel: string;
		readonly templateId: string;
		readonly timeoutSeconds: number;
		readonly env: Readonly<Record<string, string>>;
		readonly network: SandboxNetworkPolicy;
		readonly onTimeout: "pause" | "terminate";
	}): Effect.Effect<ProviderSandbox, SandboxProviderError> =>
		request("POST", "/sandboxes", CreateResponse, {
			templateID: input.templateId,
			timeout: input.timeoutSeconds,
			secure: true,
			metadata: {
				[SANDBOX_ID_METADATA_KEY]: input.sandboxId,
				[LABEL_METADATA_KEY]: input.providerLabel,
			},
			envVars: input.env,
			...networkCreateFields(input.network),
			autoPause: input.onTimeout === "pause",
		}).pipe(
			Effect.tap((created) =>
				Effect.sync(() => {
					if (created.envdAccessToken != null) {
						controlTokens.set(created.sandboxID, created.envdAccessToken);
					}
				}),
			),
			Effect.map(
				(created): ProviderSandbox => ({
					providerSandboxId: created.sandboxID,
					providerLabel: input.providerLabel,
					state: "running",
				}),
			),
		);

	const inspect = (
		providerSandboxId: string,
	): Effect.Effect<ProviderSandbox | null, SandboxProviderError> =>
		request(
			"GET",
			`/sandboxes/${encodeURIComponent(providerSandboxId)}`,
			SandboxDetail,
		).pipe(
			Effect.map(toProviderSandbox),
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
			),
		);

	const sandboxDetail = (
		providerSandboxId: string,
	): Effect.Effect<SandboxDetail, SandboxProviderError> =>
		request(
			"GET",
			`/sandboxes/${encodeURIComponent(providerSandboxId)}`,
			SandboxDetail,
		);

	const processConnection = Effect.fn("E2bSandboxProvider.processConnection")(
		function* (providerSandboxId: string) {
			const detail = yield* sandboxDetail(providerSandboxId);
			let accessToken = controlTokens.get(providerSandboxId);
			if (accessToken === undefined) {
				const connected = yield* request(
					"POST",
					`/sandboxes/${encodeURIComponent(providerSandboxId)}/connect`,
					CreateResponse,
					{ timeout: 300 },
				);
				accessToken = connected.envdAccessToken ?? undefined;
				if (accessToken !== undefined)
					controlTokens.set(providerSandboxId, accessToken);
			}
			if (accessToken === undefined) return yield* providerError("rejected");
			return {
				accessToken,
				host: `49983-${providerSandboxId}.${endpointDomain(detail.domain)}`,
			};
		},
	);
	const envdHeaders = (
		providerSandboxId: string,
		accessToken: string,
		user?: string,
	): Record<string, string> => ({
		"E2b-Sandbox-Id": providerSandboxId,
		"E2b-Sandbox-Port": "49983",
		"X-Access-Token": accessToken,
		...(user === undefined
			? {}
			: { Authorization: `Basic ${btoa(`${user}:`)}` }),
	});

	const startProcess = Effect.fn("E2bSandboxProvider.startProcess")(function* (
		providerSandboxId: string,
		input: SandboxProcessInput,
	) {
		const { accessToken, host } = yield* processConnection(providerSandboxId);
		const response = yield* Effect.tryPromise({
			try: () =>
				http.fetch(`https://${host}/process.Process/Start`, {
					method: "POST",
					headers: {
						"Connect-Protocol-Version": "1",
						"Content-Type": "application/connect+json",
						...envdHeaders(providerSandboxId, accessToken, input.user),
					},
					body: connectJsonEnvelope({
						process: {
							cmd: input.command,
							args: input.args ?? [],
							cwd: input.cwd,
							envs: input.env ?? {},
						},
						tag: input.tag,
						stdin: false,
					}),
				}),
			catch: () => providerError("transient"),
		});

		if (!response.ok) return yield* errorForStatus(response.status);
		// Process.Start is a server stream. Wait for envd's first process event so
		// cancelling the response cannot race process creation, then release the
		// stream instead of holding a Worker request for the server's lifetime.
		yield* Effect.tryPromise({
			try: async () => {
				if (response.body === null) {
					throw new Error("Process.Start returned no stream");
				}
				const reader = response.body.getReader();
				try {
					const first = await readConnectJsonEnvelope(reader);
					if (!isProcessStartEvent(first)) {
						throw new Error("Process.Start did not return a start event");
					}
				} finally {
					await reader.cancel();
				}
			},
			catch: () => providerError("transient"),
		});
	});

	const replaceProcess = Effect.fn("E2bSandboxProvider.replaceProcess")(
		function* (
			providerSandboxId: string,
			selector: SandboxProcessSelector,
			input: SandboxProcessInput,
		) {
			const { accessToken, host } = yield* processConnection(providerSandboxId);
			const listResponse = yield* Effect.tryPromise({
				try: () =>
					http.fetch(`https://${host}/process.Process/List`, {
						method: "POST",
						headers: {
							"Connect-Protocol-Version": "1",
							"Content-Type": "application/json",
							...envdHeaders(providerSandboxId, accessToken),
						},
						body: "{}",
					}),
				catch: () => providerError("transient"),
			});
			if (!listResponse.ok) return yield* errorForStatus(listResponse.status);
			const listed = yield* Effect.tryPromise({
				try: () => listResponse.json(),
				catch: () => providerError("transient"),
			}).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ProcessListResponse)),
				Effect.mapError(() => providerError("transient")),
			);
			const legacyMarkers = selector.legacyCommandMarkers ?? [];
			let taggedProcessFound = false;
			const replaced = listed.processes.filter((process) => {
				if (process.tag === selector.tag) {
					taggedProcessFound = true;
					return true;
				}
				const command = [
					process.config.cmd,
					...(process.config.args ?? []),
				].join(" ");
				const matches = legacyMarkers.some((marker) =>
					command.includes(marker),
				);
				return matches;
			});
			yield* Effect.forEach(
				replaced,
				(process) =>
					Effect.tryPromise({
						try: () =>
							http.fetch(`https://${host}/process.Process/SendSignal`, {
								method: "POST",
								headers: {
									"Connect-Protocol-Version": "1",
									"Content-Type": "application/json",
									...envdHeaders(providerSandboxId, accessToken),
								},
								body: JSON.stringify({
									process: { pid: process.pid },
									signal: "SIGNAL_SIGKILL",
								}),
							}),
						catch: () => providerError("transient"),
					}).pipe(
						Effect.flatMap((response) =>
							response.ok
								? Effect.void
								: Effect.fail(errorForStatus(response.status)),
						),
					),
				{ concurrency: "unbounded" },
			);
			const cleanupLegacyUserProcesses =
				selector.legacyCleanup === "same-user" && !taggedProcessFound;
			const replacement = cleanupLegacyUserProcesses
				? {
						...input,
						command: "/bin/bash",
						args: [
							"-lc",
							'uid=$(id -u); for proc in /proc/[0-9]*; do pid=$(basename -- "$proc"); if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; proc_uid=; while read -r key value _; do if [ "$key" = "Uid:" ]; then proc_uid=$value; break; fi; done < "$proc/status" 2>/dev/null || continue; if [ "$proc_uid" = "$uid" ]; then kill -KILL "$pid" 2>/dev/null || true; fi; done; exec "$@"',
							"zuse-runtime-legacy-cleanup",
							input.command,
							...(input.args ?? []),
						],
					}
				: input;
			yield* startProcess(providerSandboxId, {
				...replacement,
				tag: selector.tag,
			});
		},
	);

	const pathExists = Effect.fn("E2bSandboxProvider.pathExists")(function* (
		providerSandboxId: string,
		path: string,
		user?: string,
	) {
		const { accessToken, host } = yield* processConnection(providerSandboxId);
		const response = yield* Effect.tryPromise({
			try: () =>
				http.fetch(`https://${host}/filesystem.Filesystem/Stat`, {
					method: "POST",
					headers: {
						"Connect-Protocol-Version": "1",
						"Content-Type": "application/json",
						...envdHeaders(providerSandboxId, accessToken, user),
					},
					body: JSON.stringify({ path }),
				}),
			catch: () => providerError("transient"),
		});
		if (response.status === 404) return false;
		if (!response.ok) return yield* errorForStatus(response.status);
		return true;
	});

	const readTextFile = Effect.fn("E2bSandboxProvider.readTextFile")(function* (
		providerSandboxId: string,
		path: string,
		user?: string,
	) {
		const { accessToken, host } = yield* processConnection(providerSandboxId);
		const query = new URLSearchParams({ path });
		if (user !== undefined) query.set("username", user);
		const response = yield* Effect.tryPromise({
			try: () =>
				http.fetch(`https://${host}/files?${query.toString()}`, {
					headers: {
						...envdHeaders(providerSandboxId, accessToken),
					},
				}),
			catch: () => providerError("transient"),
		});
		if (!response.ok) return yield* errorForStatus(response.status);
		const contentLength = Number(response.headers.get("content-length") ?? "0");
		if (contentLength > 65_536) return yield* providerError("rejected");
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: () => providerError("transient"),
		});
		if (new TextEncoder().encode(text).byteLength > 65_536)
			return yield* providerError("rejected");
		return text;
	});

	const writeTextFile = Effect.fn("E2bSandboxProvider.writeTextFile")(
		function* (
			providerSandboxId: string,
			path: string,
			contents: string,
			user?: string,
		) {
			if (new TextEncoder().encode(contents).byteLength > 65_536)
				return yield* providerError("rejected");
			const { accessToken, host } = yield* processConnection(providerSandboxId);
			const query = new URLSearchParams({ path });
			if (user !== undefined) query.set("username", user);
			const form = new FormData();
			form.append(
				"file",
				new Blob([contents], { type: "text/plain" }),
				path.split("/").at(-1) ?? "file",
			);
			const response = yield* Effect.tryPromise({
				try: () =>
					http.fetch(`https://${host}/files?${query.toString()}`, {
						method: "POST",
						headers: {
							...envdHeaders(providerSandboxId, accessToken),
						},
						body: form,
					}),
				catch: () => providerError("transient"),
			});
			if (!response.ok) return yield* errorForStatus(response.status);
		},
	);

	return {
		providerId: E2B_PROVIDER_ID,
		displayName: "E2B",
		templateVersion: config.templateVersion ?? config.templateId,
		resolveEndpoint: (providerSandboxId, port) =>
			sandboxDetail(providerSandboxId).pipe(
				Effect.map((detail) => {
					const host = `${port}-${providerSandboxId}.${endpointDomain(detail.domain)}`;
					return {
						httpBaseUrl: `https://${host}`,
						wsBaseUrl: `wss://${host}`,
					};
				}),
			),
		create: (input) =>
			createSandbox({ ...input, templateId: config.templateId }),
		// A fork wakes with the parent's warm state and secrets, so the network
		// barrier is hard-coded here: it opens only via an explicit setNetwork
		// after re-key/enrollment completes (ADR 0033).
		fork: (input) =>
			createSandbox({
				sandboxId: input.sandboxId,
				providerLabel: input.providerLabel,
				templateId: input.snapshotId,
				timeoutSeconds: input.timeoutSeconds,
				env: input.env,
				network: { kind: "quarantined" },
				onTimeout: input.onTimeout,
			}),
		recoverByLabel: (providerLabel) =>
			request(
				"GET",
				`/v2/sandboxes?state=running,paused&metadata=${encodeURIComponent(
					new URLSearchParams({
						[LABEL_METADATA_KEY]: providerLabel,
					}).toString(),
				)}`,
				SandboxListResponse,
			).pipe(
				Effect.map((sandboxes) => {
					const found = sandboxes.find(
						(candidate) =>
							candidate.metadata?.[LABEL_METADATA_KEY] === providerLabel,
					);
					return found === undefined ? null : toProviderSandbox(found);
				}),
			),
		startProcess,
		replaceProcess,
		pathExists,
		readTextFile,
		writeTextFile,
		inspect,
		pause: (providerSandboxId) =>
			requestVoid(
				"POST",
				`/sandboxes/${encodeURIComponent(providerSandboxId)}/pause`,
				{ memory: true },
				// 409 means the sandbox is already paused.
				[409],
			),
		resume: Effect.fn("E2bSandboxProvider.resume")(
			function* (providerSandboxId, timeoutSeconds, onTimeout) {
				yield* requestVoid(
					"POST",
					`/sandboxes/${encodeURIComponent(providerSandboxId)}/connect`,
					{
						timeout: timeoutSeconds,
						autoPause: onTimeout === "pause",
					},
				);
				const sandbox = yield* inspect(providerSandboxId);
				if (sandbox === null) {
					return yield* providerError("not-found");
				}
				return sandbox;
			},
		),
		extendTimeout: (providerSandboxId, timeoutSeconds) =>
			requestVoid(
				"POST",
				`/sandboxes/${encodeURIComponent(providerSandboxId)}/timeout`,
				{ timeout: timeoutSeconds },
			),
		setNetwork: (providerSandboxId, network) =>
			requestVoid(
				"PUT",
				`/sandboxes/${encodeURIComponent(providerSandboxId)}/network`,
				networkUpdateBody(network),
			),
		snapshot: (providerSandboxId, name) =>
			request(
				"POST",
				`/sandboxes/${encodeURIComponent(providerSandboxId)}/snapshots`,
				SnapshotResponse,
				{ name },
			).pipe(Effect.map((response) => response.snapshotID)),
		kill: (providerSandboxId) =>
			requestVoid(
				"DELETE",
				`/sandboxes/${encodeURIComponent(providerSandboxId)}`,
				undefined,
				[404],
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => controlTokens.delete(providerSandboxId)),
				),
			),
		// Snapshots are stored as templates on the provider side.
		deleteSnapshot: (snapshotId) =>
			requestVoid(
				"DELETE",
				`/templates/${encodeURIComponent(snapshotId)}`,
				undefined,
				[404],
			),
	};
};
