import {
	APIStatusError,
	AuthenticationError,
	Boxd,
	ConflictError,
	type CreatedProxy,
	type CreatedSnapshot,
	type ExecParams,
	type ExecResult,
	type Machine,
	type MachineCreateParams,
	type MachineResizeParams,
	NotFoundError,
	PermissionDeniedError,
	type Proxy as ProxyRoute,
	type ResizeResult,
	type Snapshot,
	type UploadSource,
	type WaitUntilReadyParams,
} from "@boxd-sh/sdk/web";
import { measureCloudStage } from "@zuse/utils/cloud-timing";
import { Clock, Duration, Effect, Redacted } from "effect";
import { BOX_PORT_FORWARDER } from "./box-port-forwarder.ts";
import {
	boxProcessScript,
	boxProcessUnit,
	boxShellQuote,
	boxSystemdProcessCommand,
} from "./box-process.ts";
import type {
	ProviderSandbox,
	SandboxNetworkPolicy,
	SandboxProcessInput,
	SandboxProcessSelector,
	SandboxProviderAdapter,
	SandboxProviderError,
	SandboxProviderResources,
} from "./index.ts";
import { clampSeconds, providerError, validatedEnv } from "./provider-input.ts";
import { zuseSnapshotName } from "./snapshot-name.ts";

// boxd (boxd.sh) machines are KVM microVMs that hibernate with their memory:
// a paused workspace wakes in milliseconds with its runtime still running, so
// this adapter follows the warm E2B resume path rather than Boat's cold one.

export interface BoxdSandboxConfig {
	readonly apiKey: Redacted.Redacted<string>;
	/** Organization slug that owns every machine and snapshot; empty = the key's personal context. */
	readonly org?: string;
	/** Snapshot every workspace-less create boots from. */
	readonly templateSnapshot: string;
	readonly templateVersion: string;
	readonly machineSize?: BoxdMachineSize;
	/** gRPC-web endpoint; defaults to production. */
	readonly baseUrl?: string;
	readonly readyDeadlineMs?: number;
	readonly snapshotDeadlineMs?: number;
	readonly pollIntervalMs?: number;
}

/** The slice of `@boxd-sh/sdk/web` this adapter uses; tests inject an in-memory fake. */
export interface BoxdSandboxClient {
	readonly machines: {
		create(params: MachineCreateParams): Promise<Machine>;
		get(id: string): Promise<Machine>;
		delete(id: string): Promise<void>;
		start(id: string): Promise<void>;
		resume(id: string): Promise<{ resumeUs: number }>;
		hibernate(id: string): Promise<void>;
		wake(id: string): Promise<void>;
		resize(id: string, params: MachineResizeParams): Promise<ResizeResult>;
		setAutoHibernateTimeout(id: string, seconds: number): Promise<void>;
		exec(id: string, params: ExecParams): Promise<ExecResult>;
		waitUntilReady(id: string, params?: WaitUntilReadyParams): Promise<Machine>;
		readonly files: {
			upload(id: string, path: string, source: UploadSource): Promise<number>;
		};
		readonly proxies: {
			create(
				machine: string,
				name: string,
				port: number,
			): Promise<CreatedProxy>;
			list(machine: string): Promise<ProxyRoute[]>;
		};
	};
	readonly snapshots: {
		create(machine: string, name: string): Promise<CreatedSnapshot>;
		get(name: string, params?: { org?: string }): Promise<Snapshot>;
		delete(name: string, params?: { org?: string }): Promise<void>;
	};
}

export const BOXD_BASE_URL = "https://boxd.sh:9443";
export const BOXD_PROVIDER_ID = "boxd" as const;

export type BoxdMachineSize = "small" | "default" | "large";

export const BOXD_MACHINE_RESOURCES: Record<
	BoxdMachineSize,
	SandboxProviderResources
> = {
	small: { vcpuCount: 1, memoryMib: 4_096 },
	default: { vcpuCount: 2, memoryMib: 8_192 },
	large: { vcpuCount: 4, memoryMib: 16_384 },
};

const MACHINE_SIZES: ReadonlyArray<BoxdMachineSize> = [
	"small",
	"default",
	"large",
];
const RUNTIME_USER = "zuse";
const COMMAND_USER = "boxd";
const SECRETS_DIRECTORY = "/run/zuse-secrets";
const BOOT_ID_COMMAND = "cat /proc/sys/kernel/random/boot_id";
const MAX_TEXT_FILE_BYTES = 65_536;
const MIN_IDLE_SECONDS = 1;
const MAX_IDLE_SECONDS = 2_592_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MACHINE_NAME_MAX_LENGTH = 63;
const PARK_SETTLE_ATTEMPTS = 5;
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_ALREADY_EXISTS = 6;
const PAUSED_STATUSES = new Set<Machine["status"]>([
	"suspended",
	"hibernated",
	"stopped",
]);
const ABSENT_STATUSES = new Set<Machine["status"]>(["failed", "destroyed"]);

const shellQuote = boxShellQuote;

const fnv1a32 = (value: string): string => {
	let hash = 0x811c_9dc5;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x0100_0193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
};

/**
 * boxd machine names are DNS labels: lowercase letters, digits and hyphens,
 * at most 63 characters, not ending in a hyphen. Labels that already satisfy
 * that pass through, so `recoverByLabel` finds them by name; anything else is
 * lowercased and given a digest suffix so two labels that differ only in
 * case, or only by a trailing hyphen, stay distinct.
 */
export const boxdMachineName = (label: string): string => {
	const lowered = label
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]/gu, "-")
		.replaceAll(/-{2,}/gu, "-")
		.replace(/^-+/u, "");
	const named =
		lowered === label &&
		!label.endsWith("-") &&
		label.length <= MACHINE_NAME_MAX_LENGTH
			? lowered
			: `${lowered.slice(0, MACHINE_NAME_MAX_LENGTH - 9).replace(/-+$/u, "")}-${fnv1a32(label)}`;
	return named.slice(0, MACHINE_NAME_MAX_LENGTH).replace(/-+$/u, "");
};

const errorForCause = (cause: unknown): SandboxProviderError => {
	if (cause instanceof NotFoundError) return providerError("not-found");
	if (
		cause instanceof AuthenticationError ||
		cause instanceof PermissionDeniedError
	)
		return providerError("rejected");
	// FAILED_PRECONDITION covers state transitions ("is starting", "is
	// stopped"): retryable. ALREADY_EXISTS is a permanent answer.
	if (cause instanceof ConflictError)
		return providerError(
			cause.grpcCode === GRPC_ALREADY_EXISTS ? "rejected" : "transient",
		);
	if (cause instanceof APIStatusError)
		return providerError(
			cause.grpcCode === GRPC_INVALID_ARGUMENT ? "rejected" : "transient",
		);
	// Rate limits, connection failures, client-side deadlines (exec timeout).
	return providerError("transient");
};

const reportRequestFailure = (method: string, cause: unknown): void => {
	console.warn("[zuse:sandbox-provider] request failed", {
		provider: BOXD_PROVIDER_ID,
		method,
		error: cause instanceof Error ? cause.constructor.name : typeof cause,
		grpcCode:
			cause instanceof Error && "grpcCode" in cause
				? Reflect.get(cause, "grpcCode")
				: undefined,
	});
};

const machineSizeOf = (machine: Machine): BoxdMachineSize | undefined =>
	MACHINE_SIZES.find(
		(size) => BOXD_MACHINE_RESOURCES[size].vcpuCount === machine.resources.vcpu,
	);

// boxd has no per-machine network policy; every machine is `isolated` (no
// peers, no in-VM control plane) with open egress. Reject anything else
// before allocating rather than silently granting unrestricted access.
const validateNetwork = (network: SandboxNetworkPolicy) =>
	network.kind === "open"
		? Effect.void
		: Effect.fail(providerError("rejected"));

// Snapshot restores replay the captured machine and refuse create-time env.
// Every caller passes an empty map; a non-empty one would be silently lost.
const validateCreateEnv = (env: Readonly<Record<string, string>>) =>
	Object.keys(env).length === 0
		? Effect.void
		: Effect.fail(providerError("rejected"));

const clampIdleSeconds = (timeoutSeconds: number): number =>
	clampSeconds(timeoutSeconds, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS);

const clients = new Map<string, BoxdSandboxClient>();

/**
 * The API constructs its provider registry per request, and every SDK client
 * exchanges the API key for a session token on first use. Sharing one client
 * per credential keeps that exchange off the request path.
 */
/**
 * The SDK slices the scheme off the base URL and uses the rest as the host of
 * every `${host}/${service}/${method}` request, so a trailing slash would put
 * `//` in each path.
 */
export const boxdBaseUrl = (value: string | undefined): string =>
	(value ?? BOXD_BASE_URL).replace(/\/+$/u, "");

export const boxdSandboxClientFor = (
	config: Pick<BoxdSandboxConfig, "apiKey" | "baseUrl">,
): BoxdSandboxClient => {
	const baseURL = boxdBaseUrl(config.baseUrl);
	const key = `${baseURL}\u0000${Redacted.value(config.apiKey)}`;
	const existing = clients.get(key);
	if (existing !== undefined) return existing;
	const created = new Boxd({ apiKey: Redacted.value(config.apiKey), baseURL });
	clients.set(key, created);
	return created;
};

export const makeBoxdSandboxProvider = (
	config: BoxdSandboxConfig,
	client: BoxdSandboxClient = boxdSandboxClientFor(config),
): SandboxProviderAdapter => {
	const org = config.org;
	const machineSize = config.machineSize ?? "default";
	const readyDeadlineMs = config.readyDeadlineMs ?? 120_000;
	// A first capture of an 8 GiB machine takes about a minute; re-saves of
	// the same name are incremental. Keep the request retryable, but do not
	// abandon a healthy in-flight save on a short interactive deadline.
	const snapshotDeadlineMs = config.snapshotDeadlineMs ?? 30 * 60_000;
	const pollIntervalMs = config.pollIntervalMs ?? 2_000;
	const timing = (providerSandboxId: string, stage: string) =>
		measureCloudStage({ provider: BOXD_PROVIDER_ID, providerSandboxId }, stage);

	const call = <A>(
		method: string,
		run: () => Promise<A>,
	): Effect.Effect<A, SandboxProviderError> =>
		Effect.tryPromise({
			try: run,
			catch: (cause) => {
				reportRequestFailure(method, cause);
				return errorForCause(cause);
			},
		});

	// A lifecycle request answered with a state conflict already holds: the
	// machine parked or woke on its own. Rate limits and outages still fail.
	const callTolerantOfConflict = (
		method: string,
		run: () => Promise<unknown>,
	): Effect.Effect<void, SandboxProviderError> =>
		Effect.tryPromise({
			try: async () => {
				try {
					await run();
				} catch (cause) {
					if (!(cause instanceof ConflictError)) throw cause;
				}
			},
			catch: (cause) => {
				reportRequestFailure(method, cause);
				return errorForCause(cause);
			},
		});

	const runCommand = (
		providerSandboxId: string,
		command: string,
		timeoutMs = COMMAND_TIMEOUT_MS,
	): Effect.Effect<ExecResult, SandboxProviderError> =>
		call("machines.exec", () =>
			client.machines.exec(providerSandboxId, { command, timeout: timeoutMs }),
		);

	const machine = (
		providerSandboxId: string,
	): Effect.Effect<Machine, SandboxProviderError> =>
		call("machines.get", () => client.machines.get(providerSandboxId));

	const ready = (
		providerSandboxId: string,
	): Effect.Effect<Machine, SandboxProviderError> =>
		call("machines.waitUntilReady", () =>
			client.machines.waitUntilReady(providerSandboxId, {
				timeout: readyDeadlineMs,
				pollInterval: Math.min(pollIntervalMs, 500),
			}),
		);

	const toProviderSandbox = (found: Machine): ProviderSandbox => ({
		providerSandboxId: found.id,
		providerLabel: found.name,
		state: PAUSED_STATUSES.has(found.status) ? "paused" : "running",
	});

	// Booting, migrating and unknown states stay retryable; failed or
	// destroyed machines are reported absent so the caller replaces them.
	const settledSandbox = (
		found: Machine,
	): Effect.Effect<ProviderSandbox | null, SandboxProviderError> =>
		found.status === "running" || PAUSED_STATUSES.has(found.status)
			? Effect.succeed(toProviderSandbox(found))
			: ABSENT_STATUSES.has(found.status)
				? Effect.succeed(null)
				: Effect.fail(providerError("transient"));

	const kill = (
		providerSandboxId: string,
	): Effect.Effect<void, SandboxProviderError> =>
		call("machines.delete", () =>
			client.machines.delete(providerSandboxId),
		).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.void : Effect.fail(error),
			),
		);

	const machineSizeFor = (
		sizeId: string | undefined,
	): Effect.Effect<BoxdMachineSize, SandboxProviderError> =>
		sizeId === undefined
			? Effect.succeed(machineSize)
			: sizeId === "small" || sizeId === "default" || sizeId === "large"
				? Effect.succeed(sizeId)
				: Effect.fail(providerError("rejected"));

	// A restore keeps the size its snapshot was captured at; a different
	// placement is applied afterwards as a cold reboot (~3 s). Publishing the
	// template at the deployment's default size makes this a no-op.
	const bootId = (providerSandboxId: string) =>
		runCommand(providerSandboxId, BOOT_ID_COMMAND).pipe(
			Effect.map((result) => result.stdout.trim()),
		);

	// `resize` answers before its reboot lands, and readiness alone can be
	// satisfied by the instance that is about to go away, so a resize is only
	// complete once the machine reports a new boot.
	const applySize = Effect.fn("BoxdSandboxProvider.applySize")(function* (
		current: Machine,
		size: BoxdMachineSize,
	) {
		if (machineSizeOf(current) === size) return current;
		const before = yield* bootId(current.id);
		const resized = yield* call("machines.resize", () =>
			client.machines.resize(current.id, {
				vcpu: BOXD_MACHINE_RESOURCES[size].vcpuCount,
			}),
		);
		if (!resized.rebooted) return yield* machine(current.id);
		const deadline = (yield* Clock.currentTimeMillis) + readyDeadlineMs;
		while (true) {
			const after = yield* ready(current.id);
			if ((yield* bootId(current.id)) !== before) return after;
			if ((yield* Clock.currentTimeMillis) >= deadline)
				return yield* providerError("transient");
			yield* Effect.sleep(Duration.millis(pollIntervalMs));
		}
	});

	// A cold boot (fresh create after resize, start after stop) reports exec
	// readiness before systemd finished booting, and tagged launches need the
	// bus. The secrets directory lives on tmpfs, so it is recreated each time.
	const prepareRuntime = Effect.fn("BoxdSandboxProvider.prepareRuntime")(
		function* (providerSandboxId: string) {
			const result = yield* runCommand(
				providerSandboxId,
				[
					"timeout 90 systemctl is-system-running --wait >/dev/null 2>&1 || true",
					`sudo -n install -d -m 0700 -o ${RUNTIME_USER} -g ${RUNTIME_USER} ${SECRETS_DIRECTORY}`,
				].join(" && "),
				120_000,
			);
			if (result.exitCode !== 0) return yield* providerError("transient");
		},
	);

	// The reconciler gives a freshly allocated machine ten seconds to enroll,
	// and a restored VM spends its first seconds paging: on a fresh restore the
	// runtime took 2.7 s to listen (3.8 s with cold caches, 1.4 s warm) and the
	// first transient unit 0.6 s (16 ms warm). Loading the runtime once and
	// starting one unit moves that cost ahead of the enrollment window. Best
	// effort: a template without the runtime on PATH still allocates.
	const primeRuntime = Effect.fn("BoxdSandboxProvider.primeRuntime")(function* (
		providerSandboxId: string,
	) {
		yield* runCommand(
			providerSandboxId,
			[
				`sudo -n -u ${RUNTIME_USER} -H bash -c ${shellQuote(
					"cd / && timeout 30 zuse --version >/dev/null 2>&1",
				)}`,
				`sudo -n systemd-run --quiet --collect --wait --uid=${RUNTIME_USER} -- /bin/true >/dev/null 2>&1`,
				"true",
			].join("; "),
		).pipe(Effect.ignore);
	});

	// Every API key is fenced to one organization, so a name resolves in the
	// same context the adapter creates in.
	const findByName = (
		name: string,
	): Effect.Effect<Machine | null, SandboxProviderError> =>
		machine(name).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
			),
		);

	// Names are unique, so a machine that failed keeps its label wedged until
	// it is deleted. Callers that see "absent" allocate a replacement.
	const settledByName = Effect.fn("BoxdSandboxProvider.settledByName")(
		function* (name: string) {
			const found = yield* findByName(name);
			if (found === null) return null;
			if (found.status === "failed") {
				yield* kill(found.id);
				return null;
			}
			return found;
		},
	);

	const allocate = Effect.fn("BoxdSandboxProvider.allocate")(function* (input: {
		readonly providerLabel: string;
		readonly snapshot: string;
		readonly sizeId?: string;
		readonly timeoutSeconds: number;
		readonly env: Readonly<Record<string, string>>;
		readonly network: SandboxNetworkPolicy;
		readonly onTimeout: "pause" | "terminate";
	}) {
		yield* validateNetwork(input.network);
		yield* validateCreateEnv(input.env);
		const size = yield* machineSizeFor(input.sizeId);
		const name = boxdMachineName(input.providerLabel);
		if (!MACHINE_NAME_PATTERN.test(name))
			return yield* providerError("rejected");
		const idleSeconds = clampIdleSeconds(input.timeoutSeconds);
		// Every machine is isolated: no peers, no metadata endpoint, no in-VM
		// boxd CLI or integrations. Auto-suspend stays off so the runtime's
		// outbound gateway connection never freezes under it; the caller's
		// timeout becomes the hibernate (pause) or destroy (terminate) timer.
		// ALREADY_EXISTS is the one create failure worth a second look: the
		// label is the machine name, so a retried create after a lost response
		// adopts the machine the first attempt made, and a failed one is
		// deleted and replaced. Every other failure ends this attempt.
		const createMachine = Effect.tryPromise({
			try: async () => {
				try {
					return await client.machines.create({
						name,
						...(org === undefined ? {} : { org }),
						fromSnapshot: input.snapshot,
						isolated: true,
						config: {
							autoSuspendTimeout: 0,
							...(input.onTimeout === "terminate"
								? { autoDestroyTimeout: idleSeconds }
								: {}),
						},
					});
				} catch (cause) {
					if (
						cause instanceof ConflictError &&
						cause.grpcCode === GRPC_ALREADY_EXISTS
					)
						return null;
					throw cause;
				}
			},
			catch: (cause) => {
				reportRequestFailure("machines.create", cause);
				return errorForCause(cause);
			},
		});
		const created =
			(yield* createMachine) ??
			(yield* settledByName(name).pipe(
				Effect.flatMap((existing) =>
					existing !== null
						? Effect.succeed(existing)
						: createMachine.pipe(
								Effect.flatMap((again) =>
									again === null
										? Effect.fail(providerError("transient"))
										: Effect.succeed(again),
								),
							),
				),
			));
		// Arm the idle timer before waiting, so a machine that never answers
		// is not left on the organization default. One that never becomes
		// usable would keep its label wedged; delete it so the retry starts
		// fresh instead of adopting it and timing out again.
		if (input.onTimeout === "pause")
			yield* call("machines.setAutoHibernateTimeout", () =>
				client.machines.setAutoHibernateTimeout(created.id, idleSeconds),
			);
		const usable = yield* ready(created.id).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				kill(created.id).pipe(
					Effect.ignore,
					Effect.andThen(Effect.fail(error)),
				),
			),
		);
		yield* applySize(usable, size);
		yield* prepareRuntime(created.id);
		yield* primeRuntime(created.id);
		return {
			providerSandboxId: created.id,
			providerLabel: input.providerLabel,
			state: "running",
		} satisfies ProviderSandbox;
	});

	const startManagedProcess = Effect.fn(
		"BoxdSandboxProvider.startManagedProcess",
	)(function* (
		providerSandboxId: string,
		input: SandboxProcessInput,
		tag: string,
		selector?: SandboxProcessSelector,
	) {
		yield* validatedEnv(input.env ?? {});
		const user = input.user ?? COMMAND_USER;
		const unit = boxProcessUnit(user, tag);
		if (unit.length > 255) return yield* providerError("rejected");
		const result = yield* runCommand(
			providerSandboxId,
			boxSystemdProcessCommand({ ...input, tag, user }, unit, selector),
		);
		if (result.exitCode !== 0) return yield* providerError("transient");
	});

	const startProcess = Effect.fn("BoxdSandboxProvider.startProcess")(function* (
		providerSandboxId: string,
		input: SandboxProcessInput,
	) {
		if (input.tag !== undefined)
			return yield* startManagedProcess(providerSandboxId, input, input.tag);
		yield* validatedEnv(input.env ?? {});
		const user = input.user ?? COMMAND_USER;
		// Untagged build commands run detached in their own session; the exec
		// returns as soon as the launcher shell backgrounds them.
		const result = yield* runCommand(
			providerSandboxId,
			`sudo -n -E -H -u ${shellQuote(user)} setsid bash -c ${shellQuote(boxProcessScript(input))} >/dev/null 2>&1 </dev/null &`,
		);
		if (result.exitCode !== 0) return yield* providerError("transient");
	});

	const replaceProcess = (
		providerSandboxId: string,
		selector: SandboxProcessSelector,
		input: SandboxProcessInput,
	) => startManagedProcess(providerSandboxId, input, selector.tag, selector);

	const pathExists = Effect.fn("BoxdSandboxProvider.pathExists")(function* (
		providerSandboxId: string,
		path: string,
	) {
		const result = yield* runCommand(
			providerSandboxId,
			`sudo -n test -e ${shellQuote(path)}`,
		);
		if (result.exitCode === 0) return true;
		if (result.exitCode === 1) return false;
		return yield* providerError("transient");
	});

	const readTextFile = Effect.fn("BoxdSandboxProvider.readTextFile")(function* (
		providerSandboxId: string,
		path: string,
	) {
		// Read one byte past the cap so an oversized file is rejected without
		// transferring it.
		const result = yield* runCommand(
			providerSandboxId,
			`sudo -n head -c ${MAX_TEXT_FILE_BYTES + 1} ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) return yield* providerError("not-found");
		if (
			new TextEncoder().encode(result.stdout).byteLength > MAX_TEXT_FILE_BYTES
		)
			return yield* providerError("rejected");
		return result.stdout;
	});

	const writeTextFile = Effect.fn("BoxdSandboxProvider.writeTextFile")(
		function* (
			providerSandboxId: string,
			path: string,
			contents: string,
			user?: string,
		) {
			if (
				!path.startsWith("/") ||
				new TextEncoder().encode(contents).byteLength > MAX_TEXT_FILE_BYTES
			)
				return yield* providerError("rejected");
			// Uploads land as the command user; stage in /tmp, then install
			// with owner-only permissions and parents created.
			const stagingPath = `/tmp/.zuse-write-${crypto.randomUUID()}`;
			yield* call("machines.files.upload", () =>
				client.machines.files.upload(providerSandboxId, stagingPath, contents),
			);
			const owner = user ?? COMMAND_USER;
			// Missing parents are created as the owner so the runtime user can
			// keep writing beside the file; a parent it may not create is made
			// by root, as before.
			const directory = path.slice(0, path.lastIndexOf("/")) || "/";
			const install = yield* runCommand(
				providerSandboxId,
				`(sudo -n -u ${shellQuote(owner)} mkdir -p ${shellQuote(directory)} 2>/dev/null || sudo -n install -d -m 0755 ${shellQuote(directory)}) && sudo -n install -m 600 -o ${shellQuote(owner)} -g ${shellQuote(
					owner,
				)} ${shellQuote(stagingPath)} ${shellQuote(path)} && sudo -n rm -f ${shellQuote(stagingPath)}`,
			);
			if (install.exitCode !== 0) return yield* providerError("transient");
		},
	);

	const inspect = (
		providerSandboxId: string,
	): Effect.Effect<ProviderSandbox | null, SandboxProviderError> =>
		machine(providerSandboxId).pipe(
			Effect.flatMap(settledSandbox),
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
			),
		);

	const recoverByLabel = Effect.fn("BoxdSandboxProvider.recoverByLabel")(
		function* (providerLabel: string) {
			const found = yield* settledByName(boxdMachineName(providerLabel));
			return found === null ? null : yield* settledSandbox(found);
		},
	);

	// Proxies reach the VM interface while the runtime binds loopback, so the
	// shared forwarder bridges them; it is idempotent and re-binds the fresh
	// interface address a restore or fork receives. The route itself is
	// inherited from the template snapshot for the runtime port and created
	// on demand for preview ports.
	const resolveEndpoint = Effect.fn("BoxdSandboxProvider.resolveEndpoint")(
		function* (providerSandboxId: string, port: number) {
			const forwarded = yield* runCommand(
				providerSandboxId,
				`node -e ${shellQuote(BOX_PORT_FORWARDER)} ${port}`,
			);
			if (forwarded.exitCode !== 0) return yield* providerError("transient");
			const routeName = `p${port}`;
			const listRoutes = call("machines.proxies.list", () =>
				client.machines.proxies.list(providerSandboxId),
			);
			let routes = yield* listRoutes;
			let creation: SandboxProviderError | undefined;
			if (!routes.some((route) => route.name === routeName)) {
				// A concurrent resolution may have created it first; only a route
				// that is still missing afterwards makes the failure the answer.
				creation = yield* call("machines.proxies.create", () =>
					client.machines.proxies.create(providerSandboxId, routeName, port),
				).pipe(
					Effect.as(undefined),
					Effect.catchTag("SandboxProviderError", (error) =>
						Effect.succeed(error),
					),
				);
				routes = yield* listRoutes;
			}
			const route = routes.find((candidate) => candidate.name === routeName);
			if (route === undefined)
				return yield* creation ?? providerError("transient");
			return {
				httpBaseUrl: `https://${route.domain}`,
				wsBaseUrl: `wss://${route.domain}`,
			};
		},
	);

	const resume = Effect.fn("BoxdSandboxProvider.resume")(function* (
		providerSandboxId: string,
		timeoutSeconds: number,
		onTimeout: "pause" | "terminate",
		sizeId?: string,
	) {
		const current = yield* machine(providerSandboxId);
		if (ABSENT_STATUSES.has(current.status))
			return yield* providerError("not-found");
		// A machine that woke on its own (inbound traffic) answers with a
		// state conflict; that is success.
		const wake =
			current.status === "hibernated"
				? callTolerantOfConflict("machines.wake", () =>
						client.machines.wake(providerSandboxId),
					)
				: current.status === "suspended"
					? callTolerantOfConflict("machines.resume", () =>
							client.machines.resume(providerSandboxId),
						)
					: current.status === "stopped"
						? callTolerantOfConflict("machines.start", () =>
								client.machines.start(providerSandboxId),
							)
						: Effect.void;
		yield* wake.pipe(timing(providerSandboxId, "boxd.resume.request"));
		const usable = yield* ready(providerSandboxId).pipe(
			timing(providerSandboxId, "boxd.resume.usable"),
		);
		if (onTimeout === "pause")
			yield* call("machines.setAutoHibernateTimeout", () =>
				client.machines.setAutoHibernateTimeout(
					providerSandboxId,
					clampIdleSeconds(timeoutSeconds),
				),
			);
		// A stopped machine boots cold and a resize reboots: the runtime is
		// gone either way, and the reconciler's warm reconnect window expires
		// into the fenced restart. Neither happens on the adapter's own paths.
		const sized =
			sizeId === undefined
				? usable
				: yield* applySize(usable, yield* machineSizeFor(sizeId));
		yield* prepareRuntime(providerSandboxId).pipe(
			timing(providerSandboxId, "boxd.resume.prepare"),
		);
		// Only a cold boot lost its page cache and runtime; a wake keeps both.
		if (current.status === "stopped" || sized !== usable)
			yield* primeRuntime(providerSandboxId).pipe(
				timing(providerSandboxId, "boxd.resume.prime"),
			);
		return toProviderSandbox(sized);
	});

	// Hibernate only a running machine, and confirm it parked: a machine
	// still booting answers with a state conflict that must not be mistaken
	// for "already parked", and inbound traffic can wake it straight back.
	const pause = Effect.fn("BoxdSandboxProvider.pause")(function* (
		providerSandboxId: string,
	) {
		const current = yield* machine(providerSandboxId);
		if (ABSENT_STATUSES.has(current.status))
			return yield* providerError("not-found");
		if (PAUSED_STATUSES.has(current.status)) return;
		if (current.status !== "running") return yield* providerError("transient");
		yield* callTolerantOfConflict("machines.hibernate", () =>
			client.machines.hibernate(providerSandboxId),
		);
		for (let attempt = 0; attempt < PARK_SETTLE_ATTEMPTS; attempt++) {
			const after = yield* machine(providerSandboxId);
			if (PAUSED_STATUSES.has(after.status)) return;
			yield* Effect.sleep(Duration.millis(pollIntervalMs));
		}
		return yield* providerError("transient");
	});

	const snapshotStatus = (target: string) =>
		call("snapshots.get", () =>
			client.snapshots.get(target, org === undefined ? undefined : { org }),
		).pipe(
			Effect.map((info) => info.status),
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found"
					? Effect.succeed("missing" as const)
					: Effect.fail(error),
			),
		);

	const deleteSnapshot = (
		snapshotId: string,
	): Effect.Effect<void, SandboxProviderError> =>
		call("snapshots.delete", () =>
			client.snapshots.delete(
				snapshotId,
				org === undefined ? undefined : { org },
			),
		).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.void : Effect.fail(error),
			),
		);

	const snapshot = Effect.fn("BoxdSandboxProvider.snapshot")(function* (
		providerSandboxId: string,
		name: string,
	) {
		const target = zuseSnapshotName(name);
		if (target === "") return yield* providerError("rejected");
		const status = yield* snapshotStatus(target);
		if (status === "ready") return target;
		if (status === "failed") yield* deleteSnapshot(target);
		if (status === "missing" || status === "failed")
			yield* call("snapshots.create", () =>
				client.snapshots.create(providerSandboxId, target),
			);
		// Capturing memory and disk takes up to a minute; retries land back
		// here and resume polling the same in-flight save.
		const attempts = Math.max(
			1,
			Math.ceil(snapshotDeadlineMs / pollIntervalMs),
		);
		for (let attempt = 0; attempt < attempts; attempt++) {
			const polled = yield* snapshotStatus(target).pipe(
				Effect.catchTag("SandboxProviderError", (error) =>
					error.code === "transient"
						? Effect.succeed("pending" as const)
						: Effect.fail(error),
				),
			);
			if (polled === "ready") return target;
			if (polled === "failed") return yield* providerError("transient");
			yield* Effect.sleep(Duration.millis(pollIntervalMs));
		}
		return yield* providerError("transient");
	});

	return {
		providerId: BOXD_PROVIDER_ID,
		displayName: "boxd",
		templateVersion: config.templateVersion,
		preservesProcessesOnResume: true,
		resources: BOXD_MACHINE_RESOURCES[machineSize],
		sizes: [
			machineSize,
			...MACHINE_SIZES.filter((sizeId) => sizeId !== machineSize),
		].map((sizeId) => ({
			sizeId,
			displayName:
				sizeId === "small"
					? "Small (1 vCPU / 4 GB)"
					: sizeId === "default"
						? "Standard (2 vCPU / 8 GB)"
						: "Large (4 vCPU / 16 GB)",
			...BOXD_MACHINE_RESOURCES[sizeId],
		})),
		create: (input) =>
			allocate({
				providerLabel: input.providerLabel,
				snapshot: config.templateSnapshot,
				sizeId: input.sizeId,
				timeoutSeconds: input.timeoutSeconds,
				env: input.env,
				network: input.network,
				onTimeout: input.onTimeout,
			}),
		// Account images are snapshots; a restore boots into the captured
		// state in milliseconds with its memory intact.
		fork: (input) =>
			allocate({
				providerLabel: input.providerLabel,
				snapshot: input.snapshotId,
				sizeId: input.sizeId,
				timeoutSeconds: input.timeoutSeconds,
				env: input.env,
				network: input.network,
				onTimeout: input.onTimeout,
			}),
		recoverByLabel,
		startProcess,
		replaceProcess,
		pathExists,
		readTextFile,
		writeTextFile,
		inspect,
		resolveEndpoint,
		// Hibernate writes memory to disk: effectively free while parked and
		// ~85 ms to wake with every process intact.
		pause,
		resume,
		extendTimeout: (providerSandboxId, timeoutSeconds) =>
			call("machines.setAutoHibernateTimeout", () =>
				client.machines.setAutoHibernateTimeout(
					providerSandboxId,
					clampIdleSeconds(timeoutSeconds),
				),
			),
		setNetwork: (_providerSandboxId, network) => validateNetwork(network),
		snapshot,
		kill,
		deleteSnapshot,
	};
};
