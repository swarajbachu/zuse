import { describe, expect, test } from "bun:test";

import { createMemoryStore, createRelayHandler } from "../src/index.ts";

const app = () =>
  createRelayHandler(createMemoryStore(), {
    issuer: "https://relay.test",
    now: () => 1_000,
  });

const json = async (response: Response) => await response.json() as any;

describe("@zuse/relay", () => {
  test("links an environment and issues a scoped connect token", async () => {
    const handler = app();
    const challengeResponse = await handler(
      new Request("https://relay.test/v1/client/environment-link-challenges", {
        method: "POST",
      }),
    );
    const challenge = await json(challengeResponse);

    const linkResponse = await handler(
      new Request("https://relay.test/v1/client/environment-links", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: "zlp_valid",
          environmentId: "env_1",
          providerKind: "desktop",
          endpoint: {
            httpBaseUrl: "http://127.0.0.1:8787",
            wsBaseUrl: "ws://127.0.0.1:8787",
          },
        }),
      }),
    );
    expect(linkResponse.status).toBe(200);

    const connectResponse = await handler(
      new Request("https://relay.test/v1/environments/env_1/connect", {
        method: "POST",
      }),
    );
    const connect = await json(connectResponse);
    expect(connect.connectToken).toStartWith("zct_");
    expect(connect.endpoint.wsBaseUrl).toBe("ws://127.0.0.1:8787");
  });

  test("rejects chat bytes on activity endpoint", async () => {
    const handler = app();
    const response = await handler(
      new Request("https://relay.test/v1/environments/env_1/agent-activity", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "s1",
          kind: "completed",
          messages: ["chat"],
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "chat_data_not_allowed" });
  });
});
