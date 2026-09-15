import { Duration, Effect, Redacted, Schema } from "effect";
import { BOX_PORT_FORWARDER } from "./box-port-forwarder.ts";
import {
	type ProviderSandbox,
	type SandboxNetworkPolicy,
	type SandboxProcessInput,
	type SandboxProcessSelector,
	type SandboxProviderAdapter,
	SandboxProviderError,
	type SandboxProviderResources,
} from "./index.ts";

// Box (box.ascii.dev) sandbox adapter. Boxes are full Ubuntu VMs restored from
// disk snapshots: every create, fork, and resume is a cold boot — no memory
// state survives. The provider exposes no host-level network policy API, so
// the egress barrier is the template-baked `zuse-firewall` unit: it boots into
// default-deny egress and only `setNetwork` (running the root-only firewall
// script through the provider command channel) can widen it. The agent user
// has no sudo, so guest code cannot lift the barrier
// (ADR 0033 amendment for the `box` provider).

const BoxDetail = Schema.Struct({
	id: Schema.String,
	name: Schema.optional(Schema.NullOr(Schema.String)),
	state: Schema.String,
	subdomain: Schema.optional(Schema.NullOr(Schema.String)),
});
type BoxDetail = Schema.Schema.Type<typeof BoxDetail>;

const BoxInfoResponse = Schema.Struct({ box: BoxDetail });
const BoxListResponse = Schema.Struct({
	boxes: Schema.Array(BoxDetail),
	pageInfo: Schema.optional(
		Schema.Struct({ nextCursor: Schema.NullOr(Schema.String) }),
	),
});
const NonnegativeFinite = Schema.Number.check(
	Schema.makeFilter((value) => Number.isFinite(value) && value >= 0),
);
const BoxUsageResponse = Schema.Struct({
	ok: Schema.Literal(true),
	type: Schema.Literal("box.usage"),
	boxId: Schema.String,
	boxType: Schema.Literals(["small", "default", "large", "xlarge"]),
	billingMultiplier: NonnegativeFinite.check(Schema.isGreaterThan(0)),
	since: Schema.String,
	until: Schema.String,
	seconds: NonnegativeFinite.check(Schema.makeFilter(Number.isSafeInteger)),
	dollars: NonnegativeFinite,
	secondsPerDollar: NonnegativeFinite.check(
		Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0),
	),
	running: Schema.Boolean,
});

const CommandFinishedResponse = Schema.Struct({
	exitCode: Schema.NullOr(Schema.Number),
	stdout: Schema.String,
	stderr: Schema.String,
	stdoutTruncated: Schema.optional(Schema.Boolean),
	timedOut: Schema.Boolean,
});
type CommandFinishedResponse = Schema.Schema.Type<
	typeof CommandFinishedResponse
>;
const CommandStartedResponse = Schema.Struct({
	processId: Schema.Number,
});
const NamedSnapshotInfoResponse = Schema.Struct({
	snapshot: Schema.Struct({
		name: Schema.String,
		status: Schema.Literals(["saving", "ready", "failed"]),
	}),
});

export interface BoxSandboxConfig {
	readonly apiKey: Redacted.Redacted<string>;
	/** Named snapshot every workspace-less create boots from. */
	readonly templateSnapshot: string;
	readonly templateVersion: string;
	readonly machineType?: BoxMachineType;
	readonly apiBaseUrl?: string;
	/** Domain suffix of `host <port>` URLs, without the subdomain. */
	readonly hostedPortDomain?: string;
	readonly readyDeadlineMs?: number;
	readonly snapshotDeadlineMs?: number;
	readonly pollIntervalMs?: number;
}

export interface BoxHttpClient {
	readonly fetch: typeof globalThis.fetch;
}

const defaultHttpClient: BoxHttpClient = {
	fetch: (input, init) => globalThis.fetch(input, init),
};

export const BOX_API_BASE_URL = "https://ascii.dev/api/box/v1";
export const BOX_DEFAULT_HOSTED_PORT_DOMAIN = "on.ascii.dev";
export const BOX_PROVIDER_ID = "box" as const;
/** Root-only policy script baked into the base template. */
export const BOX_FIREWALL_COMMAND = "/usr/local/sbin/zuse-firewall";
const BOX_PERSISTED_POLICY_FILE = "/var/lib/zuse-firewall/policy.b64";
const BOX_PERSISTED_RUNTIME_ROOT = "/srv/zuse";
const BOX_PERSISTED_RUNTIME_MARKER = `${BOX_PERSISTED_RUNTIME_ROOT}/.layout-v1`;

export type BoxMachineType = "small" | "default" | "large";

export const BOX_MACHINE_RESOURCES: Record<
	BoxMachineType,
	SandboxProviderResources
> = {
	small: { vcpuCount: 2, memoryMib: 4_096 },
	default: { vcpuCount: 4, memoryMib: 8_192 },
	large: { vcpuCount: 8, memoryMib: 16_384 },
};

const USABLE_STATES = new Set(["ready", "idle", "running"]);
const PAUSED_STATES = new Set(["archiving", "archived"]);
const RECOVERABLE_STATES =
	"init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived";
const MAX_RECOVERY_PAGES = 10;
const MAX_TEXT_FILE_BYTES = 65_536;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 2_592_000;
const RETRYABLE_CONFLICT_CODES = new Set([
	"box_starting",
	"save_in_progress",
	"stop_in_progress",
]);

const providerError = (
	code: SandboxProviderError["code"],
): SandboxProviderError => new SandboxProviderError({ code });

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

const errorForStatus = (
	status: number,
	errorCode?: string,
): SandboxProviderError => {
	if (status === 404) return providerError("not-found");
	if (status === 409)
		return providerError(
			errorCode !== undefined && RETRYABLE_CONFLICT_CODES.has(errorCode)
				? "transient"
				: "rejected",
		);
	if (
		status === 400 ||
		status === 401 ||
		status === 402 ||
		status === 403 ||
		status === 422
	)
		return providerError("rejected");
	return providerError("transient");
};

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'\\''`)}'`;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const processTagFile = (tag: string): string =>
	`${tag.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}.pid`;

const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const snapshotName = (name: string): string => {
	const sanitized = `zuse-${name.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-")}`
		.replaceAll(/-{2,}/gu, "-")
		.slice(0, 63)
		.replace(/-+$/u, "");
	return SNAPSHOT_NAME_PATTERN.test(sanitized) ? sanitized : "";
};

const networkPolicyArgument = (network: SandboxNetworkPolicy): string => {
	const payload =
		network.kind === "restricted"
			? {
					kind: "restricted",
					allowOut: network.allowOut,
					denyOut: network.denyOut,
				}
			: { kind: network.kind };
	return btoa(JSON.stringify(payload));
};

export const makeBoxSandboxProvider = (
	config: BoxSandboxConfig,
	http: BoxHttpClient = defaultHttpClient,
): SandboxProviderAdapter => {
	const apiBaseUrl = (config.apiBaseUrl ?? BOX_API_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const hostedPortDomain =
		config.hostedPortDomain ?? BOX_DEFAULT_HOSTED_PORT_DOMAIN;
	const machineType = config.machineType ?? "small";
	const readyDeadlineMs = config.readyDeadlineMs ?? 120_000;
	// Box named snapshots commonly take longer than ten minutes for the full
	// runtime image. Keep the request retryable, but do not abandon a healthy
	// in-flight save on a short interactive-operation deadline.
	const snapshotDeadlineMs = config.snapshotDeadlineMs ?? 30 * 60_000;
	const pollIntervalMs = config.pollIntervalMs ?? 2_000;

	const send = (
		method: string,
		path: string,
		body?: unknown,
		headers?: Readonly<Record<string, string>>,
		timeoutMs?: number,
	): Effect.Effect<Response, SandboxProviderError> =>
		Effect.tryPromise({
			try: () =>
				http.fetch(`${apiBaseUrl}${path}`, {
					method,
					redirect: "error",
					signal:
						timeoutMs === undefined
							? undefined
							: AbortSignal.timeout(timeoutMs),
					headers: {
						authorization: `Bearer ${Redacted.value(config.apiKey)}`,
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
						...headers,
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => {
				reportRequestFailure({ method, phase: "network" });
				return providerError("transient");
			},
		});

	const responseErrorCode = (response: Response): Promise<string | undefined> =>
		response
			.clone()
			.json()
			.then((payload: unknown) =>
				typeof payload === "object" &&
				payload !== null &&
				typeof Reflect.get(payload, "code") === "string"
					? (Reflect.get(payload, "code") as string)
					: undefined,
			)
			.catch(() => undefined);

	const failForResponse = (
		method: string,
		response: Response,
	): Effect.Effect<never, SandboxProviderError> =>
		Effect.promise(() => responseErrorCode(response)).pipe(
			Effect.flatMap((errorCode) => {
				reportRequestFailure({
					method,
					phase: "response",
					status: response.status,
				});
				return Effect.fail(errorForStatus(response.status, errorCode));
			}),
		);

	const request = <A, I>(
		method: string,
		path: string,
		schema: Schema.Codec<A, I>,
		body?: unknown,
		timeoutMs?: number,
	): Effect.Effect<A, SandboxProviderError> =>
		send(method, path, body, undefined, timeoutMs).pipe(
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
		headers?: Readonly<Record<string, string>>,
	): Effect.Effect<void, SandboxProviderError> =>
		send(method, path, body, headers).pipe(
			Effect.flatMap((response) =>
				response.ok || toleratedStatuses.includes(response.status)
					? Effect.void
					: failForResponse(method, response),
			),
		);

	const toProviderSandbox = (detail: BoxDetail): ProviderSandbox => ({
		providerSandboxId: detail.id,
		providerLabel: detail.name ?? "",
		state: PAUSED_STATES.has(detail.state) ? "paused" : "running",
	});

	const boxDetail = (
		providerSandboxId: string,
	): Effect.Effect<BoxDetail, SandboxProviderError> =>
		request(
			"GET",
			`/boxes/${encodeURIComponent(providerSandboxId)}`,
			BoxInfoResponse,
		).pipe(Effect.map((response) => response.box));

	const kill = (
		providerSandboxId: string,
	): Effect.Effect<void, SandboxProviderError> =>
		requestVoid(
			"DELETE",
			`/boxes/${encodeURIComponent(providerSandboxId)}`,
			undefined,
			[404],
			{ "x-ascii-confirm-delete": providerSandboxId },
		);

	const runCommand = (
		providerSandboxId: string,
		command: string,
		timeoutSeconds = 60,
	): Effect.Effect<CommandFinishedResponse, SandboxProviderError> =>
		request(
			"POST",
			`/boxes/${encodeURIComponent(providerSandboxId)}/commands`,
			CommandFinishedResponse,
			{ command, timeoutSeconds },
		).pipe(
			Effect.flatMap((result) =>
				result.timedOut
					? Effect.fail(providerError("transient"))
					: Effect.succeed(result),
			),
		);

	const pollUntilUsable = Effect.fn("BoxSandboxProvider.pollUntilUsable")(
		function* (providerSandboxId: string, deadlineMs: number) {
			const attempts = Math.max(1, Math.ceil(deadlineMs / pollIntervalMs));
			for (let attempt = 0; attempt < attempts; attempt++) {
				const detail = yield* boxDetail(providerSandboxId).pipe(
					Effect.catchTag("SandboxProviderError", (error) =>
						error.code === "transient"
							? Effect.succeed(null)
							: Effect.fail(error),
					),
				);
				if (detail !== null) {
					if (USABLE_STATES.has(detail.state)) return detail;
					if (detail.state === "error") {
						yield* kill(providerSandboxId).pipe(Effect.ignore);
						return yield* providerError("rejected");
					}
				}
				yield* Effect.sleep(Duration.millis(pollIntervalMs));
			}
			return yield* providerError("transient");
		},
	);

	const applyNetworkPolicy = (
		providerSandboxId: string,
		network: SandboxNetworkPolicy,
	): Effect.Effect<void, SandboxProviderError> => {
		const encoded = shellQuote(networkPolicyArgument(network));
		return runCommand(
			providerSandboxId,
			`for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do sudo -n systemctl is-active --quiet zuse-firewall.service && break; sleep 1; done && sudo -n systemctl is-active --quiet zuse-firewall.service && sudo -n ${BOX_FIREWALL_COMMAND} apply ${encoded} && sudo -n mkdir -p /var/lib/zuse-firewall && printf %s ${encoded} | sudo -n tee ${BOX_PERSISTED_POLICY_FILE} >/dev/null && sudo -n chmod 600 ${BOX_PERSISTED_POLICY_FILE}`,
		).pipe(
			Effect.flatMap((result) =>
				result.exitCode === 0
					? Effect.void
					: Effect.fail(providerError("transient")),
			),
		);
	};

	// The template's firewall unit boots every box into default-deny egress.
	// Wait for that late-restored one-shot unit to finish before applying the
	// requested policy. Keeping the unit active (exited) also gives later policy
	// changes a stable barrier: systemd cannot run its boot action a second time.
	// Verification is part of the quarantine contract: a fork that cannot prove
	// the barrier is up gets destroyed and re-forked (ADR 0033 §3).
	const verifyQuarantined = (
		providerSandboxId: string,
	): Effect.Effect<void, SandboxProviderError> =>
		runCommand(
			providerSandboxId,
			`sudo -n ${BOX_FIREWALL_COMMAND} verify-quarantined`,
		).pipe(
			Effect.flatMap((result) =>
				result.exitCode === 0
					? Effect.void
					: Effect.fail(providerError("transient")),
			),
		);

	const startHostedPort = (
		providerSandboxId: string,
		port = 47_837,
	): Effect.Effect<void, SandboxProviderError> =>
		runCommand(
			providerSandboxId,
			`node -e ${shellQuote(BOX_PORT_FORWARDER)} ${port} && host ${port} --public >/dev/null`,
		).pipe(
			Effect.flatMap((result) =>
				result.exitCode === 0
					? Effect.void
					: Effect.fail(providerError("transient")),
			),
		);

	const ensureRuntimeLayout = (
		providerSandboxId: string,
		requirePersistedLayout: boolean,
	): Effect.Effect<void, SandboxProviderError> =>
		runCommand(
			providerSandboxId,
			[
				...(requirePersistedLayout
					? [
							`for attempt in 1 2 3 4 5 6 7 8 9 10; do sudo -n test -f ${BOX_PERSISTED_RUNTIME_MARKER} && break; sleep 1; done`,
							`sudo -n test -f ${BOX_PERSISTED_RUNTIME_MARKER}`,
						]
					: []),
				`sudo -n install -d -m 0755 -o root -g root ${BOX_PERSISTED_RUNTIME_ROOT}`,
				`sudo -n install -d -m 0755 -o zuse -g zuse ${BOX_PERSISTED_RUNTIME_ROOT}/home ${BOX_PERSISTED_RUNTIME_ROOT}/repos`,
				`for mapping in /home/zuse:${BOX_PERSISTED_RUNTIME_ROOT}/home /home/repos:${BOX_PERSISTED_RUNTIME_ROOT}/repos; do logical="\${mapping%%:*}"; persistent="\${mapping#*:}"; if [ "$(readlink "$logical" 2>/dev/null || true)" != "$persistent" ]; then if sudo -n test -d "$logical"; then sudo -n cp -a "$logical"/. "$persistent"/; fi; sudo -n chown -R zuse:zuse "$persistent"; sudo -n rm -rf -- "$logical"; sudo -n ln -s "$persistent" "$logical"; fi; done`,
				"sudo -n install -d -m 0755 -o zuse -g zuse /home/zuse/.zuse-data",
				"sudo -n install -d -m 0700 -o zuse -g zuse /home/zuse/.ssh /run/zuse-secrets",
				"if sudo -n test -f /usr/local/share/zuse/sshd_config; then sudo -n install -m 0600 -o zuse -g zuse /usr/local/share/zuse/sshd_config /home/zuse/.ssh/sshd_config; fi",
				`sudo -n touch ${BOX_PERSISTED_RUNTIME_MARKER}`,
			].join(" && "),
		).pipe(
			Effect.flatMap((result) =>
				result.exitCode === 0
					? Effect.void
					: Effect.fail(providerError("transient")),
			),
		);

	const prepareRestoredSandbox = Effect.fn(
		"BoxSandboxProvider.prepareRestoredSandbox",
	)(function* (
		providerSandboxId: string,
		network: SandboxNetworkPolicy,
		requirePersistedLayout: boolean,
	) {
		// Box restores template files after systemd has passed its boot targets.
		// Apply explicitly before exposing the sandbox. `ready` can briefly lead
		// completion of the disk restore, so retry the whole fail-closed gate—not
		// only verification—in case the restore races the first apply.
		yield* ensureRuntimeLayout(providerSandboxId, requirePersistedLayout);
		let prepared = false;
		for (let attempt = 0; attempt < 5 && !prepared; attempt++) {
			prepared = yield* applyNetworkPolicy(providerSandboxId, network).pipe(
				Effect.andThen(
					Effect.sleep(Duration.millis(Math.min(500, pollIntervalMs))),
				),
				Effect.andThen(
					network.kind === "quarantined"
						? verifyQuarantined(providerSandboxId)
						: Effect.void,
				),
				Effect.as(true),
				Effect.catchTag("SandboxProviderError", () => Effect.succeed(false)),
			);
			if (!prepared) yield* Effect.sleep(Duration.millis(pollIntervalMs));
		}
		if (!prepared) return yield* providerError("transient");
	});

	const restoreResumedSandbox = Effect.fn(
		"BoxSandboxProvider.restoreResumedSandbox",
	)(function* (providerSandboxId: string) {
		yield* ensureRuntimeLayout(providerSandboxId, true);
		const restored = yield* runCommand(
			providerSandboxId,
			`sudo -n ${BOX_FIREWALL_COMMAND} restore`,
		);
		if (restored.exitCode !== 0) {
			// Compatibility for boxes created from templates predating the restore
			// subcommand. The adapter persists the exact policy on every apply.
			const fallback = yield* runCommand(
				providerSandboxId,
				`policy="$(sudo -n cat ${BOX_PERSISTED_POLICY_FILE})" && sudo -n ${BOX_FIREWALL_COMMAND} apply "$policy"`,
			);
			if (fallback.exitCode !== 0) return yield* providerError("transient");
		}
	});

	const clampTtlSeconds = (timeoutSeconds: number): number =>
		Math.min(
			MAX_TTL_SECONDS,
			Math.max(MIN_TTL_SECONDS, Math.trunc(timeoutSeconds)),
		);

	const validatedEnv = (
		env: Readonly<Record<string, string>>,
	): Effect.Effect<Readonly<Record<string, string>>, SandboxProviderError> =>
		Object.keys(env).every((key) => ENV_KEY_PATTERN.test(key))
			? Effect.succeed(env)
			: Effect.fail(providerError("rejected"));

	const machineTypeFor = (
		sizeId: string | undefined,
	): Effect.Effect<BoxMachineType, SandboxProviderError> =>
		sizeId === undefined
			? Effect.succeed(machineType)
			: sizeId === "small" || sizeId === "default" || sizeId === "large"
				? Effect.succeed(sizeId)
				: Effect.fail(providerError("rejected"));

	const createFromSnapshot = Effect.fn("BoxSandboxProvider.create")(
		function* (input: {
			readonly providerLabel: string;
			readonly snapshot: string;
			readonly sizeId?: string;
			readonly timeoutSeconds: number;
			readonly env: Readonly<Record<string, string>>;
			readonly network: SandboxNetworkPolicy;
			readonly requirePersistedLayout: boolean;
		}) {
			const env = yield* validatedEnv(input.env);
			// The Box account environment is deliberately inherited (no `noEnv`):
			// under the account-image architecture the base carries credentials so
			// the runtime launches without a credential-install phase. Anything in
			// the account environment reaches every sandbox — only globally shared
			// material belongs there; per-account credentials are baked into the
			// account image by the API.
			const created = yield* request("POST", "/boxes", BoxInfoResponse, {
				from: input.snapshot,
				type: yield* machineTypeFor(input.sizeId),
				ttlSeconds: clampTtlSeconds(input.timeoutSeconds),
				env,
			});
			// Label before waiting: a crash mid-provision must stay recoverable by
			// label, and unlabeled boxes only die by TTL.
			yield* requestVoid(
				"PATCH",
				`/boxes/${encodeURIComponent(created.box.id)}`,
				{ name: input.providerLabel },
			).pipe(
				Effect.catchTag("SandboxProviderError", (error) =>
					kill(created.box.id).pipe(
						Effect.ignore,
						Effect.andThen(Effect.fail(error)),
					),
				),
			);
			yield* pollUntilUsable(created.box.id, readyDeadlineMs);
			yield* prepareRestoredSandbox(
				created.box.id,
				input.network,
				input.requirePersistedLayout,
			).pipe(
				Effect.catchTag("SandboxProviderError", (error) =>
					kill(created.box.id).pipe(
						Effect.ignore,
						Effect.andThen(Effect.fail(error)),
					),
				),
			);
			return {
				providerSandboxId: created.box.id,
				providerLabel: input.providerLabel,
				state: "running",
			} satisfies ProviderSandbox;
		},
	);

	const startProcess = Effect.fn("BoxSandboxProvider.startProcess")(function* (
		providerSandboxId: string,
		input: SandboxProcessInput,
	) {
		const env = yield* validatedEnv(input.env ?? {});
		const user = input.user ?? "user";
		const exports = Object.entries(env).map(
			([key, value]) => `export ${key}=${shellQuote(value)}`,
		);
		const script = [
			...(input.tag === undefined
				? []
				: [
						'mkdir -p "$HOME/.zuse-processes"',
						`printf '%s %s\\n' "$(cat /proc/sys/kernel/random/boot_id)" "$$" > "$HOME/.zuse-processes/${processTagFile(input.tag)}"`,
					]),
			...(input.cwd === undefined
				? ['cd "$HOME"']
				: [`cd ${shellQuote(input.cwd)}`]),
			...exports,
			`exec ${[input.command, ...(input.args ?? [])]
				.map(shellQuote)
				.join(" ")}`,
		].join(" && ");
		yield* request(
			"POST",
			`/boxes/${encodeURIComponent(providerSandboxId)}/commands`,
			CommandStartedResponse,
			{
				// Box injects the account base environment into its command user.
				// Preserve it across the deliberate privilege drop so the locked-down
				// runtime user receives the shared agent/GitHub credentials too. -H
				// still selects the target user's home instead of leaking /home/user.
				command: `sudo -n -E -H -u ${shellQuote(user)} setsid bash -c ${shellQuote(script)}`,
				detached: true,
			},
		);
	});

	const replaceProcess = Effect.fn("BoxSandboxProvider.replaceProcess")(
		function* (
			providerSandboxId: string,
			selector: SandboxProcessSelector,
			input: SandboxProcessInput,
		) {
			const user = input.user ?? "user";
			// The pid file records the setsid group leader, so the group kill takes
			// the tagged process and its children in one signal.
			const script = [
				`pidfile="$HOME/.zuse-processes/${processTagFile(selector.tag)}"`,
				'if [ -f "$pidfile" ]; then read -r boot pid < "$pidfile"; if [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && [ "$pid" -gt 1 ] 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi; rm -f "$pidfile"; fi',
				...(selector.legacyCommandMarkers ?? [])
					.filter(Boolean)
					.map((marker) => {
						// Bracket the first character so the cleanup shell's argv cannot
						// match its own pattern. Treat markers as literal command text.
						const first = marker[0]?.replace(/[\\\]^]/gu, "\\$&");
						const rest = marker
							.slice(1)
							.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
						return `pkill -KILL -f -- ${shellQuote(`[${first}]${rest}`)} || true`;
					}),
				"true",
			].join("; ");
			const result = yield* runCommand(
				providerSandboxId,
				`sudo -n -E -H -u ${shellQuote(user)} bash -c ${shellQuote(script)}`,
			);
			if (result.exitCode !== 0)
				return yield* Effect.fail(providerError("transient"));
			yield* startProcess(providerSandboxId, {
				...input,
				tag: selector.tag,
			});
		},
	);

	const pathExists = Effect.fn("BoxSandboxProvider.pathExists")(function* (
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

	const readTextFile = Effect.fn("BoxSandboxProvider.readTextFile")(function* (
		providerSandboxId: string,
		path: string,
	) {
		const result = yield* runCommand(
			providerSandboxId,
			`sudo -n cat ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) return yield* providerError("not-found");
		if (
			result.stdoutTruncated === true ||
			new TextEncoder().encode(result.stdout).byteLength > MAX_TEXT_FILE_BYTES
		)
			return yield* providerError("rejected");
		return result.stdout;
	});

	const writeTextFile = Effect.fn("BoxSandboxProvider.writeTextFile")(
		function* (
			providerSandboxId: string,
			path: string,
			contents: string,
			user?: string,
		) {
			if (new TextEncoder().encode(contents).byteLength > MAX_TEXT_FILE_BYTES)
				return yield* providerError("rejected");
			const stagingPath = `/tmp/.zuse-write-${crypto.randomUUID()}`;
			yield* requestVoid(
				"PUT",
				`/boxes/${encodeURIComponent(providerSandboxId)}/files`,
				{ path: stagingPath, content: contents, encoding: "utf8" },
			);
			const owner = user ?? "user";
			// Secrets-safe default: owner-only permissions, parents created.
			const install = yield* runCommand(
				providerSandboxId,
				`sudo -n install -D -m 600 -o ${shellQuote(owner)} -g ${shellQuote(
					owner,
				)} ${shellQuote(stagingPath)} ${shellQuote(path)} && sudo -n rm -f ${shellQuote(stagingPath)}`,
			);
			if (install.exitCode !== 0)
				return yield* Effect.fail(providerError("transient"));
		},
	);

	const inspect = (
		providerSandboxId: string,
	): Effect.Effect<ProviderSandbox | null, SandboxProviderError> =>
		boxDetail(providerSandboxId).pipe(
			Effect.map((detail) =>
				detail.state === "error" ? null : toProviderSandbox(detail),
			),
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
			),
		);

	const recoverByLabel = Effect.fn("BoxSandboxProvider.recoverByLabel")(
		function* (providerLabel: string) {
			let cursor: string | undefined;
			for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
				const query = new URLSearchParams({
					limit: "100",
					state: RECOVERABLE_STATES,
				});
				if (cursor !== undefined) query.set("cursor", cursor);
				const listed = yield* request(
					"GET",
					`/boxes?${query.toString()}`,
					BoxListResponse,
				);
				const found = listed.boxes.find(
					(candidate) => candidate.name === providerLabel,
				);
				if (found !== undefined) return toProviderSandbox(found);
				const nextCursor = listed.pageInfo?.nextCursor ?? null;
				if (nextCursor === null || listed.boxes.length === 0) return null;
				cursor = nextCursor;
			}
			return null;
		},
	);

	return {
		providerId: BOX_PROVIDER_ID,
		displayName: "Box",
		getUsage: Effect.fn("BoxSandboxProvider.getUsage")(
			function* (providerSandboxId, window) {
				if (
					!Number.isSafeInteger(window.startedAtMs) ||
					!Number.isSafeInteger(window.endedAtMs) ||
					!Number.isFinite(new Date(window.startedAtMs).getTime()) ||
					!Number.isFinite(new Date(window.endedAtMs).getTime()) ||
					window.endedAtMs <= window.startedAtMs
				)
					return yield* Effect.fail(providerError("rejected"));
				const query = new URLSearchParams({
					since: new Date(window.startedAtMs).toISOString(),
					until: new Date(window.endedAtMs).toISOString(),
				});
				const usage = yield* request(
					"GET",
					`/boxes/${encodeURIComponent(providerSandboxId)}/usage?${query}`,
					BoxUsageResponse,
					undefined,
					30_000,
				);
				const startedAtMs = Date.parse(usage.since);
				const endedAtMs = Date.parse(usage.until);
				const providerCostMicros = Math.round(usage.dollars * 1_000_000);
				const costMicrosPerSecond =
					(1_000_000 * usage.billingMultiplier) / usage.secondsPerDollar;
				if (
					usage.boxId !== providerSandboxId ||
					startedAtMs !== window.startedAtMs ||
					endedAtMs !== window.endedAtMs ||
					!Number.isSafeInteger(providerCostMicros) ||
					!Number.isFinite(costMicrosPerSecond) ||
					Math.abs(usage.dollars * 1_000_000 - providerCostMicros) > 0.000001
				)
					return yield* Effect.fail(providerError("rejected"));
				return {
					startedAtMs,
					endedAtMs,
					billableSeconds: usage.seconds,
					providerCostMicros,
					running: usage.running,
					costMicrosPerSecond,
				};
			},
		),
		templateVersion: config.templateVersion,
		preservesProcessesOnResume: false,
		resources: BOX_MACHINE_RESOURCES[machineType],
		// Size ids intentionally match Box machine types; resume restores onto
		// fresh hardware, so resizing is free at the provider level.
		sizes: [
			machineType,
			...(["small", "default", "large"] as const).filter(
				(sizeId) => sizeId !== machineType,
			),
		].map((sizeId) => ({
			sizeId,
			displayName:
				sizeId === "small"
					? "Small (2 vCPU / 4 GB)"
					: sizeId === "default"
						? "Standard (4 vCPU / 8 GB)"
						: "Large (8 vCPU / 16 GB)",
			...BOX_MACHINE_RESOURCES[sizeId],
		})),
		resolveEndpoint: (providerSandboxId, port) =>
			startHostedPort(providerSandboxId, port).pipe(
				Effect.andThen(boxDetail(providerSandboxId)),
				Effect.flatMap((detail) => {
					if (detail.subdomain == null)
						return Effect.fail(providerError("transient"));
					const host = `${detail.subdomain}-${port}.${hostedPortDomain}`;
					return Effect.succeed({
						httpBaseUrl: `https://${host}`,
						wsBaseUrl: `wss://${host}`,
					});
				}),
			),
		create: (input) =>
			createFromSnapshot({
				providerLabel: input.providerLabel,
				snapshot: config.templateSnapshot,
				sizeId: input.sizeId,
				timeoutSeconds: input.timeoutSeconds,
				env: input.env,
				network: input.network,
				requirePersistedLayout: false,
			}),
		// Box forks are disk restores with a cold process start. Every box still
		// BOOTS behind the template firewall; the caller's requested policy is
		// applied (or, for quarantined, verified) only once the box is usable,
		// so a fork carrying inherited secrets never runs open before the
		// adapter says so (ADR 0035).
		fork: (input) =>
			createFromSnapshot({
				providerLabel: input.providerLabel,
				snapshot: input.snapshotId,
				sizeId: input.sizeId,
				timeoutSeconds: input.timeoutSeconds,
				env: input.env,
				network: input.network,
				requirePersistedLayout: true,
			}),
		recoverByLabel,
		startProcess,
		replaceProcess,
		pathExists,
		readTextFile,
		writeTextFile,
		inspect,
		pause: (providerSandboxId) =>
			requestVoid(
				"POST",
				`/boxes/${encodeURIComponent(providerSandboxId)}/stop`,
				{},
				// 409 covers an already archived box or an in-flight stop.
				[409],
			),
		resume: Effect.fn("BoxSandboxProvider.resume")(
			function* (providerSandboxId, timeoutSeconds, _onTimeout, sizeId) {
				// Box TTLs always archive; `onTimeout: "terminate"` has no provider
				// analog and archived boxes accrue no cost, so the caller's kill path
				// is the terminator. Resume restores onto fresh hardware, so a size
				// change applies here at no extra cost. Never pass `noEnv` here: its
				// resume semantics scrub inherited secrets from the restored
				// snapshot, which would strip the credentials the account image
				// carries.
				yield* requestVoid(
					"POST",
					`/boxes/${encodeURIComponent(providerSandboxId)}/resume`,
					{
						ttlSeconds: clampTtlSeconds(timeoutSeconds),
						...(sizeId === undefined
							? {}
							: { type: yield* machineTypeFor(sizeId) }),
					},
					[409],
				);
				yield* pollUntilUsable(providerSandboxId, readyDeadlineMs);
				yield* restoreResumedSandbox(providerSandboxId);
				const sandbox = yield* inspect(providerSandboxId);
				if (sandbox === null) return yield* providerError("not-found");
				return sandbox;
			},
		),
		extendTimeout: (providerSandboxId, timeoutSeconds) =>
			requestVoid("PATCH", `/boxes/${encodeURIComponent(providerSandboxId)}`, {
				ttlSeconds: clampTtlSeconds(timeoutSeconds),
			}),
		setNetwork: (providerSandboxId, network) =>
			applyNetworkPolicy(providerSandboxId, network),
		snapshot: Effect.fn("BoxSandboxProvider.snapshot")(
			function* (providerSandboxId, name) {
				const target = snapshotName(name);
				if (target === "") return yield* providerError("rejected");
				const status = yield* request(
					"GET",
					`/named-snapshots/${encodeURIComponent(target)}`,
					NamedSnapshotInfoResponse,
				).pipe(
					Effect.map((info) => info.snapshot.status),
					Effect.catchTag("SandboxProviderError", (error) =>
						error.code === "not-found"
							? Effect.succeed("missing" as const)
							: Effect.fail(error),
					),
				);
				if (status === "ready") return target;
				if (status === "failed") {
					yield* requestVoid(
						"DELETE",
						`/named-snapshots/${encodeURIComponent(target)}`,
						undefined,
						[404],
					);
				}
				if (status === "missing" || status === "failed") {
					yield* requestVoid("POST", "/named-snapshots", {
						boxId: providerSandboxId,
						name: target,
					});
				}
				// Snapshotting a running box can take minutes; retries land back here
				// and resume polling the same in-flight save.
				const attempts = Math.max(
					1,
					Math.ceil(snapshotDeadlineMs / pollIntervalMs),
				);
				for (let attempt = 0; attempt < attempts; attempt++) {
					const info = yield* request(
						"GET",
						`/named-snapshots/${encodeURIComponent(target)}`,
						NamedSnapshotInfoResponse,
					).pipe(
						Effect.catchTag("SandboxProviderError", (error) =>
							error.code === "transient" || error.code === "not-found"
								? Effect.succeed(null)
								: Effect.fail(error),
						),
					);
					if (info?.snapshot.status === "ready") return target;
					if (info?.snapshot.status === "failed")
						return yield* providerError("transient");
					yield* Effect.sleep(Duration.millis(pollIntervalMs));
				}
				return yield* providerError("transient");
			},
		),
		kill,
		deleteSnapshot: (snapshotId) =>
			requestVoid(
				"DELETE",
				`/named-snapshots/${encodeURIComponent(snapshotId)}`,
				undefined,
				[404],
			),
	};
};
