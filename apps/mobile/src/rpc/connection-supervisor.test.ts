import { describe, expect, test } from "vitest";
import { Effect } from "effect";

import {
  createConnectionSupervisor,
  type ConnectionSnapshot,
  type MemoizeClient,
} from "./connection-supervisor";
import type { WsProtocolOptions } from "./ws-protocol";

const makeClient = (): MemoizeClient =>
  ({
    "connect.describe": () => Effect.void,
  }) as unknown as MemoizeClient;

const makeHarness = (input?: {
  online?: boolean;
  prepareOptions?: (options: WsProtocolOptions) => Promise<WsProtocolOptions>;
  createClient?: (options: WsProtocolOptions) => Promise<{
    readonly client: MemoizeClient;
    readonly dispose: () => Promise<void>;
  }>;
}) => {
  let online = input?.online ?? true;
  const scheduled: { delayMs: number; fn: () => void; cancelled: boolean }[] = [];
  const disposed: string[] = [];
  const created: WsProtocolOptions[] = [];
  const snapshots: ConnectionSnapshot[] = [];
  const supervisor = createConnectionSupervisor({
    keyOf: (options) => options.environmentId ?? `${options.host}:${options.port}`,
    isOnline: () => online,
    prepareOptions:
      input?.prepareOptions ??
      ((options) => Promise.resolve(options)),
    createClient:
      input?.createClient ??
      ((options) => {
        created.push(options);
        return Promise.resolve({
          client: makeClient(),
          dispose: async () => {
            disposed.push(options.token ?? "no-token");
          },
        });
      }),
    schedule: (delayMs, fn) => {
      const item = { delayMs, fn, cancelled: false };
      scheduled.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  });
  return {
    supervisor,
    scheduled,
    disposed,
    created,
    snapshots,
    setOnlineValue: (value: boolean) => {
      online = value;
      supervisor.setOnline(value);
    },
    watch: (options: WsProtocolOptions) => {
      const entry = supervisor.get(options);
      entry.subscribe((snapshot) => snapshots.push(snapshot));
      return entry;
    },
  };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("connection supervisor", () => {
  test("starts offline and connects on online wakeup without consuming retries", async () => {
    const harness = makeHarness({ online: false });
    const entry = harness.watch({ host: "127.0.0.1", port: 8787 });

    await expect(Effect.runPromise(entry.getClient())).rejects.toThrow("offline");
    expect(entry.snapshot().status).toBe("offline");
    expect(entry.snapshot().attempt).toBe(0);
    expect(harness.scheduled).toHaveLength(0);

    harness.setOnlineValue(true);
    await Effect.runPromise(entry.getClient());
    expect(entry.snapshot().status).toBe("connected");
    expect(entry.snapshot().generation).toBe(1);
  });

  test("retries transient failures with capped exponential backoff", async () => {
    let failures = 5;
    const harness = makeHarness({
      createClient: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("network down");
        }
        return {
          client: makeClient(),
          dispose: async () => {},
        };
      },
    });
    const entry = harness.watch({ host: "example.test", port: 443 });

    await expect(Effect.runPromise(entry.getClient())).rejects.toThrow("network down");
    for (let i = 0; i < 5; i += 1) {
      const scheduled = harness.scheduled.at(-1);
      expect(scheduled).toBeDefined();
      scheduled!.fn();
      await flushMicrotasks();
    }

    expect(harness.scheduled.map((item) => item.delayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
    ]);
    await Effect.runPromise(entry.getClient());
    expect(entry.snapshot().status).toBe("connected");
  });

  test("blocks authentication failures until explicit retry", async () => {
    let failAuth = true;
    const harness = makeHarness({
      createClient: async () => {
        if (failAuth) throw new Error("relay_connect_401");
        return { client: makeClient(), dispose: async () => {} };
      },
    });
    const entry = harness.watch({ host: "relay.test", port: 443 });

    await expect(Effect.runPromise(entry.getClient())).rejects.toThrow("relay_connect_401");
    expect(entry.snapshot().status).toBe("blockedAuth");
    expect(harness.scheduled).toHaveLength(0);

    failAuth = false;
    entry.retryNow();
    await Effect.runPromise(entry.getClient());
    expect(entry.snapshot().status).toBe("connected");
  });

  test("treats relay server errors as transient", async () => {
    let failures = 1;
    const harness = makeHarness({
      createClient: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("relay_connect_500:temporarily unavailable");
        }
        return { client: makeClient(), dispose: async () => {} };
      },
    });
    const entry = harness.watch({ host: "relay.test", port: 443 });

    await expect(Effect.runPromise(entry.getClient())).rejects.toThrow(
      "relay_connect_500",
    );
    expect(entry.snapshot().status).toBe("reconnecting");
    expect(harness.scheduled).toHaveLength(1);

    harness.scheduled[0]?.fn();
    await Effect.runPromise(entry.getClient());
    expect(entry.snapshot().status).toBe("connected");
  });

  test("refreshes prepared options before reconnecting relay environments", async () => {
    let token = 0;
    const harness = makeHarness({
      prepareOptions: async (options) => ({
        ...options,
        token: `token-${++token}`,
      }),
    });
    const entry = harness.watch({
      environmentId: "env_test",
      host: "relay.test",
      port: 443,
      wsBaseUrl: "wss://env.example/rpc",
      token: "stale",
    });

    await Effect.runPromise(entry.getClient());
    entry.reportFailure(new Error("socket closed"));
    harness.scheduled.at(-1)?.fn();
    await Effect.runPromise(entry.getClient());

    expect(harness.created.map((options) => options.token)).toEqual([
      "token-1",
      "token-2",
    ]);
  });

  test("removal disposes active runtime and unregisters the entry", async () => {
    const harness = makeHarness();
    const entry = harness.watch({ host: "127.0.0.1", port: 8787, token: "zt_a" });
    await Effect.runPromise(entry.getClient());

    await entry.remove();

    expect(harness.disposed).toEqual(["zt_a"]);
    expect(harness.supervisor.snapshots()).toEqual([]);
  });
});
