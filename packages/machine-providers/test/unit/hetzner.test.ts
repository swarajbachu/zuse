import type { MachineOffer } from "@zuse/contracts";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
	HETZNER_PROVIDER_ID,
	type HetznerHttpClient,
	makeHetznerMachineProvider,
} from "../../src/hetzner.ts";

const offer: MachineOffer = {
	kind: "persistent",
	offerId: "persistent-standard-v1",
	displayName: "Standard",
	architecture: "x86_64",
	vcpuCount: 4,
	memoryMib: 8_192,
	diskGib: 80,
	location: "Germany",
	monthlyPriceCents: 1_900,
	currency: "USD",
	automaticBackups: true,
	available: true,
};

const makeHttp = (
	responses: ReadonlyArray<{
		readonly status: number;
		readonly body?: unknown;
	}>,
): {
	readonly client: HetznerHttpClient;
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

const makeAdapter = (http: HetznerHttpClient) =>
	makeHetznerMachineProvider(
		{
			accessToken: Redacted.make("secret-token"),
			apiBaseUrl: "https://cloud.test/v1",
			offerProfiles: {
				"persistent-standard-v1": {
					serverType: "standard-4-8",
					image: "ubuntu-current",
					location: "eu-1",
					firewallId: 42,
				},
			},
			renderUserData: ({ machineId, enrollmentToken }) =>
				`machine=${machineId}\ntoken=${enrollmentToken}`,
		},
		http,
	);

const originalFetch = globalThis.fetch;

describe("Hetzner machine provider", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("registers with the stable provider id", () => {
		const http = makeHttp([]);

		expect(makeAdapter(http.client).providerId).toBe(HETZNER_PROVIDER_ID);
	});

	test("uses the official API endpoint by default", async () => {
		const http = makeHttp([{ status: 200, body: { servers: [] } }]);
		const adapter = makeHetznerMachineProvider(
			{
				accessToken: Redacted.make("secret-token"),
				offerProfiles: {},
				renderUserData: () => "",
			},
			http.client,
		);

		await Effect.runPromise(adapter.recoverByLabel("zuse-machine-1"));

		expect(http.calls[0]?.url).toBe(
			"https://api.hetzner.cloud/v1/servers?name=zuse-machine-1",
		);
	});

	test("invokes the Worker fetch global with its required receiver", async () => {
		let callCount = 0;
		const workerFetch = function (this: unknown) {
			callCount += 1;
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(
				new Response(JSON.stringify({ servers: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		};
		globalThis.fetch = workerFetch as typeof globalThis.fetch;
		const adapter = makeHetznerMachineProvider({
			accessToken: Redacted.make("secret-token"),
			offerProfiles: {},
			renderUserData: () => "",
		});

		await expect(
			Effect.runPromise(adapter.recoverByLabel("zuse-machine-1")),
		).resolves.toBeNull();
		expect(callCount).toBe(1);
	});

	test("creates a firewalled server, sends bootstrap data, and enables backups", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					server_types: [
						{
							name: "standard-4-8",
							cores: 4,
							memory: 8,
							disk: 80,
							architecture: "x86",
							locations: [{ name: "eu-1", available: true }],
						},
					],
				},
			},
			{
				status: 201,
				body: {
					server: {
						id: 123,
						name: "zuse-machine-1",
						status: "initializing",
						backup_window: null,
					},
				},
			},
			{ status: 201 },
		]);
		const adapter = makeAdapter(http.client);

		const created = await Effect.runPromise(
			adapter.create({
				machineId: "machine_1",
				providerLabel: "zuse-machine-1",
				offer,
				enrollmentToken: "zenr_secret",
			}),
		);

		expect(created).toEqual({
			providerServerId: "123",
			providerLabel: "zuse-machine-1",
			powerState: "running",
		});
		expect(http.calls).toHaveLength(3);
		expect(http.calls[0]?.url).toBe(
			"https://cloud.test/v1/server_types?name=standard-4-8",
		);
		const createBody = JSON.parse(String(http.calls[1]?.init?.body));
		expect(createBody).toMatchObject({
			name: "zuse-machine-1",
			server_type: "standard-4-8",
			image: "ubuntu-current",
			location: "eu-1",
			start_after_create: true,
			automount: false,
			public_net: { enable_ipv4: true, enable_ipv6: true },
			firewalls: [{ firewall: 42 }],
			labels: { "zuse-machine-id": "machine_1" },
		});
		expect(createBody.user_data).toContain("token=zenr_secret");
		expect(http.calls[1]?.init?.headers).toMatchObject({
			authorization: "Bearer secret-token",
		});
		expect(http.calls[2]?.url).toBe(
			"https://cloud.test/v1/servers/123/actions/enable_backup",
		);
	});

	test("rejects an offer profile that does not satisfy the server-owned offer", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					server_types: [
						{
							name: "standard-4-8",
							cores: 2,
							memory: 8,
							disk: 80,
							architecture: "x86",
							locations: [{ name: "eu-1", available: true }],
						},
					],
				},
			},
		]);
		const adapter = makeAdapter(http.client);

		const result = await Effect.runPromise(
			adapter
				.create({
					machineId: "machine_1",
					providerLabel: "zuse-machine-1",
					offer,
					enrollmentToken: "zenr_secret",
				})
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "rejected" },
		});
		expect(http.calls).toHaveLength(1);
	});

	test("recovers a timed-out create by deterministic server name", async () => {
		const http = makeHttp([
			{
				status: 200,
				body: {
					servers: [
						{
							id: "456",
							name: "zuse-machine-2",
							status: "running",
							backup_window: "22-02",
						},
					],
				},
			},
		]);
		const adapter = makeAdapter(http.client);

		const recovered = await Effect.runPromise(
			adapter.recoverByLabel("zuse-machine-2"),
		);

		expect(recovered?.providerServerId).toBe("456");
		expect(http.calls[0]?.url).toBe(
			"https://cloud.test/v1/servers?name=zuse-machine-2",
		);
	});

	test("treats a missing inspected server as absent", async () => {
		const http = makeHttp([{ status: 404 }]);
		const adapter = makeAdapter(http.client);

		await expect(
			Effect.runPromise(adapter.inspect("missing")),
		).resolves.toBeNull();
	});
});
