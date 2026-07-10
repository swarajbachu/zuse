import {
  AuthCancelledError,
  AuthFlowError,
  AuthSession,
  type AuthState,
  AuthUser,
} from "@zuse/contracts";
import {
  Deferred,
  Effect,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";

import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { AuthTokenError, type SessionStoreError } from "../errors.ts";
import { AuthService } from "../services/auth-service.ts";
import { AuthShell } from "../services/auth-shell.ts";
import { SessionStore } from "../services/session-store.ts";
import {
  authorizationUrl,
  exchangeCode,
  makePkce,
  parseCallbackUrl,
  parseSessionBundle,
  refreshSession,
  type SessionBundle,
} from "./workos.ts";

/** Refresh when the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 60_000;
const FORCE_REFRESH_SKIP_MS = 10 * 60_000;

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

const parseKeychainBundle = (raw: string | null): SessionBundle | null => {
  if (raw === null) return null;
  try {
    return parseSessionBundle(JSON.parse(raw) as unknown);
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

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const credentials = yield* CredentialsService;
    const store = yield* SessionStore;
    const shell = yield* AuthShell;

    const pubsub = yield* PubSub.unbounded<AuthState>();
    const pending = yield* Ref.make<PendingSignIn | null>(null);
    const lastKnown = yield* Ref.make<SessionBundle | null>(null);
    // Serializes refreshes so two concurrent `getSession`/`getAccessToken`
    // calls can't both mint a new token and clobber the keychain entry (R5).
    const refreshLock = yield* Semaphore.make(1);

    const readBundle = (): Effect.Effect<SessionBundle | null> =>
      store.read().pipe(
        Effect.tap((bundle) => Ref.set(lastKnown, bundle)),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            console.warn("[zuse] failed to read auth session", cause.reason);
            return yield* Ref.get(lastKnown);
          }),
        ),
      );

    const persist = (
      bundle: SessionBundle,
    ): Effect.Effect<void, AuthTokenError> =>
      store.write(bundle).pipe(
        Effect.tap((written) => Ref.set(lastKnown, written)),
        Effect.tap((written) => PubSub.publish(pubsub, toState(written))),
        Effect.asVoid,
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
    const mapStoreError = (cause: SessionStoreError): AuthTokenError =>
      new AuthTokenError({
        reason: `Failed to access auth session: ${cause.reason}`,
        cause,
      });

    const doRefresh = (
      seed: SessionBundle,
      options: { readonly force?: boolean } = {},
    ): Effect.Effect<SessionBundle, AuthTokenError> =>
      refreshLock
        .withPermits(1)(
          store.withLock(
            Effect.gen(function* () {
              const current = yield* store.read();
              if (current === null) {
                return yield* Effect.fail(
                  new AuthTokenError({
                    reason: "Signed out during refresh.",
                  }),
                );
              }
              const base = current;
              const now = Date.now();
              if (current.refreshToken !== seed.refreshToken) {
                yield* Ref.set(lastKnown, current);
                return current;
              }
              if (!options.force && base.expiresAt - now > REFRESH_SKEW_MS) {
                yield* Ref.set(lastKnown, base);
                return base;
              }
              if (
                options.force &&
                base.refreshedAt > 0 &&
                now - base.refreshedAt < FORCE_REFRESH_SKIP_MS &&
                base.expiresAt - now > REFRESH_SKEW_MS
              ) {
                yield* Ref.set(lastKnown, base);
                return base;
              }
              const attemptedRefreshToken = base.refreshToken;
              const refreshed = yield* refreshSession(
                CLIENT_ID,
                attemptedRefreshToken,
              ).pipe(Effect.result);
              if (refreshed._tag === "Failure") {
                if (refreshed.failure.code === "invalid_grant") {
                  const winner = yield* store.read();
                  if (
                    winner !== null &&
                    winner.refreshToken !== attemptedRefreshToken
                  ) {
                    yield* Ref.set(lastKnown, winner);
                    return winner;
                  }
                }
                return yield* Effect.fail(refreshed.failure);
              }
              const written = yield* store.write(refreshed.success);
              yield* Ref.set(lastKnown, written);
              yield* PubSub.publish(pubsub, toState(written));
              return written;
            }),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "SessionStoreError" ? mapStoreError(cause) : cause,
          ),
        );

    const refreshIfPresent = (force: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const bundle = yield* readBundle();
        if (bundle === null) return;
        yield* doRefresh(bundle, { force }).pipe(Effect.result);
      });

    const getSession = (): Effect.Effect<AuthState> =>
      Effect.gen(function* () {
        const bundle = yield* readBundle();
        if (bundle === null) return SIGNED_OUT;
        if (bundle.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
          yield* doRefresh(bundle).pipe(
            Effect.ignore,
            Effect.forkDetach({ startImmediately: true }),
          );
        }
        return toState(bundle);
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
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({ reason: result.failure.reason }),
          );
          return;
        }

        const bundle = result.success;
        const persisted = yield* persist(bundle).pipe(Effect.result);
        if (persisted._tag === "Failure") {
          yield* Deferred.fail(
            inflight.deferred,
            new AuthFlowError({ reason: persisted.failure.reason }),
          );
          return;
        }
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
          Effect.timeoutOrElse({
            duration: SIGN_IN_TIMEOUT,
            orElse: () => Effect.fail(new AuthCancelledError()),
          }),
          Effect.ensuring(Ref.set(pending, null)),
        );
        return toState(bundle);
      });

    const signOut = (): Effect.Effect<void> =>
      store.clear().pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Ref.set(lastKnown, null)),
        Effect.andThen(PubSub.publish(pubsub, SIGNED_OUT)),
        Effect.asVoid,
      );

    const sessionChanges = (): Stream.Stream<AuthState> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const dequeue = yield* PubSub.subscribe(pubsub);
          return Stream.concat(
            Stream.fromEffect(getSession()),
            Stream.fromSubscription(dequeue),
          );
        }),
      );

    yield* Effect.gen(function* () {
      const fileBundle = yield* store
        .read()
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (fileBundle !== null) {
        yield* Ref.set(lastKnown, fileBundle);
        return;
      }
      const legacy = yield* credentials.getWorkosSession().pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.map(parseKeychainBundle),
      );
      if (legacy === null) return;
      const migrated = yield* store.write(legacy).pipe(Effect.result);
      if (migrated._tag === "Success") {
        yield* Ref.set(lastKnown, migrated.success);
        yield* credentials
          .removeWorkosSession()
          .pipe(Effect.catch(() => Effect.void));
      }
    });

    yield* Effect.forkScoped(
      refreshIfPresent(true).pipe(
        Effect.andThen(
          Effect.repeat(
            refreshIfPresent(true),
            Schedule.spaced("45 minutes").pipe(Schedule.jittered),
          ),
        ),
        Effect.catch(() => Effect.void),
      ),
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
