import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { ProviderId } from "@zuse/wire";

import { AuthServiceLive } from "../src/auth/layers/auth-service.ts";
import type { SessionBundle } from "../src/auth/layers/workos.ts";
import { AuthService } from "../src/auth/services/auth-service.ts";
import { AuthShell } from "../src/auth/services/auth-shell.ts";
import { CredentialsService } from "../src/provider/services/credentials-service.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jwtWithExp = (expMs: number): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expMs / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
};

const makeBundle = (overrides: Partial<SessionBundle> = {}): SessionBundle => ({
  accessToken: jwtWithExp(Date.now() + 15 * 60_000),
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 15 * 60_000,
  organizationId: null,
  user: {
    id: "user_123",
    email: "user@example.com",
    firstName: "User",
    lastName: "One",
    profilePictureUrl: null,
  },
  ...overrides,
});

const decodeStored = (raw: string | null): SessionBundle | null =>
  raw === null ? null : (JSON.parse(raw) as SessionBundle);

interface Harness {
  readonly run: <A>(
    effect: Effect.Effect<A, unknown, AuthService>,
  ) => Promise<A>;
  readonly readStored: () => SessionBundle | null;
  readonly dispose: () => Promise<void>;
}

const makeHarness = (initial: SessionBundle): Harness => {
  let stored: string | null = JSON.stringify(initial);
  const CredentialsLayer = Layer.succeed(
    CredentialsService,
    CredentialsService.of({
      get: (_providerId: ProviderId) => Effect.succeed(null),
      set: (_providerId: ProviderId, _apiKey: string) => Effect.void,
      remove: (_providerId: ProviderId) => Effect.void,
      listConfigured: () => Effect.succeed([]),
      setBrowser: (_origin: string, _username: string, _password: string) =>
        Effect.void,
      getBrowser: (_origin: string) => Effect.succeed(null),
      removeBrowser: (_origin: string) => Effect.void,
      listBrowser: () => Effect.succeed([]),
      getWorkosSession: () => Effect.succeed(stored),
      setWorkosSession: (bundleJson: string) =>
        Effect.sync(() => {
          stored = bundleJson;
        }),
      removeWorkosSession: () =>
        Effect.sync(() => {
          stored = null;
        }),
    }),
  );
  const AuthShellLayer = Layer.succeed(
    AuthShell,
    AuthShell.of({
      redirectUri: "zuse://auth/callback",
      open: (_url: string) => Effect.void,
      onCallbackUrl: (_handler: (url: string) => void) => Effect.void,
    }),
  );
  const runtime = ManagedRuntime.make(
    AuthServiceLive.pipe(
      Layer.provide(CredentialsLayer),
      Layer.provide(AuthShellLayer),
    ),
  );
  return {
    run: <A>(effect: Effect.Effect<A, unknown, AuthService>) =>
      runtime.runPromise(effect as Effect.Effect<A, unknown, never>),
    readStored: () => decodeStored(stored),
    dispose: () => runtime.dispose(),
  };
};

const mockAuthenticate = (
  handler: (body: Record<string, string>) => Response | Promise<Response>,
): Array<Record<string, string>> => {
  const calls: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      string
    >;
    calls.push(body);
    return await handler(body);
  }) as typeof fetch;
  return calls;
};

describe("AuthService WorkOS refresh", () => {
  it("refreshes an expired access token and persists the rotated refresh token", async () => {
    const old = makeBundle({
      accessToken: jwtWithExp(Date.now() - 5 * 60_000),
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 5 * 60_000,
    });
    const nextAccessToken = jwtWithExp(Date.now() + 20 * 60_000);
    const calls = mockAuthenticate((body) => {
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old-refresh");
      return Response.json({
        access_token: nextAccessToken,
        refresh_token: "rotated-refresh",
        organization_id: "org_123",
        user: {
          id: "user_123",
          email: "user@example.com",
          first_name: "User",
          last_name: "One",
        },
      });
    });
    const harness = makeHarness(old);
    try {
      const token = await harness.run(
        Effect.flatMap(AuthService, (svc) => svc.getAccessToken()),
      );
      expect(token).toBe(nextAccessToken);
      expect(calls).toHaveLength(1);
      expect(harness.readStored()).toMatchObject({
        accessToken: nextAccessToken,
        refreshToken: "rotated-refresh",
        organizationId: "org_123",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("serializes concurrent refreshes so the stale refresh token is used once", async () => {
    const old = makeBundle({
      accessToken: jwtWithExp(Date.now() - 5 * 60_000),
      refreshToken: "single-use-refresh",
      expiresAt: Date.now() - 5 * 60_000,
    });
    const nextAccessToken = jwtWithExp(Date.now() + 20 * 60_000);
    const calls = mockAuthenticate(async (body) => {
      expect(body.refresh_token).toBe("single-use-refresh");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        access_token: nextAccessToken,
        refresh_token: "rotated-once",
        user: { id: "user_123", email: "user@example.com" },
      });
    });
    const harness = makeHarness(old);
    try {
      const [first, second] = await Promise.all([
        harness.run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken())),
        harness.run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken())),
      ]);
      expect(first).toBe(nextAccessToken);
      expect(second).toBe(nextAccessToken);
      expect(calls).toHaveLength(1);
      expect(harness.readStored()?.refreshToken).toBe("rotated-once");
    } finally {
      await harness.dispose();
    }
  });

  it("keeps getSession signed in when refresh has a transient failure", async () => {
    const old = makeBundle({
      accessToken: jwtWithExp(Date.now() - 5 * 60_000),
      refreshToken: "temporarily-failing-refresh",
      expiresAt: Date.now() - 5 * 60_000,
    });
    const calls = mockAuthenticate(
      () => new Response("temporary outage", { status: 503 }),
    );
    const harness = makeHarness(old);
    try {
      const state = await harness.run(
        Effect.flatMap(AuthService, (svc) => svc.getSession()),
      );
      expect(state._tag).toBe("SignedIn");
      expect(calls).toHaveLength(1);
      expect(harness.readStored()?.refreshToken).toBe(
        "temporarily-failing-refresh",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects refresh responses that do not include a new refresh token", async () => {
    const old = makeBundle({
      accessToken: jwtWithExp(Date.now() - 5 * 60_000),
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 5 * 60_000,
    });
    mockAuthenticate(() =>
      Response.json({
        access_token: jwtWithExp(Date.now() + 20 * 60_000),
        user: { id: "user_123", email: "user@example.com" },
      }),
    );
    const harness = makeHarness(old);
    try {
      const result = await harness
        .run(Effect.flatMap(AuthService, (svc) => svc.getAccessToken()))
        .then(
          () => ({ ok: true as const }),
          (err) => ({ ok: false as const, err }),
        );
      expect(result.ok).toBe(false);
      expect(harness.readStored()?.refreshToken).toBe("old-refresh");
    } finally {
      await harness.dispose();
    }
  });
});
