import {
	APIConnectionError,
	APIStatusError,
	AuthenticationError,
	BoxdError,
	ConflictError,
	type ExecParams,
	type ExecResult,
	type Machine,
	type MachineCreateParams,
	type MachineForkParams,
	type MachineResizeParams,
	NotFoundError,
	type Proxy as ProxyRoute,
	RateLimitError,
	type Snapshot,
	type UploadSource,
} from "@boxd-sh/sdk/web";
import { Effect, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	BOXD_BASE_URL,
	BOXD_PROVIDER_ID,
	type BoxdSandboxClient,
	boxdBaseUrl,
	boxdMachineName,
	boxdSandboxClientFor,
	makeBoxdSandboxProvider,
} from "../../src/boxd.ts";
import type { SandboxProviderAdapter } from "../../src/index.ts";

type Call = { readonly method: string; readonly args: ReadonlyArray<unknown> };

const machineOf = (
	overrides: Partial<Machine> & { readonly id: string },
): Machine => ({
	name: overrides.id,
	status: "running",
	imageRef: "snapshot",
	restartPolicy: null,
	createdAt: null,
	resources: {
		vcpu: 2,
		memoryBytes: 8 * 1024 ** 3,
		diskBytes: 100 * 1024 ** 3,
	},
	org: { id: "org_1", name: "zuse" },
	shared: false,
	botProtection: true,
	networking: { networks: [], isolated: true },
	egressAllow: [],
	access: {
		sshPort: null,
		domain: "boxd.sh",
		url: `https://${overrides.name ?? overrides.id}.boxd.sh`,
		desktopUrl: "",
		customDomains: [],
	},
	idle: { suspendAfter: 0, hibernateAfter: 14_400, destroyAfter: 0 },
	source: null,
	hibernatedAt: null,
	lastConnectedAt: null,
	bootTimeMs: 6,
	...overrides,
});

const routeOf = (
	machine: Machine,
	name: string | null,
	port: number,
): ProxyRoute => ({
	name,
	machineId: machine.id,
	machineName: machine.name,
	domain:
		name === null
			? `${machine.name}.boxd.sh`
			: `${name}.${machine.name}.boxd.sh`,
	port,
	portMode: name === null ? "auto" : "locked",
	isDefault: name === null,
});

const exit = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
	stdout,
	stderr,
	exitCode,
	success: exitCode === 0,
});

/**
 * In-memory stand-in for the SDK: records every call, keeps machines by id
 * and name, and lets a test script exec results or fail the next call of a
 * method with a real SDK error.
 */
class FakeBoxd implements BoxdSandboxClient {
	readonly calls: Call[] = [];
	readonly store = new Map<string, Machine>();
	readonly routes = new Map<string, ProxyRoute[]>();
	readonly snapshotStore = new Map<string, Snapshot>();
	readonly uploads: Array<{ id: string; path: string; source: UploadSource }> =
		[];
	readonly execs: Array<{ id: string; params: ExecParams }> = [];
	execResults: ExecResult[] = [];
	execHandler: ((params: ExecParams) => ExecResult) | undefined;
	readonly failures = new Map<string, Error[]>();
	/** Boot counter per machine; a resize reboot bumps it like a real VM. */
	readonly bootIds = new Map<string, number>();
	nextId = 1;
	createdSnapshotNames: string[] = [];
	private readonly failOnce = (method: string) => {
		const queue = this.failures.get(method);
		const failure = queue?.shift();
		if (failure !== undefined) throw failure;
	};
	fail(method: string, error: Error) {
		this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
	}
	private record(method: string, args: ReadonlyArray<unknown>) {
		this.calls.push({ method, args });
		this.failOnce(method);
	}
	byIdOrName(id: string): Machine {
		const found =
			this.store.get(id) ??
			[...this.store.values()].find((candidate) => candidate.name === id);
		if (found === undefined) throw new NotFoundError("VM not found", 5);
		return found;
	}
	set(machine: Machine) {
		this.store.set(machine.id, machine);
		return machine;
	}
	methods(method: string) {
		return this.calls.filter((call) => call.method === method);
	}
	readonly machines = {
		fork: async (id: string, params: MachineForkParams): Promise<Machine> => {
			this.record("machines.fork", [id, params]);
			const source = this.byIdOrName(id);
			return this.set(
				machineOf({
					...source,
					id: `vm_${this.nextId++}`,
					name: params.name ?? "fork",
					egressAllow: [...source.egressAllow],
				}),
			);
		},
		setEgressAllow: async (
			id: string,
			entries: string[],
		): Promise<string[]> => {
			this.record("machines.setEgressAllow", [id, entries]);
			this.set({ ...this.byIdOrName(id), egressAllow: [...entries] });
			return entries;
		},
		create: async (params: MachineCreateParams): Promise<Machine> => {
			this.record("machines.create", [params]);
			const id = `vm_${this.nextId++}`;
			const routes = params.fromSnapshot === undefined ? [] : [47_837];
			const machine = this.set(
				machineOf({
					id,
					name: params.name ?? id,
					status: "pending",
					source:
						params.fromSnapshot === undefined
							? null
							: {
									kind: "snapshot",
									name: params.fromSnapshot,
									version: 1,
									id: null,
								},
				}),
			);
			this.routes.set(id, [
				routeOf(machine, null, 8000),
				...routes.map((port) => routeOf(machine, `p${port}`, port)),
			]);
			return machine;
		},
		get: async (id: string): Promise<Machine> => {
			this.record("machines.get", [id]);
			return this.byIdOrName(id);
		},
		delete: async (id: string): Promise<void> => {
			this.record("machines.delete", [id]);
			this.byIdOrName(id);
			this.store.delete(id);
		},
		start: async (id: string): Promise<void> => {
			this.record("machines.start", [id]);
			this.set({ ...this.byIdOrName(id), status: "starting" });
		},
		resume: async (id: string): Promise<{ resumeUs: number }> => {
			this.record("machines.resume", [id]);
			this.set({ ...this.byIdOrName(id), status: "running" });
			return { resumeUs: 431 };
		},
		hibernate: async (id: string): Promise<void> => {
			this.record("machines.hibernate", [id]);
			this.set({ ...this.byIdOrName(id), status: "hibernated" });
		},
		wake: async (id: string): Promise<void> => {
			this.record("machines.wake", [id]);
			this.set({ ...this.byIdOrName(id), status: "running" });
		},
		resize: async (id: string, params: MachineResizeParams) => {
			this.record("machines.resize", [id, params]);
			const current = this.byIdOrName(id);
			this.bootIds.set(id, (this.bootIds.get(id) ?? 1) + 1);
			const vcpu = params.vcpu ?? current.resources.vcpu;
			this.set({
				...current,
				status: "starting",
				resources: {
					...current.resources,
					vcpu,
					memoryBytes: vcpu * 4 * 1024 ** 3,
				},
			});
			return { vcpu, memoryBytes: vcpu * 4 * 1024 ** 3, rebooted: true };
		},
		setAutoHibernateTimeout: async (id: string, seconds: number) => {
			this.record("machines.setAutoHibernateTimeout", [id, seconds]);
			const current = this.byIdOrName(id);
			this.set({
				...current,
				idle: { ...current.idle, hibernateAfter: seconds },
			});
		},
		exec: async (id: string, params: ExecParams): Promise<ExecResult> => {
			this.record("machines.exec", [id, params]);
			this.execs.push({ id, params });
			this.byIdOrName(id);
			if (params.command.includes("boot_id"))
				return exit(0, `boot-${this.bootIds.get(id) ?? 1}\n`);
			if (this.execHandler !== undefined) return this.execHandler(params);
			return this.execResults.shift() ?? exit(0);
		},
		waitUntilReady: async (id: string): Promise<Machine> => {
			this.record("machines.waitUntilReady", [id]);
			return this.set({ ...this.byIdOrName(id), status: "running" });
		},
		files: {
			upload: async (id: string, path: string, source: UploadSource) => {
				this.record("machines.files.upload", [id, path, source]);
				this.uploads.push({ id, path, source });
				return typeof source === "string" ? source.length : 0;
			},
		},
		proxies: {
			delete: async (machine: string, name: string) => {
				this.record("machines.proxies.delete", [machine, name]);
				const id = this.byIdOrName(machine).id;
				this.routes.set(
					id,
					(this.routes.get(id) ?? []).filter(
						(route) => (route.name ?? "") !== name,
					),
				);
			},
			create: async (machine: string, name: string, port: number) => {
				this.record("machines.proxies.create", [machine, name, port]);
				const found = this.byIdOrName(machine);
				const existing = this.routes.get(found.id) ?? [];
				if (existing.some((route) => route.name === name))
					throw new APIStatusError("couldn't create that proxy", 13);
				this.routes.set(found.id, [...existing, routeOf(found, name, port)]);
				return { name, port };
			},
			list: async (machine: string): Promise<ProxyRoute[]> => {
				this.record("machines.proxies.list", [machine]);
				return this.routes.get(this.byIdOrName(machine).id) ?? [];
			},
		},
	};
	readonly snapshots = {
		create: async (machine: string, name: string) => {
			this.record("snapshots.create", [machine, name]);
			this.byIdOrName(machine);
			this.createdSnapshotNames.push(name);
			const existing = this.snapshotStore.get(name);
			const version = (existing?.version ?? 0) + 1;
			const created: Snapshot = {
				id: `snap_${name}`,
				name,
				version,
				status: "pending",
				sizeBytes: 0,
				createdAt: null,
				updatedAt: null,
				vcpu: 2,
				memoryBytes: 8 * 1024 ** 3,
				useCount: 0,
			};
			this.snapshotStore.set(name, created);
			return { id: created.id, name, version, status: "pending" as const };
		},
		get: async (name: string, params?: { org?: string }): Promise<Snapshot> => {
			this.record("snapshots.get", [name, params]);
			const found = this.snapshotStore.get(name);
			if (found === undefined) throw new NotFoundError("snapshot not found", 5);
			return found;
		},
		delete: async (name: string, params?: { org?: string }) => {
			this.record("snapshots.delete", [name, params]);
			if (!this.snapshotStore.delete(name))
				throw new NotFoundError("snapshot not found", 5);
		},
	};
}

const makeAdapter = (
	client: FakeBoxd,
	overrides: Partial<Parameters<typeof makeBoxdSandboxProvider>[0]> = {},
) =>
	makeBoxdSandboxProvider(
		{
			apiKey: Redacted.make("bxd_secret"),
			org: "zuse",
			templateSnapshot: "zuse-base-v1",
			templateVersion: "1",
			pollIntervalMs: 1,
			readyDeadlineMs: 10,
			snapshotDeadlineMs: 10,
			...overrides,
		},
		client,
	);

const createInput = {
	sandboxId: "sandbox_1",
	providerLabel: "zuse-cloud-workspace-1",
	timeoutSeconds: 600,
	env: {},
	network: { kind: "open" } as const,
	onTimeout: "pause" as const,
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(effect.pipe(Effect.flip));
const decodedScript = (command: string): string =>
	Buffer.from(
		/printf %s ([A-Za-z0-9+/=]+)/u.exec(command)?.[1] ?? "",
		"base64",
	).toString();

const requireRevoke = (adapter: SandboxProviderAdapter) => {
	if (!adapter.revokeEndpoint) throw new Error("Expected revocation support");
	return adapter.revokeEndpoint;
};

describe("boxd machine names", () => {
	test("gives every machine a short kind-prefixed name", () => {
		expect(boxdMachineName("zuse-cloud-workspace-workspace_ZxH0d94")).toMatch(
			/^w[0-9a-z]{13}$/u,
		);
		expect(boxdMachineName("zuse-cloud-build-image_BIwpKclapLr")).toMatch(
			/^b[0-9a-z]{13}$/u,
		);
		expect(boxdMachineName("zuse-auth-0123456789abcdef")).toMatch(
			/^a[0-9a-z]{13}$/u,
		);
		expect(boxdMachineName("zuse-machine-1")).toMatch(/^m[0-9a-z]{13}$/u);
		expect(boxdMachineName("other")).toMatch(/^z[0-9a-z]{13}$/u);
	});

	test("keeps labels that differ only in case or a trailing hyphen distinct", () => {
		const upper = boxdMachineName("zuse-cloud-workspace-Ab_C");
		expect(upper).not.toBe(boxdMachineName("zuse-cloud-workspace-ab_c"));
		expect(boxdMachineName("zuse-cloud-workspace-Ab_C")).toBe(upper);
		expect(boxdMachineName("zuse-cloud-workspace-x-")).not.toBe(
			boxdMachineName("zuse-cloud-workspace-x"),
		);
	});

	test("keeps preview hosts short for every port", () => {
		const name = boxdMachineName(`zuse-cloud-build-${"X".repeat(80)}`);
		expect(name).toHaveLength(14);
		for (const port of [3001, 34903, 47837, 65535])
			expect(`p${port}.${name}.boxd.zuse.sh`.length).toBeLessThanOrEqual(34);
		expect(name).toMatch(/^[a-z][a-z0-9]*$/u);
	});

	test("does not collide across many workspace labels", () => {
		const names = new Set<string>();
		for (let index = 0; index < 50_000; index += 1)
			names.add(boxdMachineName(`zuse-cloud-workspace-workspace_${index}`));
		expect(names.size).toBe(50_000);
	});

	test("strips trailing slashes from the base URL the SDK dials", () => {
		expect(boxdBaseUrl("https://boxd.internal:9443/")).toBe(
			"https://boxd.internal:9443",
		);
		expect(boxdBaseUrl(undefined)).toBe(BOXD_BASE_URL);
	});
});

describe("boxd sandbox provider", () => {
	test.each([
		"p34903",
		null,
	])("uses the active org domain for proxy %s", async (routeName) => {
		const client = new FakeBoxd();
		const existing = machineOf({ id: "vm_custom", name: "zuse-preview" });
		const machine = client.set({
			...existing,
			access: {
				...existing.access,
				domain: "boxd.zuse.sh",
				url: "https://zuse-preview.boxd.zuse.sh",
			},
		});
		client.routes.set(machine.id, [
			{ ...routeOf(machine, routeName, 34903), portMode: "locked" },
		]);
		const host = `${routeName === null ? "" : `${routeName}.`}zuse-preview.boxd.zuse.sh`;
		await expect(
			run(makeAdapter(client).resolveEndpoint(machine.id, 34903)),
		).resolves.toEqual({
			httpBaseUrl: `https://${host}`,
			wsBaseUrl: `wss://${host}`,
		});
		expect(client.methods("machines.proxies.create")).toHaveLength(0);
	});

	test.each([
		"create",
		"snapshot-fork",
		"machine-fork",
	] as const)("%s leaves room for preview and runtime proxy hostnames", async (operation) => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "parent", status: "running" }));
		const adapter = makeAdapter(client);
		const providerLabel = `zuse-cloud-workspace-${"Long_Workspace_".repeat(6)}`;
		const input = { ...createInput, providerLabel };
		const created = await run(
			operation === "create"
				? adapter.create(input)
				: operation === "snapshot-fork"
					? adapter.fork({ ...input, snapshotId: "snapshot" })
					: adapter.forkMachine({
							providerLabel,
							sourceSandboxId: "parent",
							timeoutSeconds: 600,
						}),
		);
		expect(
			client.store.get(created.providerSandboxId)?.name.length,
		).toBeLessThanOrEqual(43);
		for (const port of [3001, 34903, 47837, 65535]) {
			const endpoint = await run(
				adapter.resolveEndpoint(created.providerSandboxId, port),
			);
			expect(new URL(endpoint.wsBaseUrl).hostname.length).toBeLessThanOrEqual(
				63,
			);
		}
		await expect(
			run(adapter.recoverByLabel(providerLabel)),
		).resolves.toMatchObject({
			providerSandboxId: created.providerSandboxId,
		});
	});

	test.each([
		["zuse-cloud-workspace-1", "zuse-cloud-workspace-1"],
		["x".repeat(56), "x".repeat(56)],
		[
			"zuse-cloud-workspace-workspace_N_HKqzMXzzQV6Idx",
			"zuse-cloud-workspace-workspace-n-hkqzmxzzqv6idx-af46307f",
		],
	])("recovers legacy names for %s without replacing machines", async (providerLabel, legacyName) => {
		const client = new FakeBoxd();
		client.set(
			machineOf({ id: "legacy", name: legacyName, status: "hibernated" }),
		);
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.recoverByLabel(providerLabel)),
		).resolves.toMatchObject({
			providerSandboxId: "legacy",
			state: "paused",
		});
		expect(client.methods("machines.create")).toHaveLength(0);
		client.set(
			machineOf({
				id: "current",
				name: boxdMachineName(providerLabel),
				status: "running",
			}),
		);
		await expect(
			run(adapter.recoverByLabel(providerLabel)),
		).resolves.toMatchObject({
			providerSandboxId: "current",
		});
	});

	test("registers with the stable provider id and warm resume semantics", () => {
		const adapter = makeAdapter(new FakeBoxd());
		expect(adapter.providerId).toBe(BOXD_PROVIDER_ID);
		expect(adapter.displayName).toBe("boxd");
		expect(adapter.templateVersion).toBe("1");
		expect(adapter.preservesProcessesOnResume).toBe(true);
		expect(adapter.getUsage).toBeUndefined();
	});

	test("advertises the three machine sizes with the configured default first", () => {
		const adapter = makeAdapter(new FakeBoxd());
		expect(adapter.resources).toEqual({ vcpuCount: 2, memoryMib: 8_192 });
		expect(adapter.sizes.map((size) => size.sizeId)).toEqual([
			"default",
			"small",
			"large",
		]);
		const small = makeAdapter(new FakeBoxd(), { machineSize: "small" });
		expect(small.resources).toEqual({ vcpuCount: 1, memoryMib: 4_096 });
		expect(small.sizes[0]).toMatchObject({
			sizeId: "small",
			displayName: "Small (1 vCPU / 4 GB)",
		});
	});

	test("shares one SDK client per credential across adapter instances", () => {
		const config = { apiKey: Redacted.make("bxd_cache_test") };
		expect(boxdSandboxClientFor(config)).toBe(boxdSandboxClientFor(config));
		// A trailing slash is the same endpoint, not a second client.
		expect(boxdSandboxClientFor(config)).toBe(
			boxdSandboxClientFor({ ...config, baseUrl: `${BOXD_BASE_URL}/` }),
		);
		expect(boxdSandboxClientFor(config)).not.toBe(
			boxdSandboxClientFor({
				...config,
				baseUrl: "https://boxd.internal:9443",
			}),
		);
		expect(boxdSandboxClientFor(config)).not.toBe(
			boxdSandboxClientFor({ apiKey: Redacted.make("bxd_other") }),
		);
	});

	test("creates an isolated machine from the template snapshot and arms the pause timer", async () => {
		const client = new FakeBoxd();
		const created = await run(makeAdapter(client).create(createInput));

		expect(created).toEqual({
			providerSandboxId: "vm_1",
			providerLabel: "zuse-cloud-workspace-1",
			state: "running",
		});
		expect(client.methods("machines.create")[0]?.args[0]).toEqual({
			name: boxdMachineName("zuse-cloud-workspace-1"),
			org: "zuse",
			fromSnapshot: "zuse-base-v1",
			isolated: true,
			config: { autoSuspendTimeout: 0 },
		});
		expect(client.calls.map((call) => call.method)).toEqual([
			"machines.create",
			"machines.setAutoHibernateTimeout",
			"machines.waitUntilReady",
			"machines.exec",
			"machines.exec",
		]);
		expect(client.methods("machines.setAutoHibernateTimeout")[0]?.args).toEqual(
			["vm_1", 600],
		);
		const prepare = client.execs[0]?.params.command;
		expect(prepare).toContain("systemctl is-system-running --wait");
		expect(prepare).toContain(
			"install -d -m 0700 -o zuse -g zuse /run/zuse-secrets",
		);
		const prime = client.execs[1]?.params.command as string;
		expect(prime).toContain("sudo -n -u zuse -H bash -c");
		expect(prime).toContain("zuse --version");
		expect(prime).toContain(
			"systemd-run --quiet --collect --wait --uid=zuse -- /bin/true",
		);
	});

	test("allocates even when priming the runtime fails", async () => {
		const client = new FakeBoxd();
		const exec = client.machines.exec;
		client.machines.exec = async (id, params) => {
			if (params.command.includes("zuse --version")) {
				client.calls.push({ method: "machines.exec", args: [id, params] });
				throw new APIConnectionError("unavailable", 14);
			}
			return exec(id, params);
		};
		await expect(
			run(makeAdapter(client).create(createInput)),
		).resolves.toMatchObject({
			providerSandboxId: "vm_1",
			state: "running",
		});
	});

	test("arms a destroy timer instead of hibernation for terminate-on-timeout allocations", async () => {
		const client = new FakeBoxd();
		await run(
			makeAdapter(client).create({
				...createInput,
				timeoutSeconds: 3_600,
				onTimeout: "terminate",
			}),
		);
		expect(client.methods("machines.create")[0]?.args[0]).toMatchObject({
			config: { autoSuspendTimeout: 0, autoDestroyTimeout: 3_600 },
		});
		expect(client.methods("machines.setAutoHibernateTimeout")).toHaveLength(0);
	});

	test("resizes after the restore when the placement differs from the snapshot", async () => {
		const client = new FakeBoxd();
		await run(makeAdapter(client).create({ ...createInput, sizeId: "small" }));
		expect(client.methods("machines.resize")[0]?.args).toEqual([
			"vm_1",
			{ vcpu: 1 },
		]);
		expect(client.methods("machines.waitUntilReady")).toHaveLength(2);
		expect(client.store.get("vm_1")?.resources.vcpu).toBe(1);
	});

	test("skips the resize when the snapshot already has the requested size", async () => {
		const client = new FakeBoxd();
		await run(
			makeAdapter(client).create({ ...createInput, sizeId: "default" }),
		);
		expect(client.methods("machines.resize")).toHaveLength(0);
	});

	test.each([
		{ kind: "quarantined" } as const,
		{ kind: "restricted", allowOut: ["example.com"], denyOut: [] } as const,
	])("rejects unsupported network policy before allocating: $kind", async (network) => {
		const client = new FakeBoxd();
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.create({ ...createInput, network })),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(adapter.fork({ ...createInput, snapshotId: "snap", network })),
		).rejects.toMatchObject({ code: "rejected" });
		if (network.kind === "restricted")
			await expect(
				run(adapter.setNetwork("vm_1", network)),
			).rejects.toMatchObject({ code: "rejected" });
		expect(client.calls).toHaveLength(0);
	});

	test("rejects create-time environment and unknown sizes before calling the API", async () => {
		const client = new FakeBoxd();
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.create({ ...createInput, env: { ZUSE_TOKEN: "x" } })),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(adapter.create({ ...createInput, sizeId: "xlarge" })),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.calls).toHaveLength(0);
	});

	test("adopts the machine a lost create response already made", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({
				id: "vm_existing",
				name: boxdMachineName("zuse-cloud-workspace-1"),
				status: "running",
			}),
		);
		client.fail(
			"machines.create",
			new ConflictError("name is already taken", 6),
		);
		const created = await run(makeAdapter(client).create(createInput));
		expect(created.providerSandboxId).toBe("vm_existing");
		expect(client.methods("machines.get")[0]?.args).toEqual([
			boxdMachineName("zuse-cloud-workspace-1"),
		]);
	});

	test("replaces a failed machine that still holds the label", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({
				id: "vm_failed",
				name: boxdMachineName("zuse-cloud-workspace-1"),
				status: "failed",
			}),
		);
		client.fail(
			"machines.create",
			new ConflictError("name is already taken", 6),
		);
		const created = await run(makeAdapter(client).create(createInput));
		expect(created.providerSandboxId).toBe("vm_1");
		expect(client.calls.map((call) => call.method).slice(0, 4)).toEqual([
			"machines.create",
			"machines.get",
			"machines.delete",
			"machines.create",
		]);
		expect(client.store.has("vm_failed")).toBe(false);
	});

	test("deletes a failed machine during label recovery so a replacement can be allocated", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({ id: "vm_failed", name: "recover-me", status: "failed" }),
		);
		await expect(
			run(makeAdapter(client).recoverByLabel("recover-me")),
		).resolves.toBeNull();
		expect(client.methods("machines.delete")[0]?.args).toEqual(["vm_failed"]);
		expect(client.store.has("vm_failed")).toBe(false);
	});

	test("does not mask a missing template snapshot as a name conflict", async () => {
		const client = new FakeBoxd();
		client.fail("machines.create", new NotFoundError("snapshot not found", 5));
		await expect(
			run(makeAdapter(client).create(createInput)),
		).rejects.toMatchObject({ code: "not-found" });
		expect(client.methods("machines.get")).toHaveLength(0);
	});

	test("deletes a machine that never becomes usable so the retry starts fresh", async () => {
		const client = new FakeBoxd();
		client.fail(
			"machines.waitUntilReady",
			new BoxdError("machine vm_1 did not become ready within 10ms"),
		);
		await expect(
			run(makeAdapter(client).create(createInput)),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.methods("machines.delete")[0]?.args).toEqual(["vm_1"]);
		expect(client.store.has("vm_1")).toBe(false);
	});

	test("deletes a running machine whose readiness probe failed instead of adopting it again", async () => {
		const client = new FakeBoxd();
		client.fail(
			"machines.waitUntilReady",
			new APIConnectionError("unavailable", 14),
		);
		client.machines.create = async (params) => {
			client.calls.push({ method: "machines.create", args: [params] });
			return client.set(
				machineOf({ id: "vm_1", name: params.name, status: "running" }),
			);
		};
		await expect(
			run(makeAdapter(client).create(createInput)),
		).rejects.toMatchObject({ code: "transient" });
		// The idle timer was armed before the wait, so even a machine that
		// outlives a lost delete is not left on the organization default.
		expect(client.calls.map((call) => call.method)).toEqual([
			"machines.create",
			"machines.setAutoHibernateTimeout",
			"machines.waitUntilReady",
			"machines.delete",
		]);
		expect(client.store.has("vm_1")).toBe(false);
	});

	test("does not retry a create the provider rejected outright", async () => {
		const client = new FakeBoxd();
		client.fail(
			"machines.create",
			new AuthenticationError("invalid api key", 16),
		);
		await expect(
			run(makeAdapter(client).create(createInput)),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.methods("machines.create")).toHaveLength(1);
		expect(client.methods("machines.get")).toHaveLength(0);
	});

	test("waits for a resized machine to report a new boot before handing it over", async () => {
		const client = new FakeBoxd();
		const resize = client.machines.resize;
		client.machines.resize = async (id, params) => {
			const result = await resize(id, params);
			// The old instance still answers for a while after `resize` returns.
			client.bootIds.set(id, 1);
			client.set({ ...client.byIdOrName(id), status: "running" });
			return result;
		};
		let reads = 0;
		const exec = client.machines.exec;
		client.machines.exec = async (id, params) => {
			if (params.command.includes("boot_id") && ++reads === 3)
				client.bootIds.set(id, 2);
			return exec(id, params);
		};
		const created = await run(
			makeAdapter(client).create({ ...createInput, sizeId: "small" }),
		);
		expect(created.state).toBe("running");
		expect(client.methods("machines.waitUntilReady")).toHaveLength(3);
	});

	test("reports a resize whose reboot never lands as transient", async () => {
		const client = new FakeBoxd();
		const resize = client.machines.resize;
		client.machines.resize = async (id, params) => {
			const result = await resize(id, params);
			client.bootIds.set(id, 1);
			client.set({ ...client.byIdOrName(id), status: "running" });
			return result;
		};
		await expect(
			run(makeAdapter(client).create({ ...createInput, sizeId: "small" })),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("forks by restoring the account image snapshot in isolation", async () => {
		const client = new FakeBoxd();
		const forked = await run(
			makeAdapter(client).fork({
				...createInput,
				sandboxId: "sandbox_2",
				providerLabel: "zuse-cloud-workspace-2",
				snapshotId: "zuse-build-snap-1",
				timeoutSeconds: 120,
			}),
		);
		expect(forked.providerSandboxId).toBe("vm_1");
		expect(client.methods("machines.create")[0]?.args[0]).toMatchObject({
			name: boxdMachineName("zuse-cloud-workspace-2"),
			fromSnapshot: "zuse-build-snap-1",
			isolated: true,
		});
	});

	test.each([
		["running", "running"],
		["hibernated", "paused"],
		["suspended", "paused"],
		["stopped", "paused"],
	] as const)("recovers a %s machine by label as %s", async (status, state) => {
		const client = new FakeBoxd();
		client.set(
			machineOf({ id: "vm_9", name: "zuse-cloud-workspace-9", status }),
		);
		await expect(
			run(makeAdapter(client).recoverByLabel("zuse-cloud-workspace-9")),
		).resolves.toEqual({
			providerSandboxId: "vm_9",
			providerLabel: "zuse-cloud-workspace-9",
			state,
		});
	});

	test("keeps booting machines retryable instead of reporting them running", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({ id: "vm_boot", name: "recover-me", status: "starting" }),
		);
		await expect(
			run(makeAdapter(client).recoverByLabel("recover-me")),
		).rejects.toMatchObject({ code: "transient" });
		await expect(
			run(makeAdapter(client).inspect("vm_boot")),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("treats missing, failed, and destroyed machines as absent", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_failed", status: "failed" }));
		client.set(machineOf({ id: "vm_gone", status: "destroyed" }));
		const adapter = makeAdapter(client);
		await expect(run(adapter.inspect("missing"))).resolves.toBeNull();
		await expect(run(adapter.inspect("vm_failed"))).resolves.toBeNull();
		await expect(run(adapter.inspect("vm_gone"))).resolves.toBeNull();
		await expect(run(adapter.recoverByLabel("nope"))).resolves.toBeNull();
	});

	test("starts tagged processes in systemd with user, env, cwd, and tag wrapping", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await run(
			makeAdapter(client).startProcess("vm_1", {
				command: "/usr/local/bin/zuse-workspace-bootstrap",
				args: ["--resume"],
				cwd: "/home/zuse",
				env: { ZUSE_API_URL: "https://api.test" },
				user: "zuse",
				tag: "zuse-runtime",
			}),
		);
		expect(client.execs).toHaveLength(1);
		const script = decodedScript(client.execs[0]?.params.command as string);
		expect(script).toContain(
			"systemd-run --quiet --collect --service-type=exec",
		);
		expect(script).toContain("--property=Restart=no");
		expect(script).toContain("--property=KillMode=control-group");
		expect(script).toContain("/usr/local/bin/zuse-workspace-bootstrap");
		expect(script).toContain("ZUSE_API_URL");
		expect(script).not.toContain("systemctl stop");
	});

	test("launches tagged processes as the command user when no user is given", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await run(
			makeAdapter(client).startProcess("vm_1", {
				command: "/bin/true",
				tag: "probe",
			}),
		);
		const script = decodedScript(client.execs[0]?.params.command as string);
		expect(script).toContain("getent passwd 'boxd'");
		expect(script).not.toContain("getent passwd 'user'");
	});

	test("starts untagged processes detached in the target user's home", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await run(
			makeAdapter(client).startProcess("vm_1", {
				command: "/usr/bin/chmod",
				args: ["0700", "/var/lib/zuse/project-build/project-builder.sh"],
				user: "zuse",
			}),
		);
		const command = client.execs[0]?.params.command as string;
		expect(command).toContain("sudo -n -E -H -u 'zuse' setsid bash -c");
		expect(command).toContain('cd "$HOME" &&');
		expect(command).toContain("/usr/bin/chmod");
		expect(command).toMatch(/<\/dev\/null &$/u);
	});

	test("replaces a tagged process and cleans legacy runtimes in one command", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await run(
			makeAdapter(client).replaceProcess(
				"vm_1",
				{
					tag: "zuse-runtime",
					legacyCommandMarkers: ["zuse-workspace-bootstrap"],
					legacyCleanup: "matching-command",
				},
				{ command: "/opt/zuse/current/bin.mjs", args: ["serve"], user: "zuse" },
			),
		);
		expect(client.execs).toHaveLength(1);
		const script = decodedScript(client.execs[0]?.params.command as string);
		expect(script.indexOf("systemctl stop")).toBeLessThan(
			script.indexOf("systemd-run"),
		);
		expect(script).toContain("[z]use-workspace-bootstrap");
		expect(script).toContain("/opt/zuse/current/bin.mjs");
	});

	test("reports a failed launcher as transient", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.execResults = [exit(1, "", "Failed to connect to bus")];
		await expect(
			run(
				makeAdapter(client).startProcess("vm_1", {
					command: "/bin/true",
					user: "zuse",
					tag: "zuse-runtime",
				}),
			),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("rejects invalid environment variable names and oversized tags before calling the API", async () => {
		const client = new FakeBoxd();
		const adapter = makeAdapter(client);
		await expect(
			run(
				adapter.startProcess("vm_1", {
					command: "true",
					env: { "bad-key": "v" },
				}),
			),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(
				adapter.replaceProcess(
					"vm_1",
					{ tag: "runtime" },
					{ command: "true", env: { "bad-key": "v" } },
				),
			),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(
				adapter.startProcess("vm_1", { command: "true", tag: "x".repeat(256) }),
			),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.calls).toHaveLength(0);
	});

	test("maps path existence onto the test exit code", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.execResults = [exit(0), exit(1), exit(2)];
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.pathExists("vm_1", "/home/zuse/.ready")),
		).resolves.toBe(true);
		await expect(
			run(adapter.pathExists("vm_1", "/home/zuse/.missing")),
		).resolves.toBe(false);
		await expect(
			run(adapter.pathExists("vm_1", "/home/zuse/.broken")),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.execs[0]?.params.command).toBe(
			"sudo -n test -e '/home/zuse/.ready'",
		);
	});

	test("reads a text file, treats a read failure as not found, and caps the size", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.execResults = [
			exit(0, "file-contents\n"),
			exit(1),
			exit(0, "x".repeat(65_537)),
		];
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.readTextFile("vm_1", "/tmp/zuse-version")),
		).resolves.toBe("file-contents\n");
		await expect(
			run(adapter.readTextFile("vm_1", "/tmp/zuse-missing")),
		).rejects.toMatchObject({ code: "not-found" });
		await expect(
			run(adapter.readTextFile("vm_1", "/tmp/huge")),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.execs[0]?.params.command).toBe(
			"sudo -n head -c 65537 '/tmp/zuse-version'",
		);
	});

	test("rejects a relative path before uploading anything", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await expect(
			run(makeAdapter(client).writeTextFile("vm_1", "token", "x", "zuse")),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.uploads).toHaveLength(0);
		expect(client.execs).toHaveLength(0);
	});

	test("writes a text file through staging with owner-only permissions", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await run(
			makeAdapter(client).writeTextFile(
				"vm_1",
				"/run/zuse-secrets/boot-token",
				"token-value",
				"zuse",
			),
		);
		expect(client.uploads[0]).toMatchObject({
			id: "vm_1",
			path: expect.stringMatching(/^\/tmp\/\.zuse-write-/u),
			source: "token-value",
		});
		const install = client.execs[0]?.params.command as string;
		expect(install).toContain("sudo -n -u 'zuse' mkdir -p '/run/zuse-secrets'");
		expect(install).toContain("sudo -n install -m 600 -o 'zuse' -g 'zuse'");
		expect(install).toContain("'/run/zuse-secrets/boot-token'");
		expect(install).toContain("sudo -n rm -f");
		expect(install).not.toContain("install -D");
	});

	test("rejects writes that exceed the text file cap", async () => {
		const client = new FakeBoxd();
		await expect(
			run(
				makeAdapter(client).writeTextFile(
					"vm_1",
					"/tmp/huge",
					"x".repeat(70_000),
				),
			),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.calls).toHaveLength(0);
	});

	test("resolves the runtime endpoint through the forwarder and the inherited route", async () => {
		const client = new FakeBoxd();
		const adapter = makeAdapter(client);
		await run(adapter.create(createInput));
		client.calls.length = 0;
		client.execs.length = 0;
		await expect(run(adapter.resolveEndpoint("vm_1", 47_837))).resolves.toEqual(
			{
				httpBaseUrl: `https://p47837.${boxdMachineName("zuse-cloud-workspace-1")}.boxd.sh`,
				wsBaseUrl: `wss://p47837.${boxdMachineName("zuse-cloud-workspace-1")}.boxd.sh`,
			},
		);
		expect(client.execs[0]?.params.command).toMatch(/^node -e '.*' 47837$/su);
		expect(client.execs[0]?.params.command).toContain("networkInterfaces");
		expect(client.calls.map((call) => call.method)).toEqual([
			"machines.exec",
			"machines.proxies.list",
			"machines.get",
		]);
	});

	test("creates a preview route on demand and tolerates losing the race", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set("vm_1", [routeOf(machine, null, 8000)]);
		const adapter = makeAdapter(client);
		await expect(run(adapter.resolveEndpoint("vm_1", 3000))).resolves.toEqual({
			httpBaseUrl: "https://p3000.ws.boxd.sh",
			wsBaseUrl: "wss://p3000.ws.boxd.sh",
		});
		expect(client.execs[0]?.params.command).toMatch(/ 3000 --preview$/u);
		expect(client.methods("machines.proxies.create")[0]?.args).toEqual([
			"vm_1",
			"p3000",
			3000,
		]);
		// A second resolution finds the route without creating it again.
		await run(adapter.resolveEndpoint("vm_1", 3000));
		expect(client.methods("machines.proxies.create")).toHaveLength(1);
	});

	test("reuses an existing pinned default preview without creating another route", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [
			{ ...routeOf(machine, null, 3001), portMode: "locked" },
		]);
		await expect(
			run(makeAdapter(client).resolveEndpoint(machine.id, 3001)),
		).resolves.toEqual({
			httpBaseUrl: "https://ws.boxd.sh",
			wsBaseUrl: "wss://ws.boxd.sh",
		});
		expect(client.methods("machines.proxies.create")).toHaveLength(0);
	});

	test("does not reuse an auto-detected default route for a fixed port preview", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [routeOf(machine, null, 3001)]);
		await expect(
			run(makeAdapter(client).resolveEndpoint(machine.id, 3001)),
		).resolves.toMatchObject({ httpBaseUrl: "https://p3001.ws.boxd.sh" });
	});

	test("surfaces a refused route instead of retrying it forever", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set("vm_1", [routeOf(machine, null, 8000)]);
		client.fail(
			"machines.proxies.create",
			new APIStatusError("invalid proxy name", 3),
		);
		await expect(
			run(makeAdapter(client).resolveEndpoint("vm_1", 3000)),
		).rejects.toMatchObject({ code: "rejected" });
	});

	test("treats a forwarder failure as transient before touching routes", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.execResults = [exit(1)];
		await expect(
			run(makeAdapter(client).resolveEndpoint("vm_1", 47_837)),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.methods("machines.proxies.list")).toHaveLength(0);
	});

	test("revokes both named and legacy default preview URLs while preserving other ports", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [
			routeOf(machine, "p3001", 3001),
			{ ...routeOf(machine, null, 3001), portMode: "locked" },
			routeOf(machine, "p47837", 47837),
			routeOf(machine, "p5173", 5173),
		]);
		const adapter = makeAdapter(client);
		await run(requireRevoke(adapter)(machine.id, 3001));
		expect(client.routes.get(machine.id)?.map((route) => route.port)).toEqual([
			47837, 5173,
		]);
		await run(requireRevoke(adapter)(machine.id, 3001));
		expect(client.methods("machines.proxies.delete")).toHaveLength(2);
	});

	test("cleans legacy preview routes without deleting runtime or independently named routes", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [
			routeOf(machine, "p3001", 3001),
			{ ...routeOf(machine, null, 5173), portMode: "locked" },
			routeOf(machine, "p47837", 47837),
			routeOf(machine, "api", 8080),
		]);
		await run(requireRevoke(makeAdapter(client))(machine.id));
		expect(client.routes.get(machine.id)?.map((route) => route.name)).toEqual([
			"p47837",
			"api",
		]);
	});

	test("does not accept provider success while a revoked hostname still exists", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [routeOf(machine, "p3001", 3001)]);
		client.machines.proxies.delete = async () => {};
		await expect(
			run(requireRevoke(makeAdapter(client))(machine.id)),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("refuses to revoke runtime routes", async () => {
		const client = new FakeBoxd();
		await expect(
			run(requireRevoke(makeAdapter(client))("vm_1", 47837)),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.calls).toHaveLength(0);
	});

	test("reports provider revocation failures instead of claiming links are private", async () => {
		const client = new FakeBoxd();
		const machine = client.set(machineOf({ id: "vm_1", name: "ws" }));
		client.routes.set(machine.id, [routeOf(machine, null, 3001)]);
		client.fail(
			"machines.proxies.delete",
			new APIStatusError("default cannot be deleted", 13),
		);
		await expect(
			run(requireRevoke(makeAdapter(client))(machine.id, 3001)),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.routes.get(machine.id)).toHaveLength(1);
	});

	test("pauses by hibernating and confirms the machine parked", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "running" }));
		await expect(
			run(makeAdapter(client).pause("vm_1")),
		).resolves.toBeUndefined();
		expect(client.calls.map((call) => call.method)).toEqual([
			"machines.get",
			"machines.hibernate",
			"machines.get",
		]);
		expect(client.store.get("vm_1")?.status).toBe("hibernated");
	});

	test("treats an already parked machine as paused without a hibernate call", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "hibernated" }));
		client.set(machineOf({ id: "vm_2", status: "suspended" }));
		const adapter = makeAdapter(client);
		await expect(run(adapter.pause("vm_1"))).resolves.toBeUndefined();
		await expect(run(adapter.pause("vm_2"))).resolves.toBeUndefined();
		expect(client.methods("machines.hibernate")).toHaveLength(0);
		await expect(run(adapter.pause("vm_missing"))).rejects.toMatchObject({
			code: "not-found",
		});
	});

	test("does not record a booting machine as paused", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "starting" }));
		await expect(run(makeAdapter(client).pause("vm_1"))).rejects.toMatchObject({
			code: "transient",
		});
		expect(client.methods("machines.hibernate")).toHaveLength(0);
	});

	test("reports a machine that woke straight back up as not paused", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "running" }));
		client.machines.hibernate = async (id) => {
			client.calls.push({ method: "machines.hibernate", args: [id] });
		};
		await expect(run(makeAdapter(client).pause("vm_1"))).rejects.toMatchObject({
			code: "transient",
		});
		expect(client.methods("machines.get").length).toBeGreaterThan(2);
	});

	test("accepts a hibernate conflict when the machine did park", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "running" }));
		client.machines.hibernate = async (id) => {
			client.calls.push({ method: "machines.hibernate", args: [id] });
			client.set({ ...client.byIdOrName(id), status: "suspended" });
			throw new ConflictError(
				"VM is suspended (must be running to hibernate)",
				9,
			);
		};
		await expect(
			run(makeAdapter(client).pause("vm_1")),
		).resolves.toBeUndefined();
	});

	test("does not hide a rate limit or outage behind a pause", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.fail("machines.hibernate", new RateLimitError("slow down", 8));
		await expect(run(makeAdapter(client).pause("vm_1"))).rejects.toMatchObject({
			code: "transient",
		});
		client.fail(
			"machines.hibernate",
			new APIConnectionError("unavailable", 14),
		);
		await expect(run(makeAdapter(client).pause("vm_1"))).rejects.toMatchObject({
			code: "transient",
		});
	});

	test("does not hide a wake outage behind a resume", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "hibernated" }));
		client.fail("machines.wake", new APIConnectionError("unavailable", 14));
		await expect(
			run(makeAdapter(client).resume("vm_1", 600, "pause")),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.methods("machines.waitUntilReady")).toHaveLength(0);
	});

	test.each([
		["hibernated", "machines.wake"],
		["suspended", "machines.resume"],
		["stopped", "machines.start"],
	] as const)("resumes a %s machine with %s and re-arms the pause timer", async (status, method) => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status }));
		const resumed = await run(makeAdapter(client).resume("vm_1", 600, "pause"));
		expect(resumed.state).toBe("running");
		expect(client.calls.map((call) => call.method)).toEqual([
			"machines.get",
			method,
			"machines.waitUntilReady",
			"machines.setAutoHibernateTimeout",
			"machines.exec",
			...(status === "stopped" ? ["machines.exec"] : []),
		]);
		expect(client.methods("machines.setAutoHibernateTimeout")[0]?.args).toEqual(
			["vm_1", 600],
		);
	});

	test("primes the runtime only after a cold boot", async () => {
		const woken = new FakeBoxd();
		woken.set(machineOf({ id: "vm_1", status: "hibernated" }));
		await run(makeAdapter(woken).resume("vm_1", 600, "pause"));
		expect(woken.execs).toHaveLength(1);
		expect(woken.execs[0]?.params.command).not.toContain("zuse --version");

		const started = new FakeBoxd();
		started.set(machineOf({ id: "vm_1", status: "stopped" }));
		await run(makeAdapter(started).resume("vm_1", 600, "pause"));
		expect(started.execs).toHaveLength(2);
		expect(started.execs[0]?.params.command).toContain(
			"systemctl is-system-running --wait",
		);
		expect(started.execs[1]?.params.command).toContain("zuse --version");
	});

	test("resumes a machine that woke on its own without a wake call", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "running" }));
		await run(makeAdapter(client).resume("vm_1", 600, "pause"));
		expect(client.methods("machines.wake")).toHaveLength(0);
		expect(client.methods("machines.resume")).toHaveLength(0);
	});

	test("tolerates a wake conflict from a machine that inbound traffic already woke", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "hibernated" }));
		client.fail("machines.wake", new ConflictError("VM is running", 9));
		client.machines.waitUntilReady = async (id) => {
			client.calls.push({ method: "machines.waitUntilReady", args: [id] });
			return client.set({ ...client.byIdOrName(id), status: "running" });
		};
		await expect(
			run(makeAdapter(client).resume("vm_1", 600, "pause")),
		).resolves.toMatchObject({ state: "running" });
	});

	test("applies a different placement on resume as a resize", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1", status: "hibernated" }));
		await run(makeAdapter(client).resume("vm_1", 600, "pause", "large"));
		expect(client.methods("machines.resize")[0]?.args).toEqual([
			"vm_1",
			{ vcpu: 4 },
		]);
		// The resize rebooted the machine: the adapter waited for the new boot
		// id, then prepared and primed the runtime again.
		expect(client.execs.map((call) => call.params.command)).toEqual([
			expect.stringContaining("boot_id"),
			expect.stringContaining("boot_id"),
			expect.stringContaining("systemctl is-system-running --wait"),
			expect.stringContaining("zuse --version"),
		]);
	});

	test("reports resuming a failed or missing machine as not found", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_failed", status: "failed" }));
		const adapter = makeAdapter(client);
		await expect(
			run(adapter.resume("vm_failed", 600, "pause")),
		).rejects.toMatchObject({ code: "not-found" });
		await expect(
			run(adapter.resume("vm_missing", 600, "pause")),
		).rejects.toMatchObject({ code: "not-found" });
	});

	test("extends the lease by re-arming the hibernate timer within provider bounds", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		const adapter = makeAdapter(client);
		await run(adapter.extendTimeout("vm_1", 600));
		await run(adapter.extendTimeout("vm_1", 0));
		await run(adapter.extendTimeout("vm_1", 10 ** 9));
		expect(
			client.methods("machines.setAutoHibernateTimeout").map((c) => c.args[1]),
		).toEqual([600, 1, 2_592_000]);
	});

	test("open networking clears host quarantine", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({ id: "vm_1", egressAllow: ["zuse-fork-quarantine.invalid"] }),
		);
		await run(makeAdapter(client).setNetwork("vm_1", { kind: "open" }));
		expect(client.store.get("vm_1")?.egressAllow).toEqual([]);
	});

	test("saves a snapshot and polls it to ready", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		const original = client.snapshots.get;
		let polls = 0;
		client.snapshots.get = async (name, params) => {
			const found = await original(name, params);
			polls += 1;
			return polls < 3 ? found : { ...found, status: "ready" };
		};
		await expect(
			run(makeAdapter(client).snapshot("vm_1", "Project_1-Build_2")),
		).resolves.toBe("zuse-project-1-build-2");
		expect(client.methods("snapshots.create")[0]?.args).toEqual([
			"vm_1",
			"zuse-project-1-build-2",
		]);
		expect(client.methods("snapshots.get")[0]?.args).toEqual([
			"zuse-project-1-build-2",
			{ org: "zuse" },
		]);
	});

	test("returns an already-ready snapshot without re-saving", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await client.snapshots.create("vm_1", "zuse-build-1");
		client.snapshotStore.set("zuse-build-1", {
			...(client.snapshotStore.get("zuse-build-1") as Snapshot),
			status: "ready",
		});
		client.calls.length = 0;
		await expect(
			run(makeAdapter(client).snapshot("vm_1", "build-1")),
		).resolves.toBe("zuse-build-1");
		expect(client.calls.map((call) => call.method)).toEqual(["snapshots.get"]);
	});

	test("replaces a failed snapshot before retrying the save", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await client.snapshots.create("vm_1", "zuse-build-1");
		client.snapshotStore.set("zuse-build-1", {
			...(client.snapshotStore.get("zuse-build-1") as Snapshot),
			status: "failed",
		});
		client.calls.length = 0;
		const original = client.snapshots.get;
		client.snapshots.get = async (name, params) => {
			const found = await original(name, params);
			return client.methods("snapshots.create").length > 0
				? { ...found, status: "ready" }
				: found;
		};
		await expect(
			run(makeAdapter(client).snapshot("vm_1", "build-1")),
		).resolves.toBe("zuse-build-1");
		expect(client.calls.map((call) => call.method).slice(0, 3)).toEqual([
			"snapshots.get",
			"snapshots.delete",
			"snapshots.create",
		]);
	});

	test("reports a snapshot that never becomes ready as transient", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		await expect(
			run(makeAdapter(client).snapshot("vm_1", "build-1")),
		).rejects.toMatchObject({ code: "transient" });
		expect(client.methods("snapshots.create")).toHaveLength(1);
	});

	test("kills machines and deletes snapshots idempotently", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		const adapter = makeAdapter(client);
		await run(adapter.kill("vm_1"));
		await expect(run(adapter.kill("vm_1"))).resolves.toBeUndefined();
		await expect(
			run(adapter.deleteSnapshot("zuse-build-1")),
		).resolves.toBeUndefined();
		expect(client.methods("snapshots.delete")[0]?.args).toEqual([
			"zuse-build-1",
			{ org: "zuse" },
		]);
	});

	test("omits the organization from snapshot and list calls when none is configured", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		const adapter = makeAdapter(client, { org: undefined });
		await run(adapter.deleteSnapshot("zuse-build-1"));
		expect(client.methods("snapshots.delete")[0]?.args).toEqual([
			"zuse-build-1",
			undefined,
		]);
		await expect(run(adapter.recoverByLabel("missing"))).resolves.toBeNull();
		await run(adapter.create(createInput));
		expect(client.methods("machines.create")[0]?.args[0]).not.toHaveProperty(
			"org",
		);
	});

	test.each([
		[new AuthenticationError("bad key", 16), "rejected"],
		[new ConflictError("already exists", 6), "rejected"],
		[new ConflictError("VM is starting", 9), "transient"],
		[new APIStatusError("no machine size has 8 vCPU", 3), "rejected"],
		[new APIStatusError("internal", 13), "transient"],
		[new RateLimitError("slow down", 8), "transient"],
		[new APIConnectionError("unavailable", 14), "transient"],
		[new BoxdError("exec timed out after 60000ms"), "transient"],
		[new Error("boom"), "transient"],
	])("normalizes %s to %s", async (error, code) => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "vm_1" }));
		client.fail("machines.exec", error);
		await expect(
			failure(makeAdapter(client).pathExists("vm_1", "/tmp/x")),
		).resolves.toMatchObject({ code });
	});
});

describe("native boxd machine forks", () => {
	test("forks the running machine with inherited host quarantine and restores only the source", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "parent", status: "pending" }));
		const adapter = makeAdapter(client);
		const child = await run(
			adapter.forkMachine({
				sourceSandboxId: "parent",
				providerLabel: "child",
				timeoutSeconds: 600,
			}),
		);
		expect(client.methods("machines.create")).toHaveLength(0);
		expect(client.methods("machines.fork")[0]?.args).toEqual([
			"parent",
			{
				name: boxdMachineName("child"),
				isolated: true,
				config: { autoSuspendTimeout: 0 },
			},
		]);
		expect(client.store.get("parent")?.egressAllow).toEqual([]);
		expect(client.store.get(child.providerSandboxId)?.egressAllow).toEqual([
			"zuse-fork-quarantine.invalid",
		]);
		expect(client.methods("machines.resize")).toHaveLength(0);
		const methods = client.calls.map((call) => call.method);
		expect(methods.indexOf("machines.waitUntilReady")).toBeLessThan(
			methods.indexOf("machines.fork"),
		);
		expect(methods.indexOf("machines.setEgressAllow")).toBeLessThan(
			methods.indexOf("machines.fork"),
		);
	});
	test("restores the parent's egress policy when fork fails", async () => {
		const client = new FakeBoxd();
		client.set(machineOf({ id: "parent" }));
		client.fail("machines.fork", new NotFoundError("not found", 5));
		await expect(
			run(
				makeAdapter(client).forkMachine({
					sourceSandboxId: "parent",
					providerLabel: "child",
					timeoutSeconds: 600,
				}),
			),
		).rejects.toMatchObject({ code: "not-found" });
		expect(client.store.get("parent")?.egressAllow).toEqual([]);
	});
	test("refuses to clone machines with peer access", async () => {
		const client = new FakeBoxd();
		client.set(
			machineOf({
				id: "parent",
				networking: { isolated: false, networks: [] },
			}),
		);
		await expect(
			run(
				makeAdapter(client).forkMachine({
					sourceSandboxId: "parent",
					providerLabel: "child",
					timeoutSeconds: 600,
				}),
			),
		).rejects.toMatchObject({ code: "rejected" });
		expect(client.methods("machines.fork")).toHaveLength(0);
		expect(client.methods("machines.setEgressAllow")).toHaveLength(0);
	});
});

describe("boxd completed usage", () => {
	test.each([
		"valid",
		"incomplete",
		"eur",
		"wrong-window",
		"wrong-machine",
		"negative",
		"unsafe",
	])("validates %s evidence before billing", async (kind) => {
		const config = {
			apiKey: Redacted.make("usage-test"),
			templateSnapshot: "base",
			templateVersion: "v1",
			billingUsageEnabled: true,
		};
		const client = boxdSandboxClientFor(config);
		const window = {
			startedAtMs: 1_800_000_000_000,
			endedAtMs: 1_800_000_060_000,
		};
		const usage = vi.spyOn(client.machines, "usage").mockResolvedValue({
			machineId: kind === "wrong-machine" ? "other" : "vm",
			name: "vm",
			ownerId: null,
			ownerName: null,
			shared: false,
			status: "deleted",
			period: {
				start: new Date(window.startedAtMs),
				end: new Date(window.endedAtMs + (kind === "wrong-window" ? 1000 : 0)),
			},
			currency: kind === "eur" ? "eur" : "usd",
			complete: kind !== "incomplete",
			resources: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, diskBytes: 0 },
			seconds: { running: 10, standby: 20, stopped: 30, hibernated: 0 },
			vcpuHours: 0,
			ramGibHours: 0,
			diskGibHours: 0,
			costMicro:
				kind === "negative"
					? -1
					: kind === "unsafe"
						? Number.MAX_SAFE_INTEGER + 1
						: 123,
			rates: { vcpuHourMicro: 1, ramGibHourMicro: 1, diskGibHourMicro: 1 },
		});
		try {
			expect(
				makeBoxdSandboxProvider({ ...config, billingUsageEnabled: false })
					.getUsage,
			).toBeUndefined();
			const adapter = makeBoxdSandboxProvider(config);
			if (adapter.getUsage === undefined) throw new Error("usage disabled");
			const result = await Effect.runPromise(
				Effect.result(adapter.getUsage("vm", window)),
			);
			expect(result._tag).toBe(kind === "valid" ? "Success" : "Failure");
			if (result._tag === "Success")
				expect(result.success.providerCostMicros).toBe(123);
			expect(usage).toHaveBeenCalledWith("vm", {
				since: window.startedAtMs / 1000,
				until: window.endedAtMs / 1000,
				org: undefined,
			});
		} finally {
			usage.mockRestore();
		}
	});
});
