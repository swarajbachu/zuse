import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  AuthCancelledError,
  AuthFlowError,
  AuthSession,
  AuthState,
  AuthUser,
} from "@zuse/wire";

import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { AuthTokenError } from "../errors.ts";
import { AuthService } from "../services/auth-service.ts";
import { AuthShell } from "../services/auth-shell.ts";
import {
  authorizationUrl,
  exchangeCode,
  makePkce,
  parseCallbackUrl,
  refreshSession,
  type SessionBundle,
} from "./workos.ts";

/** Refresh when the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 60_000;

/** How long `signIn` waits for the browser callback before giving up. */
const SIGN_IN_TIMEOUT = "45 seconds";

const SIGNED_OUT: AuthState = { _tag: "SignedOut" };

/**
 * The build-time WorkOS client id. Public (safe to embed) — inlined by tsdown
 * `define` from `process.env.WORKOS_CLIENT_ID`. Empty when unconfigured, in
 * which case `signIn` fails with a clear message and the rest of the app keeps
 * working (auth is additive).
 */
const CLIENT_ID = (process.env.WORKOS_CLIENT_ID ?? "").trim();

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<SessionBundle, AuthFlowError>;
  readonly verifier: string;
  readonly state: string;
}

const parseBundle = (raw: string | null): SessionBundle | null => {
  if (raw === null) return null;
  try {
    const obj = JSON.parse(raw) as Partial<SessionBundle>;
    if (
      typeof obj.accessToken === "string" &&
      typeof obj.refreshToken === "string" &&
      typeof obj.expiresAt === "number" &&
      obj.user !== undefined &&
      typeof obj.user.id === "string"
    ) {
      return obj as SessionBundle;
    }
  } catch {
    // Corrupt entry — treat as signed out.
  }
  return null;
};

const toState = (b: SessionBundle): AuthState => ({
  _tag: "SignedIn",
  session: AuthSession.make({
    user: AuthUser.make({
      id: b.user.id,
      email: b.user.email,
      firstName: b.user.firstName,
      lastName: b.user.lastName,
      profilePictureUrl: b.user.profilePictureUrl,
    }),
    organizationId: b.organizationId,
    expiresAt: b.expiresAt,
  }),
});

export const AuthServiceLive = Layer.scoped(
  AuthService,
  Effect.gen(function* () {
    const credentials = yield* CredentialsService;
    const shell = yield* AuthShell;

    const pubsub = yield* PubSub.unbounded<AuthState>();
    const pending = yield* Ref.make<PendingSignIn | null>(null);
    // Serializes refreshes so two concurrent `getSession`/`getAccessToken`
    // calls can't both mint a new token and clobber the keychain entry (R5).
    const refreshLock = yield* Effect.makeSemaphore(1);

    const readBundle = (): Effect.Effect<SessionBundle | null> =>
      credentials.getWorkosSession().pipe(
        Effect.catchAll(() => Effect.succeed<string | null>(null)),
        Effect.map(parseBundle),
      );

    const persist = (
      bundle: SessionBundle,
    ): Effect.Effect<void, AuthTokenError> =>
      credentials.setWorkosSession(JSON.stringify(bundle)).pipe(
        Effect.mapError(
          (cause) =>
            new AuthTokenError({
              reason: `Failed to persist auth session: ${cause.reason}`,
              cause,
            }),
        ),
      );

    // Refresh under the lock, re-reading first so a concurrent refresh that
    // already ran is reused instead of repeated.
    const doRefresh = (
      seed: SessionBundle,
    ): Effect.Effect<SessionBundle, AuthTokenError> =>
      refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readBundle();
          const base = current ?? seed;
          if (base.expiresAt - Date.now() > REFRESH_SKEW_MS) return base;
          const fresh = yield* refreshSession(CLIENT_ID, base.refreshToken);
          yield* persist(fresh);
          yield* PubSub.publish(pubsub, toState(fresh));
          return fresh;
        }),
      );

    const getSession = (): Effect.Effect<AuthState> =>
      Effect.gen(function* () {
        const bundle = yield* readBundle();
        if (bundle === null) return SIGNED_OUT;
        if (bundle.expiresAt - Date.now() > REFRESH_SKEW_MS) {
          return toState(bundle);
        }
        // Near expiry: refresh, but tolerate transient failure by keeping the
        // existing identity rather than bouncing the user to the login screen.
        const refreshed = yield* doRefresh(bundle).pipe(Effect.either);
        return toState(refreshed._tag === "Right" ? refreshed.right : bundle);
      });

    const getAccessToken = (): Effect.Effect<string, AuthTokenError> =>
      Effect.gen(function* () {
        const bundle = yield* readBundle();
        if (bundle === null) {
          return yield* Effect.fail(
            new AuthTokenError({ reason: "Not signed in." }),
          );
        }
        if (bundle.expiresAt - Date.now() > REFRESH_SKEW_MS) {
          return bundle.accessToken;
        }
        const fresh = yield* doRefresh(bundle);
        return fresh.accessToken;
      });

    // Called (out of band) by the host shell when the deep link arrives. Always
    // resolves or rejects the in-flight sign-in; never fails itself, so the
    // host can fire-and-forget it.
    const deliverCallback = (url: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const inflight = yield* Ref.get(pending);
        // No sign-in in flight: a deep link arriving unsolicited is ignored —
        // `zuse://` is an OS-wide surface any process can invoke (R4).
        if (inflight === null) return;

        const { code, state, error } = parseCallbackUrl(url);
        if (error !== null) {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({ reason: error }),
          );
          return;
        }
        if (code === null || state !== inflight.state) {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({
              reason: "OAuth callback failed validation (state mismatch).",
            }),
          );
          return;
        }

        const result = yield* exchangeCode(
          CLIENT_ID,
          code,
          inflight.verifier,
        ).pipe(Effect.either);
        if (result._tag === "Left") {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({ reason: result.left.reason }),
          );
          return;
        }

        const bundle = result.right;
        const persisted = yield* persist(bundle).pipe(Effect.either);
        if (persisted._tag === "Left") {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({ reason: persisted.left.reason }),
          );
          return;
        }
        yield* PubSub.publish(pubsub, toState(bundle));
        yield* Deferred.succeed(inflight.deferred, bundle);
      });

    const signIn = (): Effect.Effect<
      AuthState,
      AuthFlowError | AuthCancelledError
    > =>
      Effect.gen(function* () {
        if (CLIENT_ID === "") {
          return yield* Effect.fail(
            new AuthFlowError({
              reason:
                "WorkOS is not configured (WORKOS_CLIENT_ID missing at build time).",
            }),
          );
        }
        const pkce = makePkce();
        const deferred = yield* Deferred.make<SessionBundle, AuthFlowError>();
        const previous = yield* Ref.get(pending);
        if (previous !== null) {
          yield* Deferred.fail(
            previous.deferred,
            new AuthFlowError({
              reason: "A newer sign-in attempt was started.",
            }),
          );
        }
        yield* Ref.set(pending, {
          deferred,
          verifier: pkce.verifier,
          state: pkce.state,
        });
        yield* shell.open(
          authorizationUrl(
            CLIENT_ID,
            pkce.challenge,
            pkce.state,
            shell.redirectUri,
          ),
        );
        const bundle = yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: SIGN_IN_TIMEOUT,
            onTimeout: () => new AuthCancelledError(),
          }),
          Effect.ensuring(Ref.set(pending, null)),
        );
        return toState(bundle);
      });

    const signOut = (): Effect.Effect<void> =>
      credentials.removeWorkosSession().pipe(
        Effect.catchAll(() => Effect.void),
        Effect.zipRight(PubSub.publish(pubsub, SIGNED_OUT)),
        Effect.asVoid,
      );

    const sessionChanges = (): Stream.Stream<AuthState> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const dequeue = yield* pubsub.subscribe;
          return Stream.fromQueue(dequeue);
        }),
      );

    // Register our callback sink with the host. From here on, every
    // `zuse://auth/callback` deep link the shell receives is funneled into
    // `deliverCallback` (fire-and-forget — the effect never fails).
    yield* shell.onCallbackUrl((url) => {
      Effect.runFork(deliverCallback(url));
    });

    return {
      getSession,
      signIn,
      signOut,
      sessionChanges,
      getAccessToken,
    } as const;
  }),
);
