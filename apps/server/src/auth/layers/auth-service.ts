import {
	AuthCancelledError,
	AuthFlowError,
	AuthSession,
	type AuthState,
	AuthUser,
	WORKOS_PUBLIC_CLIENT_ID,
} from "@zuse/contracts";
import {
	Deferred,
	Effect,
	Layer,
	Option,
	PubSub,
	Ref,
	Schedule,
	Semaphore,
	Stream,
} from "effect";

import { ConnectionIdentity } from "../../lan-auth/services/connection-identity.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { AuthTokenError, type SessionStoreError } from "../errors.ts";
import { AuthService } from "../services/auth-service.ts";
import { AuthShell } from "../services/auth-shell.ts";
import { SessionStore } from "../services/session-store.ts";
import { refreshStoredSession } from "./stored-session-refresh.ts";
import {
	authorizationUrl,
	exchangeCode,
	makePkce,
	parseCallbackUrl,
	parseSessionBundle,
	type SessionBundle,
} from "./workos.ts";

/** Refresh when the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 60_000;
/**
 * Re-check often enough to refresh production's five-minute access tokens
 * inside the skew window. The check only rotates when expiry is near; polling
 * itself never consumes a refresh token.
 */
const REFRESH_POLL_INTERVAL = "30 seconds";

/** How long `signIn` waits for the browser callback before giving up. */
const SIGN_IN_TIMEOUT = "45 seconds";

const SIGNED_OUT: AuthState = { _tag: "SignedOut" };

/**
 * The build-time WorkOS client id. Public (safe to embed) — inlined by tsdown
 * `define` from `process.env.WORKOS_CLIENT_ID`, with the shared public AuthKit
 * identifier as the source-mode and Serve fallback.
 */
const CLIENT_ID =
	(process.env.WORKOS_CLIENT_ID ?? "").trim() || WORKOS_PUBLIC_CLIENT_ID;

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
			refreshLock
				.withPermits(1)(store.withLock(store.write(bundle)))
				.pipe(
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
		): Effect.Effect<SessionBundle, AuthTokenError> =>
			refreshLock
				.withPermits(1)(
					refreshStoredSession(store, {
						clientId: CLIENT_ID,
						seed,
						refreshSkewMs: REFRESH_SKEW_MS,
					}).pipe(
						Effect.tap((bundle) => Ref.set(lastKnown, bundle)),
						Effect.tap((bundle) =>
							bundle.refreshToken === seed.refreshToken
								? Effect.void
								: PubSub.publish(pubsub, toState(bundle)),
						),
						Effect.tapError((cause) =>
							cause._tag === "AuthTokenError" && cause.code === "invalid_grant"
								? Ref.set(lastKnown, null).pipe(
										Effect.andThen(PubSub.publish(pubsub, SIGNED_OUT)),
									)
								: Effect.void,
						),
					),
				)
				.pipe(
					Effect.mapError((cause) =>
						cause._tag === "SessionStoreError" ? mapStoreError(cause) : cause,
					),
				);

		const refreshIfPresent = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const bundle = yield* readBundle();
				if (bundle === null) return;
				yield* doRefresh(bundle).pipe(Effect.result);
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
				// Read request context here, not when constructing the shared service.
				// Workspace access never delegates the host owner's account credentials.
				const identity = yield* Effect.serviceOption(ConnectionIdentity);
				if (Option.isSome(identity) && identity.value.kind === "workspace")
					return yield* new AuthTokenError({
						reason: "Workspace connections cannot use the host account.",
					});
				const authorize = (candidate: SessionBundle) =>
					Option.isSome(identity) &&
					identity.value.kind === "account" &&
					(identity.value.subject !== candidate.user.id ||
						identity.value.expiresAt <= Date.now())
						? Effect.fail(
								new AuthTokenError({
									reason: "This connection cannot use the host account.",
								}),
							)
						: Effect.void;
				const bundle = yield* readBundle();
				if (bundle === null) {
					return yield* Effect.fail(
						new AuthTokenError({ reason: "Not signed in." }),
					);
				}
				yield* authorize(bundle);
				if (bundle.expiresAt - Date.now() > REFRESH_SKEW_MS) {
					return bundle.accessToken;
				}
				const fresh = yield* doRefresh(bundle);
				// Refresh re-reads under the cross-process lock and may observe a
				// different signed-in account, or outlive the connection credential.
				yield* authorize(fresh);
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
			refreshLock
				.withPermits(1)(store.withLock(store.clear()))
				.pipe(
					Effect.catch(() => Effect.void),
					Effect.andThen(
						Effect.gen(function* () {
							const owners = yield* credentials.listIntegrationAccounts(
								"environment-personal-cache",
							);
							for (const owner of owners)
								yield* credentials.removeIntegration(
									"environment-personal-cache",
									owner,
								);
						}).pipe(Effect.catch(() => Effect.void)),
					),
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
			const migrated = yield* store
				.withLock(store.write(legacy))
				.pipe(Effect.result);
			if (migrated._tag === "Success") {
				yield* Ref.set(lastKnown, migrated.success);
				yield* credentials
					.removeWorkosSession()
					.pipe(Effect.catch(() => Effect.void));
			}
		});

		// An expired token refreshes on launch; a still-valid token is only read.
		yield* Effect.forkScoped(
			refreshIfPresent().pipe(
				Effect.andThen(
					Effect.repeat(
						refreshIfPresent(),
						Schedule.spaced(REFRESH_POLL_INTERVAL),
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
