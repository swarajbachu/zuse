import { beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { Layer, Redacted } from "effect";

import { makeRelay, RelayStoreMemory } from "../src/index.ts";
import * as Config from "../src/config.ts";
import type { RelayContext } from "../src/handler.ts";
import { WorkosVerifierTest } from "../src/workos.ts";

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
  new SignJWT({ challenge: input.challenge, environmentId: input.environmentId })
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
  new SignJWT({ htm: input.method, htu: input.url, jti: input.jti ?? crypto.randomUUID() })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt(nowSec())
    .sign(deviceKey.privateKey);

// --- harness ------------------------------------------------------------------

let relay: ReturnType<typeof makeRelay>;
let mintKey: KeyPair;

const makeLayer = async (): Promise<Layer.Layer<RelayContext>> => {
  mintKey = (await eddsa()) as KeyPair;
  const configLayer = Config.layer({
    relayIssuer: RELAY_ISSUER,
    workosJwksUrl: "https://unused.test/jwks",
    workosIssuer: "https://unused.test",
    mintPrivateKey: Redacted.make(JSON.stringify(await exportJWK(mintKey.privateKey))),
    mintPublicKey: JSON.stringify(await exportJWK(mintKey.publicKey)),
  });
  return Layer.mergeAll(configLayer, WorkosVerifierTest, RelayStoreMemory);
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
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
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
  relay = makeRelay(await makeLayer());
});

describe("@zuse/relay", () => {
  test("links an environment, reports presence, and mints a connect token", async () => {
    const { environmentId } = { environmentId: "env_1" };
    const { credential } = await linkEnvironment({ account: "user_a", environmentId });

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
          dpop: await dpopProof(device, jwk, { method: "POST", url: statusUrl }),
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
          dpop: await dpopProof(device, jwk, { method: "POST", url: statusUrl }),
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
          dpop: await dpopProof(device, jwk, { method: "POST", url: connectUrl }),
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
          dpop: await dpopProof(device, jwk, { method: "POST", url: connectUrl }),
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
          environmentPublicKey: JSON.stringify(await exportJWK(realKey.publicKey)),
          providerKind: "desktop",
          endpoint: { httpBaseUrl: "http://127.0.0.1:8787", wsBaseUrl: "ws://127.0.0.1:8787/rpc" },
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
    const proof = await dpopProof(device, jwk, { method: "POST", url: statusUrl });
    const headers = { authorization: `DPoP ${accessToken}`, dpop: proof };

    const first = await relay.fetch(new Request(statusUrl, { method: "POST", headers }));
    expect(first.status).toBe(200);
    const replay = await relay.fetch(new Request(statusUrl, { method: "POST", headers }));
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toBe("dpop_replayed");
  });

  test("rejects chat bytes on the activity endpoint", async () => {
    const { credential } = await linkEnvironment({ account: "user_a", environmentId: "env_1" });
    const res = await relay.fetch(
      new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", kind: "completed", messages: ["chat"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("chat_data_not_allowed");
  });
});
