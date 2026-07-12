import { Deferred, Effect, Layer, Ref } from "effect";

import {
  ConvexAuthError,
  ConvexAuthRequiredError,
  ConvexConnection,
} from "@zuse/contracts";

import { AuthService } from "../../auth/services/auth-service.ts";
import { AuthShell } from "../../auth/services/auth-shell.ts";
import { makePkce, parseCallbackUrl } from "../../auth/layers/workos.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { ConvexAuthService } from "../services/convex-auth-service.ts";
import { makeDeployProxyClient } from "./deploy-proxy-client.ts";

/**
 * Convex platform OAuth (team scope) — the flow from ADR 0022. Mirrors the
 * WorkOS PKCE loopback flow, with two differences: the token exchange goes
 * through the deploy-proxy (Convex requires the app's `client_secret` even
 * with PKCE), and the resulting token has no documented refresh — a 401
 * downstream degrades to "reconnect".
 */

const AUTHORIZE_URL = "https://dashboard.convex.dev/oauth/authorize/team";
const MANAGEMENT_API = "https://api.convex.dev/v1";

/** Public identifier of Zuse's registered Convex OAuth app (build-time). */
const CLIENT_ID = (process.env.CONVEX_OAUTH_CLIENT_ID ?? "").trim();

/** Keychain slot for the serialized bundle. */
const CONVEX_OAUTH_ACCOUNT = "convex:oauth";

/** How long `connect` waits for browser consent (dashboard may need login). */
const CONNECT_TIMEOUT = "3 minutes";

interface ConvexBundle {
  readonly accessToken: string;
  readonly teamId: string;
  readonly teamSlug: string | null;
  readonly connectedAt: string;
}

const parseBundle = (raw: string | null): ConvexBundle | null => {
  if (raw === null) return null;
  try {
    const obj = JSON.parse(raw) as Partial<ConvexBundle>;
    if (
      typeof obj.accessToken === "string" &&
      typeof obj.teamId === "string" &&
      typeof obj.connectedAt === "string"
    ) {
      return {
        accessToken: obj.accessToken,
        teamId: obj.teamId,
        teamSlug: typeof obj.teamSlug === "string" ? obj.teamSlug : null,
        connectedAt: obj.connectedAt,
      };
    }
  } catch {
    // Corrupt entry — treat as disconnected.
  }
  return null;
};

const toConnection = (bundle: ConvexBundle): ConvexConnection =>
  ConvexConnection.make({
    teamId: bundle.teamId,
    teamSlug: bundle.teamSlug,
    connectedAt: new Date(bundle.connectedAt),
  });

const authorizeUrl = (
  challenge: string,
  state: string,
  redirectUri: string,
): string => {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

/** `GET /token_details` — resolves which team the token is scoped to. */
const fetchTokenDetails = (
  accessToken: string,
): Effect.Effect<{ teamId: string; teamSlug: string | null }, ConvexAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${MANAGEMENT_API}/token_details`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        throw new Error(`token_details failed (${res.status})`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      const teamId = body.teamId ?? body.team_id ?? body.id;
      if (teamId === undefined || teamId === null) {
        throw new Error("token_details returned no team id");
      }
      const slug = body.teamSlug ?? body.team_slug ?? body.slug;
      return {
        teamId: String(teamId),
        teamSlug: typeof slug === "string" ? slug : null,
      };
    },
    catch: (cause) =>
      new ConvexAuthError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

interface PendingConnect {
  readonly deferred: Deferred.Deferred<ConvexBundle, ConvexAuthError>;
  readonly verifier: string;
  readonly state: string;
}

export const ConvexAuthServiceLive = Layer.effect(
  ConvexAuthService,
  Effect.gen(function* () {
    const credentials = yield* CredentialsService;
    const shell = yield* AuthShell;
    const auth = yield* AuthService;
    const proxy = makeDeployProxyClient(auth.getAccessToken);

    const pending = yield* Ref.make<PendingConnect | null>(null);

    const readBundle = (): Effect.Effect<ConvexBundle | null> =>
      credentials.getSecret(CONVEX_OAUTH_ACCOUNT).pipe(
        Effect.catch(() => Effect.succeed<string | null>(null)),
        Effect.map(parseBundle),
      );

    const persist = (bundle: ConvexBundle): Effect.Effect<void> =>
      credentials.setSecret(CONVEX_OAUTH_ACCOUNT, JSON.stringify(bundle)).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.error("[zuse] failed to persist convex connection", cause);
          }),
        ),
      );

    // Host shell calls this when the `/convex/callback` URL arrives. Never
    // fails — the shell fires and forgets.
    const deliverCallback = (url: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const inflight = yield* Ref.get(pending);
        if (inflight === null) return;

        const { code, state, error } = parseCallbackUrl(url);
        if (error !== null) {
          yield* Deferred.fail(
            inflight.deferred,
            new ConvexAuthError({ reason: error }),
          );
          return;
        }
        if (code === null || state !== inflight.state) {
          yield* Deferred.fail(
            inflight.deferred,
            new ConvexAuthError({
              reason: "OAuth callback failed validation (state mismatch).",
            }),
          );
          return;
        }

        const result = yield* proxy
          .convexTokenExchange({
            code,
            codeVerifier: inflight.verifier,
            redirectUri: shell.convexRedirectUri,
          })
          .pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* Deferred.fail(
            inflight.deferred,
            new ConvexAuthError({ reason: result.failure.reason }),
          );
          return;
        }

        const details = yield* fetchTokenDetails(result.success.accessToken).pipe(
          Effect.result,
        );
        if (details._tag === "Failure") {
          yield* Deferred.fail(inflight.deferred, details.failure);
          return;
        }

        const bundle: ConvexBundle = {
          accessToken: result.success.accessToken,
          teamId: details.success.teamId,
          teamSlug: details.success.teamSlug,
          connectedAt: new Date().toISOString(),
        };
        yield* persist(bundle);
        yield* Deferred.succeed(inflight.deferred, bundle);
      });

    const connect = (): Effect.Effect<ConvexConnection, ConvexAuthError> =>
      Effect.gen(function* () {
        if (CLIENT_ID === "") {
          return yield* Effect.fail(
            new ConvexAuthError({
              reason:
                "Convex OAuth is not configured (CONVEX_OAUTH_CLIENT_ID missing at build time).",
            }),
          );
        }
        const pkce = makePkce();
        const deferred = yield* Deferred.make<ConvexBundle, ConvexAuthError>();
        const previous = yield* Ref.get(pending);
        if (previous !== null) {
          yield* Deferred.fail(
            previous.deferred,
            new ConvexAuthError({
              reason: "A newer Convex connect attempt was started.",
            }),
          );
        }
        yield* Ref.set(pending, {
          deferred,
          verifier: pkce.verifier,
          state: pkce.state,
        });
        yield* shell.open(
          authorizeUrl(pkce.challenge, pkce.state, shell.convexRedirectUri),
        ).pipe(
          Effect.mapError(
            (err) =>
              new ConvexAuthError({
                reason:
                  err instanceof Error
                    ? err.message
                    : "Could not open browser for Convex connect.",
              }),
          ),
        );
        const bundle = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: CONNECT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ConvexAuthError({
                  reason: "Timed out waiting for Convex authorization.",
                }),
              ),
          }),
          Effect.ensuring(Ref.set(pending, null)),
        );
        return toConnection(bundle);
      });

    const status = (): Effect.Effect<ConvexConnection | null> =>
      readBundle().pipe(
        Effect.map((bundle) => (bundle === null ? null : toConnection(bundle))),
      );

    const disconnect = (): Effect.Effect<void> =>
      credentials
        .removeSecret(CONVEX_OAUTH_ACCOUNT)
        .pipe(Effect.catch(() => Effect.void));

    const getToken = (): Effect.Effect<string, ConvexAuthRequiredError> =>
      readBundle().pipe(
        Effect.flatMap((bundle) =>
          bundle === null
            ? Effect.fail(new ConvexAuthRequiredError({}))
            : Effect.succeed(bundle.accessToken),
        ),
      );

    yield* shell.onConvexCallbackUrl((url) => {
      Effect.runFork(deliverCallback(url));
    });

    return ConvexAuthService.of({ status, connect, disconnect, getToken });
  }),
);
