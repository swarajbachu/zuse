import { Effect, Layer, Redacted } from "effect";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeEach, describe, expect, test } from "vitest";
import * as Config from "../../src/config.ts";
import type { RelayContext } from "../../src/handler.ts";
import {
	AccountIdentity,
	ManagedTunnelProviderLive,
	makeRelay,
	PushDelivery,
	RelayStoreMemory,
} from "../../src/index.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const RELAY_ISSUER = "https://relay.test";

// --- test client key material -------------------------------------------------

interface KeyPair {
	readonly publicKey: CryptoKey;
	readonly privateKey: CryptoKey;
}

const eddsa = () => generateKeyPair("EdDSA", { extractable: true });
const ec = () => generateKeyPair("ES256", { extractable: true });

const nowSec = () => Math.floor(Date.now() / 1000);

const signLinkProof = async (
	envKey: KeyPair,
	input: { challenge: string; environmentId: string },
): Promise<string> =>
	new SignJWT({
		challenge: input.challenge,
		environmentId: input.environmentId,
	})
		.setProtectedHeader({ alg: "EdDSA", typ: "environment-link-proof+jwt" })
		.setAudience(RELAY_ISSUER)
		.setIssuedAt(nowSec())
		.setExpirationTime(nowSec() + 300)
		.sign(envKey.privateKey);

const dpopProof = async (
	deviceKey: KeyPair,
	jwk: JWK,
	input: { method: string; url: string; jti?: string },
): Promise<string> =>
	new SignJWT({
		htm: input.method,
		htu: input.url,
		jti: input.jti ?? crypto.randomUUID(),
	})
		.setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
		.setIssuedAt(nowSec())
		.sign(deviceKey.privateKey);

// --- harness ------------------------------------------------------------------

let relay: ReturnType<typeof makeRelay>;
let mintKey: KeyPair;
let pushCalls: ReadonlyArray<{
	readonly to: string;
	readonly environmentId: string;
	readonly kind: string;
	readonly title?: string;
	readonly target: string;
}>[];
let identityDeletes: string[];

const makeLayer = async (
	managedTunnel?: Config.ManagedTunnelConfig,
): Promise<Layer.Layer<RelayContext>> => {
	mintKey = (await eddsa()) as KeyPair;
	const configLayer = Config.layer({
		relayIssuer: RELAY_ISSUER,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mintKey.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mintKey.publicKey)),
		managedTunnel,
	});
	const pushLayer = Layer.succeed(
		PushDelivery,
		PushDelivery.of({
			send: (notifications) => {
				pushCalls = [...pushCalls, notifications];
				return Effect.void;
			},
		}),
	);
	const accountIdentityLayer = Layer.succeed(
		AccountIdentity,
		AccountIdentity.of({
			deleteUser: (accountId) =>
				Effect.sync(() => {
					identityDeletes.push(accountId);
				}),
		}),
	);
	return Layer.mergeAll(
		configLayer,
		WorkosVerifierTest,
		RelayStoreMemory,
		ManagedTunnelProviderLive.pipe(Layer.provide(configLayer)),
		pushLayer,
		accountIdentityLayer,
	);
};

const linkEnvironment = async (input: {
	account: string;
	environmentId: string;
}): Promise<{ envKey: KeyPair; credential: string }> => {
	const bearer = `test-token:${input.account}`;
	const challengeRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
			method: "POST",
			headers: { authorization: `Bearer ${bearer}` },
		}),
	);
	expect(challengeRes.status).toBe(200);
	const challenge = (await challengeRes.json()) as {
		challengeId: string;
		challenge: string;
	};

	const envKey = (await eddsa()) as KeyPair;
	const proof = await signLinkProof(envKey, {
		challenge: challenge.challenge,
		environmentId: input.environmentId,
	});
	const linkRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				challengeId: challenge.challengeId,
				proof,
				environmentId: input.environmentId,
				environmentPublicKey: JSON.stringify(await exportJWK(envKey.publicKey)),
				providerKind: "desktop",
				endpoint: {
					httpBaseUrl: "http://127.0.0.1:8787",
					wsBaseUrl: "ws://127.0.0.1:8787/rpc",
				},
				label: "Test Mac",
			}),
		}),
	);
	expect(linkRes.status).toBe(200);
	const linked = (await linkRes.json()) as { environmentCredential: string };
	return { envKey, credential: linked.environmentCredential };
};

const heartbeat = (environmentId: string, credential: string) =>
	relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/environments/${environmentId}/heartbeat`, {
			method: "POST",
			headers: { authorization: `Bearer ${credential}` },
		}),
	);

// Obtain a DPoP-bound access token for a device on `account`.
const mintAccess = async (
	account: string,
	device: KeyPair,
	jwk: JWK,
): Promise<string> => {
	const url = `${RELAY_ISSUER}/v1/client/dpop-token`;
	const res = await relay.fetch(
		new Request(url, {
			method: "POST",
			headers: {
				authorization: `Bearer test-token:${account}`,
				dpop: await dpopProof(device, jwk, { method: "POST", url }),
			},
		}),
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { accessToken: string }).accessToken;
};

beforeEach(async () => {
	pushCalls = [];
	identityDeletes = [];
	relay = makeRelay(await makeLayer());
});

describe("@zuse/relay", () => {
	test("links an environment, reports presence, and mints a connect token", async () => {
		const { environmentId } = { environmentId: "env_1" };
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId,
		});

		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);

		// Before any heartbeat: offline.
		const statusUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/status`;
		const offline = await relay.fetch(
			new Request(statusUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: statusUrl,
					}),
				},
			}),
		);
		expect((await offline.json()).status).toBe("offline");

		// Heartbeat → online.
		expect((await heartbeat(environmentId, credential)).status).toBe(200);
		const online = await relay.fetch(
			new Request(statusUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: statusUrl,
					}),
				},
			}),
		);
		expect((await online.json()).status).toBe("online");

		// Connect → signed token.
		const connectUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/connect`;
		const connect = await relay.fetch(
			new Request(connectUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: connectUrl,
					}),
				},
			}),
		);
		const connectBody = (await connect.json()) as { connectToken: string };
		expect(connectBody.connectToken.split(".")).toHaveLength(3); // a JWT, not base64 stub
	});

	test("rejects a request with no WorkOS bearer", async () => {
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, { method: "GET" }),
		);
		expect(res.status).toBe(401);
	});

	test("deletes account-owned relay data and remains idempotent", async () => {
		const { credential } = await linkEnvironment({
			account: "user_delete",
			environmentId: "env_delete",
		});
		const request = () =>
			relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/account`, {
					method: "DELETE",
					headers: { authorization: "Bearer test-token:user_delete" },
				}),
			);

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
		expect(identityDeletes).toEqual(["user_delete", "user_delete"]);

		const list = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				headers: { authorization: "Bearer test-token:user_delete" },
			}),
		);
		expect((await list.json()).environments).toHaveLength(0);
		expect((await heartbeat("env_delete", credential)).status).toBe(401);
	});

	test("scopes environments by account — cross-account access is denied", async () => {
		await linkEnvironment({ account: "user_a", environmentId: "env_a" });

		// user_b lists: sees nothing.
		const listB = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				method: "GET",
				headers: { authorization: "Bearer test-token:user_b" },
			}),
		);
		expect((await listB.json()).environments).toHaveLength(0);

		// user_b cannot connect to user_a's environment (404, not leaked).
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_b", device, jwk);
		const connectUrl = `${RELAY_ISSUER}/v1/environments/env_a/connect`;
		const res = await relay.fetch(
			new Request(connectUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: connectUrl,
					}),
				},
			}),
		);
		expect(res.status).toBe(404);
	});

	test("rejects a forged link proof (wrong key)", async () => {
		const bearer = "Bearer test-token:user_a";
		const challengeRes = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
				method: "POST",
				headers: { authorization: bearer },
			}),
		);
		const challenge = (await challengeRes.json()) as {
			challengeId: string;
			challenge: string;
		};

		const realKey = (await eddsa()) as KeyPair;
		const attackerKey = (await eddsa()) as KeyPair;
		// Proof signed by the attacker, but claims the victim's public key.
		const proof = await signLinkProof(attackerKey, {
			challenge: challenge.challenge,
			environmentId: "env_x",
		});
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
				method: "POST",
				headers: { authorization: bearer, "content-type": "application/json" },
				body: JSON.stringify({
					challengeId: challenge.challengeId,
					proof,
					environmentId: "env_x",
					environmentPublicKey: JSON.stringify(
						await exportJWK(realKey.publicKey),
					),
					providerKind: "desktop",
					endpoint: {
						httpBaseUrl: "http://127.0.0.1:8787",
						wsBaseUrl: "ws://127.0.0.1:8787/rpc",
					},
				}),
			}),
		);
		expect(res.status).toBe(401);
	});

	test("rejects a replayed DPoP proof", async () => {
		await linkEnvironment({ account: "user_a", environmentId: "env_1" });
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);

		const statusUrl = `${RELAY_ISSUER}/v1/environments/env_1/status`;
		const proof = await dpopProof(device, jwk, {
			method: "POST",
			url: statusUrl,
		});
		const headers = { authorization: `DPoP ${accessToken}`, dpop: proof };

		const first = await relay.fetch(
			new Request(statusUrl, { method: "POST", headers }),
		);
		expect(first.status).toBe(200);
		const replay = await relay.fetch(
			new Request(statusUrl, { method: "POST", headers }),
		);
		expect(replay.status).toBe(401);
		expect((await replay.json()).error).toBe("dpop_replayed");
	});

	test("rejects chat bytes on the activity endpoint", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sessionId: "s1",
					kind: "completed",
					messages: ["chat"],
				}),
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("chat_data_not_allowed");
	});

	test("fans sanitized activity out to registered push devices", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);
		const devicesUrl = `${RELAY_ISSUER}/v1/mobile/devices`;
		const register = await relay.fetch(
			new Request(devicesUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: devicesUrl,
					}),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					deviceId: "phone_1",
					platform: "ios",
					pushToken: "ExponentPushToken[test]",
				}),
			}),
		);
		expect(register.status).toBe(200);

		const activity = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sessionId: "s1",
					kind: "approval-needed",
					title: "Test Mac",
				}),
			}),
		);

		expect(activity.status).toBe(200);
		expect(await activity.json()).toEqual({ delivered: 1 });
		expect(pushCalls).toHaveLength(1);
		expect(pushCalls[0]).toEqual([
			{
				to: "ExponentPushToken[test]",
				environmentId: "env_1",
				kind: "approval-needed",
				title: "Test Mac",
				target: "zuse://computers?environmentId=env_1",
			},
		]);
	});

	test("rejects message-shaped activity payload fields", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const sensitivePayloads = [
			{ message: "hello" },
			{ content: "hello" },
			{ text: "hello" },
			{ toolArgs: { command: "pwd" } },
			{ toolInput: { path: "/tmp/x" } },
			{ output: "stdout" },
			{ filePath: "/tmp/x" },
			{ nested: { path: "/tmp/x" } },
		];

		for (const payload of sensitivePayloads) {
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						sessionId: "s1",
						kind: "completed",
						...payload,
					}),
				}),
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("chat_data_not_allowed");
		}
	});
});

// --- managed Cloudflare tunnel ------------------------------------------------

const FAKE_TUNNEL: Config.ManagedTunnelConfig = {
	cfApiToken: Redacted.make("cf-token"),
	cfAccountId: "acct_1",
	cfZoneId: "zone_1",
	baseDomain: "test",
	namespace: "zenv",
};

/**
 * Stub the Cloudflare v4 API. Returns the CF envelope shape the provider
 * expects and records every call so deprovision can be asserted.
 */
const stubCloudflare = () => {
	const calls: Array<{ method: string; path: string }> = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (
		input: Request | string | URL,
		init?: RequestInit,
	) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const path = new URL(url).pathname + new URL(url).search;
		calls.push({ method, path });
		const ok = (result: unknown) =>
			new Response(JSON.stringify({ success: true, result }), { status: 200 });
		if (path.includes("/cfd_tunnel/") && path.includes("/token")) {
			return ok("connector-token-xyz");
		}
		if (path.includes("/cfd_tunnel/") && path.includes("/configurations")) {
			return ok({});
		}
		if (path.includes("/cfd_tunnel") && method === "GET") return ok([]); // no existing
		if (path.includes("/cfd_tunnel") && method === "POST") {
			return ok({ id: "tunnel_abc", name: "zenv-xyz" });
		}
		if (path.includes("/cfd_tunnel/") && method === "DELETE") return ok({});
		if (path.includes("/dns_records") && method === "GET") return ok([]);
		if (path.includes("/dns_records") && method === "POST") {
			return ok({ id: "dns_1", name: "host" });
		}
		if (path.includes("/dns_records/") && method === "DELETE") return ok({});
		return ok({});
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
};

const linkWithTunnel = async (account: string, environmentId: string) => {
	const bearer = `test-token:${account}`;
	const challengeRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
			method: "POST",
			headers: { authorization: `Bearer ${bearer}` },
		}),
	);
	const challenge = (await challengeRes.json()) as {
		challengeId: string;
		challenge: string;
	};
	const envKey = (await eddsa()) as KeyPair;
	const proof = await signLinkProof(envKey, {
		challenge: challenge.challenge,
		environmentId,
	});
	const linkRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				challengeId: challenge.challengeId,
				proof,
				environmentId,
				environmentPublicKey: JSON.stringify(await exportJWK(envKey.publicKey)),
				providerKind: "desktop",
				endpoint: {
					httpBaseUrl: "http://127.0.0.1:8787",
					wsBaseUrl: "ws://127.0.0.1:8787/rpc",
				},
				managedTunnel: true,
				origin: { localHttpHost: "127.0.0.1", localHttpPort: 8787 },
			}),
		}),
	);
	return linkRes;
};

describe("@zuse/relay managed tunnel", () => {
	test("provisions a tunnel on link and returns a connector token", async () => {
		const cf = stubCloudflare();
		try {
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
			const res = await linkWithTunnel("user_a", "env_t");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				tunnelHostname?: string;
				connectorToken?: string;
				endpoint: { wsBaseUrl: string };
			};
			expect(body.connectorToken).toBe("connector-token-xyz");
			expect(body.tunnelHostname).toBe(
				`zenv-${body.tunnelHostname?.split("-")[1]}`,
			);
			expect(body.endpoint.wsBaseUrl).toBe(`wss://${body.tunnelHostname}`);

			// The discovery list now advertises the managed endpoint.
			const list = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments`, {
					method: "GET",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const listed = (await list.json()).environments[0];
			expect(listed.endpoint.wsBaseUrl).toBe(`wss://${body.tunnelHostname}`);
		} finally {
			cf.restore();
		}
	});

	test("unlink deprovisions the tunnel and removes the environment", async () => {
		const cf = stubCloudflare();
		try {
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
			await linkWithTunnel("user_a", "env_t");
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/client/environment-unlink`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ environmentId: "env_t" }),
				}),
			);
			expect(res.status).toBe(200);
			// Tunnel + DNS deletes were issued.
			expect(
				cf.calls.some(
					(c) => c.method === "DELETE" && c.path.includes("/cfd_tunnel/"),
				),
			).toBe(true);
			expect(
				cf.calls.some(
					(c) => c.method === "DELETE" && c.path.includes("/dns_records/"),
				),
			).toBe(true);
			// Environment is gone.
			const list = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments`, {
					method: "GET",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			expect((await list.json()).environments).toHaveLength(0);
		} finally {
			cf.restore();
		}
	});

	test("link succeeds without a tunnel when provisioning is disabled", async () => {
		relay = makeRelay(await makeLayer()); // no managedTunnel config
		const res = await linkWithTunnel("user_a", "env_t");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			connectorToken?: string;
			endpoint: { wsBaseUrl: string };
		};
		expect(body.connectorToken).toBeUndefined();
		expect(body.endpoint.wsBaseUrl).toBe("ws://127.0.0.1:8787/rpc"); // LAN fallback
	});
});
