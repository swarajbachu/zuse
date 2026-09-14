import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
	BOX_PROVIDER_ID,
	type BoxHttpClient,
	makeBoxSandboxProvider,
} from "../../src/box.ts";

const makeHttp = (
	responses: ReadonlyArray<{
		readonly status: number;
		readonly body?: unknown;
	}>,
): {
	readonly client: BoxHttpClient;
	readonly calls: Array<{ readonly url: string; readonly init?: RequestInit }>;
} => {
	const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
		[];
	let index = 0;
	return {
		calls,
		client: {
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(input), init });
				const response = responses[index++];
				if (response === undefined) throw new Error("unexpected request");
				return new Response(
					response.body === undefined
						? undefined
						: JSON.stringify(response.body),
					{
						status: response.status,
						headers:
							response.body === undefined
								? undefined
								: { "content-type": "application/json" },
					},
				);
			}) as typeof globalThis.fetch,
		},
	};
};

const makeAdapter = (http: BoxHttpClient) =>
	makeBoxSandboxProvider(
		{
			apiKey: Redacted.make("secret-key"),
			templateSnapshot: "zuse-base-v1",
			templateVersion: "v1",
			apiBaseUrl: "https://box.test",
			pollIntervalMs: 1,
			readyDeadlineMs: 10,
			snapshotDeadlineMs: 10,
		},
		http,
	);

const createInput = {
	sandboxId: "sandbox_1",
	providerLabel: "zuse-cloud-workspace-1",
	timeoutSeconds: 300,
	env: { ZUSE_ENROLLMENT_TOKEN: "zenr_secret" },
	network: { kind: "quarantined" } as const,
	onTimeout: "pause" as const,
};

const readyBox = (id: string, state = "ready") => ({
	box: {
		id,
		state,
		name: "zuse-cloud-workspace-1",
		subdomain: "tri-word-slug",
	},
});

const commandResult = (
	exitCode: number,
	stdout = "",
	overrides: Record<string, unknown> = {},
) => ({
	exitCode,
	stdout,
	stderr: "",
	timedOut: false,
	...overrides,
});

const originalFetch = globalThis.fetch;

describe("Box sandbox provider", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("registers with the stable provider id", () => {
		const http = makeHttp([]);

		expect(makeAdapter(http.client).providerId).toBe(BOX_PROVIDER_ID);
	});

	test("records the published template version and machine resources", () => {
		const http = makeHttp([]);
		const adapter = makeBoxSandboxProvider(
			{
				apiKey: Redacted.make("secret-key"),
				templateSnapshot: "zuse-base-v4",
				templateVersion: "v4",
				machineType: "default",
			},
			http.client,
		);

		expect(adapter.templateVersion).toBe("v4");
		expect(adapter.resources).toEqual({ vcpuCount: 4, memoryMib: 8_192 });
	});

	test("defaults to the small machine profile", () => {
		const http = makeHttp([]);

		expect(makeAdapter(http.client).resources).toEqual({
			vcpuCount: 2,
			memoryMib: 4_096,
		});
	});

	test("uses the official API endpoint by default", async () => {
		const http = makeHttp([{ status: 200, body: { boxes: [] } }]);
		const adapter = makeBoxSandboxProvider(
			{
				apiKey: Redacted.make("secret-key"),
				templateSnapshot: "zuse-base-v1",
				templateVersion: "v1",
			},
			http.client,
		);

		await Effect.runPromise(adapter.recoverByLabel("zuse-cloud-workspace-1"));

		expect(http.calls[0]?.url).toBe(
			"https://ascii.dev/api/box/v1/boxes?limit=100&state=init%2Cprovisioning%2Cprovisioned%2Ccloning%2Cready%2Cidle%2Crunning%2Carchiving%2Carchived",
		);
		expect(http.calls[0]?.init?.headers).toMatchObject({
			authorization: "Bearer secret-key",
		});
	});

	test("invokes the Worker fetch global with its required receiver", async () => {
		let callCount = 0;
		const workerFetch = function (this: unknown) {
			callCount += 1;
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(
				new Response(JSON.stringify({ boxes: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		};
		globalThis.fetch = workerFetch as typeof globalThis.fetch;
		const adapter = makeBoxSandboxProvider({
			apiKey: Redacted.make("secret-key"),
			templateSnapshot: "zuse-base-v1",
			templateVersion: "v1",
		});

		await expect(
			Effect.runPromise(adapter.recoverByLabel("zuse-cloud-workspace-1")),
		).resolves.toBeNull();
		expect(callCount).toBe(1);
	});

	test("creates from the base template, labels first, and verifies quarantine", async () => {
		const http = makeHttp([
			{ status: 202, body: { box: { id: "bx_1", state: "provisioning" } } },
			{ status: 200, body: {} },
			{ status: 200, body: readyBox("bx_1") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
		]);
		const adapter = makeAdapter(http.client);

		const created = await Effect.runPromise(adapter.create(createInput));

		expect(created).toEqual({
			providerSandboxId: "bx_1",
			providerLabel: "zuse-cloud-workspace-1",
			state: "running",
		});
		expect(http.calls[0]?.url).toBe("https://box.test/boxes");
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			from: "zuse-base-v1",
			type: "small",
			ttlSeconds: 300,
			env: { ZUSE_ENROLLMENT_TOKEN: "zenr_secret" },
		});
		expect(http.calls[1]?.url).toBe("https://box.test/boxes/bx_1");
		expect(http.calls[1]?.init?.method).toBe("PATCH");
		expect(JSON.parse(String(http.calls[1]?.init?.body))).toEqual({
			name: "zuse-cloud-workspace-1",
		});
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			"install -d -m 0755 -o zuse -g zuse /srv/zuse/home /srv/zuse/repos",
		);
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			'ln -s "$persistent" "$logical"',
		);
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			"touch /srv/zuse/.layout-v1",
		);
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			"/run/zuse-secrets",
		);
		const apply = JSON.parse(String(http.calls[4]?.init?.body));
		expect(apply.command).toContain("zuse-firewall apply");
		const verify = JSON.parse(String(http.calls[5]?.init?.body));
		expect(verify.command).toBe(
			"sudo -n /usr/local/sbin/zuse-firewall verify-quarantined",
		);
	});

	test("applies an open policy through the in-guest firewall after create", async () => {
		const http = makeHttp([
			{ status: 202, body: { box: { id: "bx_1", state: "provisioning" } } },
			{ status: 200, body: {} },
			{ status: 200, body: readyBox("bx_1") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.create({ ...createInput, network: { kind: "open" } }),
		);

		const apply = JSON.parse(String(http.calls[4]?.init?.body));
		expect(apply.command).toContain(
			"systemctl is-active --quiet zuse-firewall.service",
		);
		expect(apply.command).toContain(
			`sudo -n /usr/local/sbin/zuse-firewall apply '${btoa(
				JSON.stringify({ kind: "open" }),
			)}'`,
		);
		expect(apply.command).toContain(
			"sudo -n tee /var/lib/zuse-firewall/policy.b64",
		);
	});

	test("forks from a snapshot and verifies a requested quarantine", async () => {
		const http = makeHttp([
			{ status: 202, body: { box: { id: "bx_fork", state: "cloning" } } },
			{ status: 200, body: {} },
			{ status: 200, body: readyBox("bx_fork") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
		]);
		const adapter = makeAdapter(http.client);

		const forked = await Effect.runPromise(
			adapter.fork({
				sandboxId: "sandbox_2",
				providerLabel: "zuse-cloud-workspace-2",
				snapshotId: "zuse-build-snap-1",
				network: { kind: "quarantined" },
				timeoutSeconds: 120,
				env: { ZUSE_ENROLLMENT_TOKEN: "zenr_fork" },
				onTimeout: "pause",
			}),
		);

		expect(forked.providerSandboxId).toBe("bx_fork");
		const body = JSON.parse(String(http.calls[0]?.init?.body));
		expect(body.from).toBe("zuse-build-snap-1");
		expect(body.noEnv).toBeUndefined();
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			"test -f /srv/zuse/.layout-v1",
		);
		expect(JSON.parse(String(http.calls[5]?.init?.body)).command).toContain(
			"verify-quarantined",
		);
	});

	test("destroys a fork whose quarantine barrier cannot be verified", async () => {
		const http = makeHttp([
			{ status: 202, body: { box: { id: "bx_fork", state: "cloning" } } },
			{ status: 200, body: {} },
			{ status: 200, body: readyBox("bx_fork") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
			{ status: 200, body: {} },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(
				adapter.fork({
					sandboxId: "sandbox_2",
					providerLabel: "zuse-cloud-workspace-2",
					snapshotId: "zuse-build-snap-1",
					timeoutSeconds: 120,
					env: {},
					network: { kind: "quarantined" },
					onTimeout: "pause",
				}),
			),
		).rejects.toMatchObject({ code: "transient" });
		expect(http.calls[14]?.init?.method).toBe("DELETE");
		expect(http.calls[14]?.url).toBe("https://box.test/boxes/bx_fork");
	});

	test("destroys a create that lands in the error state", async () => {
		const http = makeHttp([
			{ status: 202, body: { box: { id: "bx_1", state: "provisioning" } } },
			{ status: 200, body: {} },
			{ status: 200, body: { box: { id: "bx_1", state: "error" } } },
			{ status: 200, body: {} },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.create(createInput)),
		).rejects.toMatchObject({ code: "rejected" });
		expect(http.calls[3]?.init?.method).toBe("DELETE");
	});

	test("recovers a timed-out create by deterministic label", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					boxes: [
						{ id: "bx_other", state: "running", name: "something-else" },
						{ id: "bx_9", state: "archived", name: "zuse-cloud-workspace-9" },
					],
				},
			},
		]);
		const adapter = makeAdapter(http.client);

		const recovered = await Effect.runPromise(
			adapter.recoverByLabel("zuse-cloud-workspace-9"),
		);

		expect(recovered).toEqual({
			providerSandboxId: "bx_9",
			providerLabel: "zuse-cloud-workspace-9",
			state: "paused",
		});
	});

	test("follows list pagination until the label is found", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					boxes: [{ id: "bx_1", state: "running", name: "other" }],
					pageInfo: { nextCursor: "cursor-2" },
				},
			},
			{
				status: 200,
				body: {
					boxes: [
						{ id: "bx_2", state: "running", name: "zuse-cloud-workspace-9" },
					],
					pageInfo: { nextCursor: null },
				},
			},
		]);
		const adapter = makeAdapter(http.client);

		const recovered = await Effect.runPromise(
			adapter.recoverByLabel("zuse-cloud-workspace-9"),
		);

		expect(recovered?.providerSandboxId).toBe("bx_2");
		expect(http.calls[1]?.url).toContain("cursor=cursor-2");
	});

	test("treats a missing inspected box as absent", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.inspect("missing")),
		).resolves.toBeNull();
	});

	test("treats an errored box as absent on inspect", async () => {
		const http = makeHttp([
			{ status: 200, body: { box: { id: "bx_1", state: "error" } } },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.inspect("bx_1")),
		).resolves.toBeNull();
	});

	test("starts a detached process with user, env, cwd, and tag wrapping", async () => {
		const http = makeHttp([{ status: 200, body: { processId: 7, pid: 42 } }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.startProcess("bx_1", {
				command: "/usr/local/bin/zuse-workspace-bootstrap",
				args: ["--resume"],
				cwd: "/home/zuse",
				env: { ZUSE_API_URL: "https://api.test" },
				user: "zuse",
				tag: "zuse-runtime",
			}),
		);

		const body = JSON.parse(String(http.calls[0]?.init?.body));
		expect(body.detached).toBe(true);
		expect(body.command).toBe(
			"sudo -n -E -H -u 'zuse' setsid bash -c 'mkdir -p \"$HOME/.zuse-processes\" && " +
				'echo $$ > "$HOME/.zuse-processes/zuse-runtime.pid" && ' +
				"cd '\\''/home/zuse'\\'' && " +
				"export ZUSE_API_URL='\\''https://api.test'\\'' && " +
				"exec '\\''/usr/local/bin/zuse-workspace-bootstrap'\\'' '\\''--resume'\\'''",
		);
	});

	test("starts a detached process in the target user's home by default", async () => {
		const http = makeHttp([{ status: 200, body: { processId: 7, pid: 42 } }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.startProcess("bx_1", {
				command: "/usr/bin/find",
				args: ["/home/repos"],
				user: "zuse",
			}),
		);

		const body = JSON.parse(String(http.calls[0]?.init?.body));
		expect(body.command).toContain('cd "$HOME" &&');
		expect(body.command).toContain("/usr/bin/find");
	});

	test("rejects invalid environment variable names before calling the API", async () => {
		const http = makeHttp([]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(
				adapter.startProcess("bx_1", {
					command: "true",
					env: { "bad-key": "value" },
				}),
			),
		).rejects.toMatchObject({ code: "rejected" });
		expect(http.calls).toHaveLength(0);
	});

	test("replaces a tagged process and cleans legacy runtimes", async () => {
		const http = makeHttp([
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: { processId: 8, pid: 43 } },
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.replaceProcess(
				"bx_1",
				{
					tag: "zuse-runtime",
					legacyCommandMarkers: ["zuse-workspace-bootstrap"],
					legacyCleanup: "matching-command",
				},
				{ command: "/opt/zuse/current/bin.mjs", args: ["serve"], user: "zuse" },
			),
		);

		const killBody = JSON.parse(String(http.calls[0]?.init?.body));
		expect(killBody.command).toContain("sudo -n -E -H -u 'zuse'");
		expect(killBody.command).toContain("zuse-runtime.pid");
		expect(killBody.command).toContain('kill -KILL -- "-$pid"');
		expect(killBody.command).toContain(
			"pkill -KILL -f -- '\\''zuse-workspace-bootstrap'\\'' || true",
		);
		const startBody = JSON.parse(String(http.calls[1]?.init?.body));
		expect(startBody.detached).toBe(true);
		expect(startBody.command).toContain("zuse-runtime.pid");
		expect(startBody.command).toContain("/opt/zuse/current/bin.mjs");
	});

	test("maps path existence onto the test exit code", async () => {
		const http = makeHttp([
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(1) },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.pathExists("bx_1", "/home/zuse/.ready")),
		).resolves.toBe(true);
		await expect(
			Effect.runPromise(adapter.pathExists("bx_1", "/home/zuse/.missing")),
		).resolves.toBe(false);
		expect(JSON.parse(String(http.calls[0]?.init?.body)).command).toBe(
			"sudo -n test -e '/home/zuse/.ready'",
		);
	});

	test("reads a text file and treats a read failure as not found", async () => {
		const http = makeHttp([
			{ status: 200, body: commandResult(0, "file-contents\n") },
			{ status: 200, body: commandResult(1) },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.readTextFile("bx_1", "/tmp/zuse-version")),
		).resolves.toBe("file-contents\n");
		await expect(
			Effect.runPromise(adapter.readTextFile("bx_1", "/tmp/zuse-missing")),
		).rejects.toMatchObject({ code: "not-found" });
	});

	test("rejects reads that exceed the text file cap", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: commandResult(0, "x", { stdoutTruncated: true }),
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.readTextFile("bx_1", "/tmp/huge")),
		).rejects.toMatchObject({ code: "rejected" });
	});

	test("writes a text file through staging with owner-only permissions", async () => {
		const http = makeHttp([
			{ status: 200, body: {} },
			{ status: 200, body: commandResult(0) },
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.writeTextFile(
				"bx_1",
				"/run/zuse-secrets/boot-token",
				"token-value",
				"zuse",
			),
		);

		expect(http.calls[0]?.init?.method).toBe("PUT");
		expect(http.calls[0]?.url).toBe("https://box.test/boxes/bx_1/files");
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			path: expect.stringMatching(/^\/tmp\/\.zuse-write-/u),
			content: "token-value",
			encoding: "utf8",
		});
		const install = JSON.parse(String(http.calls[1]?.init?.body)).command;
		expect(install).toContain("sudo -n install -D -m 600 -o 'zuse' -g 'zuse'");
		expect(install).toContain("'/run/zuse-secrets/boot-token'");
	});

	test("rejects writes that exceed the text file cap", async () => {
		const http = makeHttp([]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(
				adapter.writeTextFile("bx_1", "/tmp/huge", "x".repeat(70_000)),
			),
		).rejects.toMatchObject({ code: "rejected" });
		expect(http.calls).toHaveLength(0);
	});

	test("composes hosted-port endpoints from the box subdomain", async () => {
		const http = makeHttp([
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: readyBox("bx_1") },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.resolveEndpoint("bx_1", 47_837)),
		).resolves.toEqual({
			httpBaseUrl: "https://tri-word-slug-47837.on.ascii.dev",
			wsBaseUrl: "wss://tri-word-slug-47837.on.ascii.dev",
		});
		expect(JSON.parse(String(http.calls[0]?.init?.body)).command).toBe(
			"host 47837 --public >/dev/null",
		);
	});

	test("treats an unassigned subdomain as transient", async () => {
		const http = makeHttp([
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: { box: { id: "bx_1", state: "provisioning" } } },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.resolveEndpoint("bx_1", 47_837)),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("treats stopping an already-archived box as success", async () => {
		const http = makeHttp([
			{ status: 409, body: { code: "already_archived" } },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.pause("bx_1")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.url).toBe("https://box.test/boxes/bx_1/stop");
	});

	test("resumes with a fresh TTL and re-inspects the box", async () => {
		const http = makeHttp([
			{ status: 202, body: {} },
			{ status: 200, body: readyBox("bx_1") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: readyBox("bx_1") },
		]);
		const adapter = makeAdapter(http.client);

		const resumed = await Effect.runPromise(
			adapter.resume("bx_1", 600, "pause"),
		);

		expect(resumed.state).toBe("running");
		expect(http.calls[0]?.url).toBe("https://box.test/boxes/bx_1/resume");
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			ttlSeconds: 600,
		});
		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toBe(
			"sudo -n /usr/local/sbin/zuse-firewall restore",
		);
	});

	test("resumes a legacy-template box using its persisted policy", async () => {
		const http = makeHttp([
			{ status: 202, body: {} },
			{ status: 200, body: readyBox("bx_1") },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: commandResult(2) },
			{ status: 200, body: commandResult(0) },
			{ status: 200, body: readyBox("bx_1") },
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(adapter.resume("bx_1", 600, "pause"));

		expect(JSON.parse(String(http.calls[3]?.init?.body)).command).toContain(
			"zuse-firewall restore",
		);
		expect(JSON.parse(String(http.calls[4]?.init?.body)).command).toContain(
			"cat /var/lib/zuse-firewall/policy.b64",
		);
	});

	test("extends the box TTL through a metadata update", async () => {
		const http = makeHttp([{ status: 200, body: {} }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(adapter.extendTimeout("bx_1", 600));

		expect(http.calls[0]?.init?.method).toBe("PATCH");
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			ttlSeconds: 600,
		});
	});

	test("writes the complete network policy in a single firewall call", async () => {
		const http = makeHttp([{ status: 200, body: commandResult(0) }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.setNetwork("bx_1", {
				kind: "restricted",
				allowOut: ["api.zuse.test"],
				denyOut: ["0.0.0.0/0"],
			}),
		);

		const command = JSON.parse(String(http.calls[0]?.init?.body)).command;
		const encoded = /apply '([^']+)'/u.exec(command)?.[1] ?? "";
		expect(JSON.parse(atob(encoded))).toEqual({
			kind: "restricted",
			allowOut: ["api.zuse.test"],
			denyOut: ["0.0.0.0/0"],
		});
	});

	test("saves a named snapshot and polls it to ready", async () => {
		const http = makeHttp([
			{ status: 404 },
			{ status: 202, body: { snapshot: { name: "n", status: "saving" } } },
			{
				status: 200,
				body: { snapshot: { name: "n", status: "saving" } },
			},
			{
				status: 200,
				body: { snapshot: { name: "n", status: "ready" } },
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.snapshot("bx_1", "Project_1-Build_2")),
		).resolves.toBe("zuse-project-1-build-2");
		expect(http.calls[1]?.url).toBe("https://box.test/named-snapshots");
		expect(JSON.parse(String(http.calls[1]?.init?.body))).toEqual({
			boxId: "bx_1",
			name: "zuse-project-1-build-2",
		});
	});

	test("returns an already-ready named snapshot without re-saving", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: { snapshot: { name: "zuse-build-1", status: "ready" } },
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.snapshot("bx_1", "build-1")),
		).resolves.toBe("zuse-build-1");
		expect(http.calls).toHaveLength(1);
	});

	test("replaces a failed named snapshot before retrying the save", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: { snapshot: { name: "zuse-build-1", status: "failed" } },
			},
			{ status: 200, body: {} },
			{ status: 202, body: {} },
			{
				status: 200,
				body: { snapshot: { name: "zuse-build-1", status: "ready" } },
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.snapshot("bx_1", "build-1")),
		).resolves.toBe("zuse-build-1");
		expect(http.calls[1]?.init?.method).toBe("DELETE");
		expect(http.calls[2]?.init?.method).toBe("POST");
	});

	test("treats killing an already-gone box as success", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.kill("bx_gone")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.init?.method).toBe("DELETE");
		expect(http.calls[0]?.init?.headers).toMatchObject({
			"x-ascii-confirm-delete": "bx_gone",
		});
	});

	test("retries a conflicting delete instead of failing permanently", async () => {
		const http = makeHttp([
			{ status: 409, body: { code: "stop_in_progress" } },
		]);
		const adapter = makeAdapter(http.client);

		await expect(Effect.runPromise(adapter.kill("bx_1"))).rejects.toMatchObject(
			{ code: "transient" },
		);
	});

	test.each([
		401, 403, 422,
	])("preserves permanent delete rejection %s", async (status) => {
		const http = makeHttp([{ status, body: { code: "access_denied" } }]);
		await expect(
			Effect.runPromise(makeAdapter(http.client).kill("bx_1")),
		).rejects.toMatchObject({ code: "rejected" });
	});

	test("deletes named snapshots idempotently", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.deleteSnapshot("zuse-build-1")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.url).toBe(
			"https://box.test/named-snapshots/zuse-build-1",
		);
	});

	test("treats a starting box conflict as retryable", async () => {
		const http = makeHttp([{ status: 409, body: { code: "box_starting" } }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.pathExists("bx_1", "/tmp/ready")),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("normalizes auth failures to rejected", async () => {
		const http = makeHttp([{ status: 401 }]);
		const adapter = makeAdapter(http.client);

		const result = await Effect.runPromise(
			adapter.create(createInput).pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "rejected" },
		});
	});

	test("normalizes network failures to transient", async () => {
		const adapter = makeAdapter({
			fetch: (() =>
				Promise.reject(new Error("boom"))) as typeof globalThis.fetch,
		});

		const result = await Effect.runPromise(
			adapter.inspect("bx_1").pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "transient" },
		});
	});

	test("normalizes undecodable payloads to transient", async () => {
		const http = makeHttp([{ status: 200, body: { unexpected: true } }]);
		const adapter = makeAdapter(http.client);

		const result = await Effect.runPromise(
			adapter.inspect("bx_1").pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "transient" },
		});
	});
});
