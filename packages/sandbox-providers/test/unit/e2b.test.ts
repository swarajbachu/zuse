import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
	E2B_PROVIDER_ID,
	type E2bHttpClient,
	makeE2bSandboxProvider,
} from "../../src/e2b.ts";

const makeHttp = (
	responses: ReadonlyArray<{
		readonly status: number;
		readonly body?: unknown;
		readonly rawBody?: BodyInit;
	}>,
): {
	readonly client: E2bHttpClient;
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
					response.rawBody ??
						(response.body === undefined
							? undefined
							: JSON.stringify(response.body)),
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

const makeAdapter = (http: E2bHttpClient) =>
	makeE2bSandboxProvider(
		{
			apiKey: Redacted.make("secret-key"),
			templateId: "zuse-base",
			apiBaseUrl: "https://sandbox.test",
		},
		http,
	);

const createInput = {
	sandboxId: "sandbox_1",
	providerLabel: "zuse-sandbox-1",
	timeoutSeconds: 300,
	env: { ZUSE_ENROLLMENT_TOKEN: "zenr_secret" },
	network: { kind: "quarantined" } as const,
	onTimeout: "pause" as const,
};

const originalFetch = globalThis.fetch;

const decodeConnectJsonBody = (body: BodyInit | null | undefined): unknown => {
	if (!(body instanceof Uint8Array))
		throw new Error("expected Connect envelope");
	const bytes = body as Uint8Array<ArrayBuffer>;
	const length = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(1, false);
	return JSON.parse(new TextDecoder().decode(bytes.slice(5, 5 + length)));
};

const connectJsonResponse = (value: unknown): Uint8Array<ArrayBuffer> => {
	const payload = new TextEncoder().encode(JSON.stringify(value));
	const frame = new Uint8Array(payload.byteLength + 5);
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
};

describe("E2B sandbox provider", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("registers with the stable provider id", () => {
		const http = makeHttp([]);

		expect(makeAdapter(http.client).providerId).toBe(E2B_PROVIDER_ID);
	});

	test("records the published template build as its version", () => {
		const http = makeHttp([]);
		const adapter = makeE2bSandboxProvider(
			{
				apiKey: Redacted.make("secret-key"),
				templateId: "zuse-base",
				templateVersion: "build-4",
			},
			http.client,
		);

		expect(adapter.templateVersion).toBe("build-4");
	});

	test("uses the official API endpoint by default", async () => {
		const http = makeHttp([{ status: 200, body: [] }]);
		const adapter = makeE2bSandboxProvider(
			{ apiKey: Redacted.make("secret-key"), templateId: "zuse-base" },
			http.client,
		);

		await Effect.runPromise(adapter.recoverByLabel("zuse-sandbox-1"));

		expect(http.calls[0]?.url).toBe(
			"https://api.e2b.app/v2/sandboxes?state=running,paused&metadata=zuse-label%3Dzuse-sandbox-1",
		);
	});

	test("invokes the Worker fetch global with its required receiver", async () => {
		let callCount = 0;
		const workerFetch = function (this: unknown) {
			callCount += 1;
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		};
		globalThis.fetch = workerFetch as typeof globalThis.fetch;
		const adapter = makeE2bSandboxProvider({
			apiKey: Redacted.make("secret-key"),
			templateId: "zuse-base",
		});

		await expect(
			Effect.runPromise(adapter.recoverByLabel("zuse-sandbox-1")),
		).resolves.toBeNull();
		expect(callCount).toBe(1);
	});

	test("creates a sandbox with enrollment env, label metadata, and quarantine", async () => {
		const http = makeHttp([
			{ status: 201, body: { sandboxID: "sbx_1", domain: "custom.e2b.app" } },
		]);
		const adapter = makeAdapter(http.client);

		const created = await Effect.runPromise(adapter.create(createInput));

		expect(created).toEqual({
			providerSandboxId: "sbx_1",
			providerLabel: "zuse-sandbox-1",
			state: "running",
		});
		expect(http.calls[0]?.url).toBe("https://sandbox.test/sandboxes");
		expect(http.calls[0]?.init?.headers).toMatchObject({
			"x-api-key": "secret-key",
		});
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			templateID: "zuse-base",
			timeout: 300,
			secure: true,
			metadata: {
				"zuse-sandbox-id": "sandbox_1",
				"zuse-label": "zuse-sandbox-1",
			},
			envVars: { ZUSE_ENROLLMENT_TOKEN: "zenr_secret" },
			allow_internet_access: false,
			autoPause: true,
		});
	});

	test("falls back to the default sandbox domain when the API omits it", async () => {
		const http = makeHttp([{ status: 201, body: { sandboxID: "sbx_1" } }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.create({ ...createInput, network: { kind: "open" } }),
		);

		const endpointHttp = makeHttp([
			{ status: 200, body: { sandboxID: "sbx_1", state: "running" } },
		]);
		const endpointAdapter = makeAdapter(endpointHttp.client);
		await expect(
			Effect.runPromise(endpointAdapter.resolveEndpoint("sbx_1", 47_837)),
		).resolves.toEqual({
			httpBaseUrl: "https://47837-sbx_1.e2b.app",
			wsBaseUrl: "wss://47837-sbx_1.e2b.app",
		});
		expect(
			JSON.parse(String(http.calls[0]?.init?.body)).allow_internet_access,
		).toBe(true);
	});

	test("maps a restricted policy onto the network create field", async () => {
		const http = makeHttp([{ status: 201, body: { sandboxID: "sbx_1" } }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.create({
				...createInput,
				network: {
					kind: "restricted",
					allowOut: ["relay.zuse.test"],
					denyOut: ["10.0.0.0/8"],
				},
			}),
		);

		const body = JSON.parse(String(http.calls[0]?.init?.body));
		expect(body.network).toEqual({
			allowOut: ["relay.zuse.test"],
			denyOut: ["10.0.0.0/8"],
		});
		expect(body.allow_internet_access).toBeUndefined();
	});

	test("omits unsupported IPv6 deny rules from E2B network policies", async () => {
		const http = makeHttp([
			{ status: 201, body: { sandboxID: "sbx_1" } },
			{ status: 204 },
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.create({
				...createInput,
				network: {
					kind: "restricted",
					allowOut: ["relay.zuse.test"],
					denyOut: ["0.0.0.0/0", "::/0"],
				},
			}),
		);
		await Effect.runPromise(
			adapter.setNetwork("sbx_1", {
				kind: "restricted",
				allowOut: ["relay.zuse.test"],
				denyOut: ["0.0.0.0/0", "::/0"],
			}),
		);

		expect(JSON.parse(String(http.calls[0]?.init?.body)).network).toEqual({
			allowOut: ["relay.zuse.test"],
			denyOut: ["0.0.0.0/0"],
		});
		expect(JSON.parse(String(http.calls[1]?.init?.body))).toEqual({
			allowOut: ["relay.zuse.test"],
			denyOut: ["0.0.0.0/0"],
		});
	});

	test("forks from a snapshot and always starts quarantined", async () => {
		const http = makeHttp([{ status: 201, body: { sandboxID: "sbx_fork" } }]);
		const adapter = makeAdapter(http.client);

		const forked = await Effect.runPromise(
			adapter.fork({
				sandboxId: "sandbox_2",
				providerLabel: "zuse-sandbox-2",
				snapshotId: "snap_1:default",
				timeoutSeconds: 120,
				env: { ZUSE_ENROLLMENT_TOKEN: "zenr_fork" },
				onTimeout: "pause",
			}),
		);

		expect(forked.providerSandboxId).toBe("sbx_fork");
		const body = JSON.parse(String(http.calls[0]?.init?.body));
		expect(body.templateID).toBe("snap_1:default");
		expect(body.allow_internet_access).toBe(false);
	});

	test("recovers a timed-out create by deterministic label", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: [
					{
						sandboxID: "sbx_9",
						state: "paused",
						metadata: { "zuse-label": "zuse-sandbox-9" },
					},
				],
			},
		]);
		const adapter = makeAdapter(http.client);

		const recovered = await Effect.runPromise(
			adapter.recoverByLabel("zuse-sandbox-9"),
		);

		expect(recovered).toEqual({
			providerSandboxId: "sbx_9",
			providerLabel: "zuse-sandbox-9",
			state: "paused",
		});
	});

	test("ignores listed sandboxes whose label does not match exactly", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: [
					{
						sandboxID: "sbx_other",
						state: "running",
						metadata: { "zuse-label": "zuse-sandbox-other" },
					},
				],
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.recoverByLabel("zuse-sandbox-9")),
		).resolves.toBeNull();
	});

	test("treats a missing inspected sandbox as absent", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.inspect("missing")),
		).resolves.toBeNull();
	});

	test("starts a process through the sandbox envd endpoint", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					sandboxID: "sbx_1",
					state: "running",
					domain: "custom.e2b.app",
					metadata: { "zuse-label": "zuse-sandbox-1" },
					envdAccessToken: "envd-secret",
				},
			},
			{
				status: 201,
				body: {
					sandboxID: "sbx_1",
					envdAccessToken: "envd-secret",
				},
			},
			{
				status: 200,
				rawBody: connectJsonResponse({ event: { start: { pid: 42 } } }),
			},
		]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(
			adapter.startProcess("sbx_1", {
				command: "/usr/local/bin/zuse-entrypoint",
				cwd: "/home/zuse",
				env: { ZUSE_MACHINE_ID: "machine_1" },
				user: "zuse",
			}),
		);

		expect(http.calls[1]?.url).toBe(
			"https://sandbox.test/sandboxes/sbx_1/connect",
		);
		expect(http.calls[2]?.url).toBe(
			"https://49983-sbx_1.custom.e2b.app/process.Process/Start",
		);
		expect(http.calls[2]?.init?.headers).toMatchObject({
			"Connect-Protocol-Version": "1",
			"Content-Type": "application/connect+json",
			"E2b-Sandbox-Id": "sbx_1",
			"E2b-Sandbox-Port": "49983",
			"X-Access-Token": "envd-secret",
			Authorization: "Basic enVzZTo=",
		});
		expect(decodeConnectJsonBody(http.calls[2]?.init?.body)).toEqual({
			process: {
				cmd: "/usr/local/bin/zuse-entrypoint",
				args: [],
				cwd: "/home/zuse",
				envs: { ZUSE_MACHINE_ID: "machine_1" },
			},
			stdin: false,
		});
	});

	test("rejects a process stream that does not confirm the process started", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					sandboxID: "sbx_1",
					state: "running",
					domain: "custom.e2b.app",
				},
			},
			{
				status: 201,
				body: { sandboxID: "sbx_1", envdAccessToken: "envd-secret" },
			},
			{
				status: 200,
				rawBody: connectJsonResponse({ event: { data: "not-started" } }),
			},
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(
				adapter.startProcess("sbx_1", {
					command: "/usr/local/bin/zuse-entrypoint",
				}),
			),
		).rejects.toMatchObject({ code: "transient" });
	});

	test("rejects process startup when secure access credentials are absent", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					sandboxID: "sbx_1",
					state: "running",
					metadata: {},
				},
			},
			{ status: 201, body: { sandboxID: "sbx_1" } },
		]);

		await expect(
			Effect.runPromise(
				makeAdapter(http.client).startProcess("sbx_1", {
					command: "true",
				}),
			),
		).rejects.toMatchObject({ code: "rejected" });
	});

	test("treats pausing an already-paused sandbox as success", async () => {
		const http = makeHttp([{ status: 409 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.pause("sbx_1")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.url).toBe(
			"https://sandbox.test/sandboxes/sbx_1/pause",
		);
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			memory: true,
		});
	});

	test("resumes through connect and re-inspects the sandbox", async () => {
		const http = makeHttp([
			{ status: 201, body: { sandboxID: "sbx_1" } },
			{
				status: 200,
				body: {
					sandboxID: "sbx_1",
					state: "running",
					metadata: { "zuse-label": "zuse-sandbox-1" },
				},
			},
		]);
		const adapter = makeAdapter(http.client);

		const resumed = await Effect.runPromise(
			adapter.resume("sbx_1", 300, "pause"),
		);

		expect(resumed.state).toBe("running");
		expect(http.calls[0]?.url).toBe(
			"https://sandbox.test/sandboxes/sbx_1/connect",
		);
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			timeout: 300,
			autoPause: true,
		});
		expect(http.calls[1]?.url).toBe("https://sandbox.test/sandboxes/sbx_1");
	});

	test("extends the sandbox timeout", async () => {
		const http = makeHttp([{ status: 204 }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(adapter.extendTimeout("sbx_1", 600));

		expect(http.calls[0]?.url).toBe(
			"https://sandbox.test/sandboxes/sbx_1/timeout",
		);
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			timeout: 600,
		});
	});

	test("writes the complete network policy in a single call", async () => {
		const http = makeHttp([{ status: 204 }, { status: 204 }, { status: 204 }]);
		const adapter = makeAdapter(http.client);

		await Effect.runPromise(adapter.setNetwork("sbx_1", { kind: "open" }));
		await Effect.runPromise(
			adapter.setNetwork("sbx_1", { kind: "quarantined" }),
		);
		await Effect.runPromise(
			adapter.setNetwork("sbx_1", {
				kind: "restricted",
				allowOut: ["relay.zuse.test"],
				denyOut: [],
			}),
		);

		expect(
			http.calls.map((call) => ({
				url: call.url,
				method: call.init?.method,
				body: JSON.parse(String(call.init?.body)),
			})),
		).toEqual([
			{
				url: "https://sandbox.test/sandboxes/sbx_1/network",
				method: "PUT",
				body: { allow_internet_access: true },
			},
			{
				url: "https://sandbox.test/sandboxes/sbx_1/network",
				method: "PUT",
				body: { allow_internet_access: false },
			},
			{
				url: "https://sandbox.test/sandboxes/sbx_1/network",
				method: "PUT",
				body: { allowOut: ["relay.zuse.test"], denyOut: [] },
			},
		]);
	});

	test("creates a snapshot and returns its provider id", async () => {
		const http = makeHttp([
			{ status: 201, body: { snapshotID: "snap_1:default" } },
		]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.snapshot("sbx_1", "zuse-final")),
		).resolves.toBe("snap_1:default");
		expect(http.calls[0]?.url).toBe(
			"https://sandbox.test/sandboxes/sbx_1/snapshots",
		);
		expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({
			name: "zuse-final",
		});
	});

	test("treats killing an already-gone sandbox as success", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.kill("sbx_gone")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.init?.method).toBe("DELETE");
	});

	test("deletes snapshots idempotently through the template store", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.deleteSnapshot("team/snap:default")),
		).resolves.toBeUndefined();
		expect(http.calls[0]?.url).toBe(
			"https://sandbox.test/templates/team%2Fsnap%3Adefault",
		);
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
			adapter.inspect("sbx_1").pipe(Effect.result),
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
			adapter.snapshot("sbx_1", "zuse-final").pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "transient" },
		});
	});
});
