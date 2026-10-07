import type { ReviewConnection, ReviewConnectionCreate } from "@zuse/contracts";
import {
	resolveSandboxResources,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Effect, Option, Schema } from "effect";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import { ApiConfiguration } from "./config.ts";
import { ApiError, forbidden, serviceUnavailable } from "./errors.ts";
import {
	ReviewLifecycleStore,
	type ReviewNativeActivity,
	type ReviewNativeConnection,
} from "./review-lifecycle-store.ts";
import {
	estimateReviewCost,
	reserveReviewCost,
	reviewComputeValueMicros,
} from "./review-pricing.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { ReviewStore } from "./review-store.ts";

const STATUS = "/run/zuse-review-login/status.json";
const CALLBACK = "/run/zuse-review-login/callback.json";
const io = <A>(f: () => Promise<A>) =>
	Effect.tryPromise({
		try: f,
		catch: () => serviceUnavailable("review_connection_storage_failed"),
	});
const publicConnection = (c: ReviewNativeConnection): ReviewConnection => ({
	id: c.id,
	label: c.label,
	...(c.reason ? { reason: c.reason } : {}),
	agentProvider: c.agentProvider,
	state:
		c.state === "login-required"
			? "new"
			: c.state === "lost"
				? "reconnect"
				: c.state,
	...(c.verificationUrl ? { verificationUrl: c.verificationUrl } : {}),
	...(c.expiresAtMs ? { expiresAtMs: c.expiresAtMs } : {}),
});
const owned = Effect.fn("ownedReviewConnection")(function* (
	actorId: string,
	id: string,
) {
	const s = yield* ReviewLifecycleStore;
	const c = yield* io(() => s.getConnection(id));
	if (!c || c.ownerActorId !== actorId)
		return yield* forbidden("review_connection_access_required");
	return c;
});
const getReviewSetupResourcesInternal = Effect.fn("getReviewSetupResources")(
	function* (ownerId: string, actorId: string) {
		const config = yield* ApiConfiguration;
		const store = yield* ReviewLifecycleStore;
		const connections = yield* io(() =>
			store.listConnections(ownerId, actorId),
		);
		const readiness = getReviewReadiness("claude", config.review);
		const period = yield* ensureAccountCloudBillingPeriod(
			ownerId,
			Date.now(),
		).pipe(Effect.option);
		const markup =
			Option.isSome(period) && period.value
				? period.value.markupBasisPoints
				: null;
		const placementProvider = yield* (yield* SandboxProviders)
			.get("e2b")
			.pipe(Effect.option);
		const placements = [];
		for (const size of Option.isSome(placementProvider)
			? placementProvider.value.sizes
			: []) {
			const estimate = yield* estimateReviewCost(
				"e2b",
				size.sizeId,
				600000,
				Date.now(),
			).pipe(Effect.option);
			const reasons = [
				...readiness.reasons,
				...(markup === null ? ["review_billing_period_unavailable"] : []),
				...(estimate._tag === "None"
					? ["review_compute_price_unavailable"]
					: []),
			];
			placements.push({
				provider: "e2b",
				size: size.sizeId,
				label: size.displayName,
				available: reasons.length === 0,
				reasons,
				estimatedMaxCostMicros:
					estimate._tag === "Some" && markup !== null
						? reviewComputeValueMicros(estimate.value.maximumCostMicros, markup)
						: 0,
			});
		}
		return {
			connections: connections.map((c) => ({
				id: c.id,
				label: c.label,
				agentProvider: c.agentProvider,
				models: c.models,
				available: readiness.available && c.state === "ready",
				reasons: [
					...readiness.reasons,
					...(c.state !== "ready"
						? ["review_connection_authentication_required"]
						: []),
				],
			})),
			placements,
		};
	},
);
const createReviewConnectionInternal = Effect.fn("createReviewConnection")(
	function* (ownerId: string, actorId: string, input: ReviewConnectionCreate) {
		if (!input.acknowledgedCharges)
			return yield* forbidden("review_charge_acknowledgment_required");
		const config = yield* ApiConfiguration;
		const p = yield* (yield* SandboxProviders).get("e2b");
		if (!p.sizes.some((s) => s.sizeId === input.size))
			return yield* forbidden("review_size_unavailable");
		const c: ReviewNativeConnection = {
			id: `review-${crypto.randomUUID()}`,
			ownerId,
			ownerActorId: actorId,
			label: input.label,
			agentProvider: input.agentProvider,
			sandboxProvider: "e2b",
			size: input.size,
			models: config.review?.models ?? [],
			providerSandboxId: null,
			state: "login-required",
			createdAtMs: Date.now(),
			updatedAtMs: Date.now(),
		};
		const store = yield* ReviewLifecycleStore;
		yield* io(() => store.saveConnection(c));
		return publicConnection(c);
	},
);
const stopLoginActivity = Effect.fn("stopReviewLoginActivity")(function* (
	c: ReviewNativeConnection,
	a: ReviewNativeActivity,
	preserve: boolean,
) {
	const store = yield* ReviewLifecycleStore;
	const p = yield* (yield* SandboxProviders).get(c.sandboxProvider);
	const recovered =
		!c.providerSandboxId && !a.providerSandboxId
			? yield* p.recoverByLabel(`zuse-review-${c.id}`)
			: null;
	const sandboxId =
		c.providerSandboxId ??
		a.providerSandboxId ??
		recovered?.providerSandboxId ??
		null;
	if (sandboxId) {
		const exists = yield* p.inspect(sandboxId);
		if (exists) {
			if (preserve) {
				yield* p.pause(sandboxId);
				const after = yield* p.inspect(sandboxId);
				if (after?.state !== "paused")
					return yield* serviceUnavailable("review_login_pause_unconfirmed");
			} else {
				yield* p.kill(sandboxId);
				if (yield* p.inspect(sandboxId))
					return yield* serviceUnavailable("review_login_stop_unconfirmed");
			}
		}
	}
	const stoppedAtMs = Date.now();
	yield* observeCloudRuntimeUsage({
		accountId: a.ownerId,
		resourceKind: "review",
		resourceId: a.id,
		provider: a.provider,
		providerSandboxId: sandboxId ?? undefined,
		observedAtMs: stoppedAtMs,
		...resolveSandboxResources(p, c.size),
	});
	yield* io(() =>
		store.saveActivity({
			...a,
			providerSandboxId: sandboxId,
			stoppedAtMs,
			state: "stopped",
		}),
	);
	yield* io(() => store.releaseConnection(c.id, c.id));
});
const LoginStatus = Schema.Struct({
	state: Schema.Literals(["authenticating", "ready", "failed"]),
	verificationUrl: Schema.optional(Schema.String),
	expiresAtMs: Schema.optional(Schema.Number),
	providerIdentity: Schema.optional(Schema.String),
});
export const refreshReviewConnection = Effect.fn("refreshReviewConnection")(
	function* (c: ReviewNativeConnection) {
		if (c.state !== "authenticating") return c;
		const store = yield* ReviewLifecycleStore;
		const loginActivityId = c.loginActivityId;
		const a = loginActivityId
			? yield* io(() => store.getActivity(loginActivityId))
			: null;
		if (!a) return yield* serviceUnavailable("review_login_activity_missing");
		const p = yield* (yield* SandboxProviders).get(c.sandboxProvider);
		if (Date.now() >= a.deadlineMs) {
			yield* stopLoginActivity(c, a, false);
			const next = {
				...c,
				state: "lost" as const,
				providerSandboxId: null,
				verificationUrl: undefined,
				expiresAtMs: undefined,
				updatedAtMs: Date.now(),
			};
			yield* io(() => store.saveConnection(next));
			return next;
		}
		if (!c.providerSandboxId) return c;
		if (!(yield* p.pathExists(c.providerSandboxId, STATUS))) return c;
		const text = yield* p.readTextFile(c.providerSandboxId, STATUS);
		if (text.length > 16000)
			return yield* serviceUnavailable("review_login_status_invalid");
		const status = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(LoginStatus),
		)(text).pipe(
			Effect.mapError(() => serviceUnavailable("review_login_status_invalid")),
		);
		if (status.state === "ready") {
			if (
				!status.providerIdentity ||
				!/^claude:[a-f0-9]{64}$/.test(status.providerIdentity)
			)
				return yield* serviceUnavailable("review_native_identity_unverified");
			if (
				c.providerIdentity &&
				c.providerIdentity !== status.providerIdentity
			) {
				yield* stopLoginActivity(c, a, false);
				const next = {
					...c,
					state: "lost" as const,
					reason: "review_native_identity_mismatch",
					providerSandboxId: null,
					verificationUrl: undefined,
					expiresAtMs: undefined,
					updatedAtMs: Date.now(),
				};
				yield* io(() => store.saveConnection(next));
				return next;
			}
			yield* stopLoginActivity(c, a, true);
			const next = {
				...c,
				state: "ready" as const,
				providerIdentity: status.providerIdentity,
				reason: undefined,
				verificationUrl: undefined,
				expiresAtMs: undefined,
				updatedAtMs: Date.now(),
			};
			yield* io(() => store.saveConnection(next));
			return next;
		}
		if (status.state === "failed") {
			yield* stopLoginActivity(c, a, false);
			const next = {
				...c,
				state: "lost" as const,
				providerSandboxId: null,
				verificationUrl: undefined,
				expiresAtMs: undefined,
				updatedAtMs: Date.now(),
			};
			yield* io(() => store.saveConnection(next));
			return next;
		}
		const verificationUrl = status.verificationUrl;
		if (verificationUrl) {
			const u = yield* Effect.try({
				try: () => new URL(verificationUrl),
				catch: () => serviceUnavailable("review_login_url_invalid"),
			});
			if (
				u.protocol !== "https:" ||
				!["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(
					u.hostname,
				)
			)
				return yield* serviceUnavailable("review_login_url_invalid");
		}
		const next = {
			...c,
			verificationUrl: status.verificationUrl,
			expiresAtMs: a.deadlineMs,
			updatedAtMs: Date.now(),
		};
		yield* io(() => store.saveConnection(next));
		return next;
	},
);
const getReviewConnectionInternal = Effect.fn("getReviewConnection")(function* (
	_ownerId: string,
	actorId: string,
	id: string,
) {
	return publicConnection(
		yield* refreshReviewConnection(yield* owned(actorId, id)),
	);
});
const loginReviewConnectionInternal = Effect.fn("loginReviewConnection")(
	function* (ownerId: string, actorId: string, id: string) {
		let c = yield* owned(actorId, id);
		if (c.ownerId !== ownerId)
			return yield* forbidden("review_connection_payer_mismatch");
		const config = yield* ApiConfiguration;
		const profile = config.review;
		if (!profile)
			return yield* serviceUnavailable("review_configuration_required");
		const ready = getReviewReadiness(c.agentProvider, profile);
		if (!ready.available)
			return yield* serviceUnavailable(ready.reasons.join(","));
		const store = yield* ReviewLifecycleStore;
		if (!(yield* io(() => store.claimLogin(id, actorId, Date.now()))))
			return publicConnection(yield* refreshReviewConnection(c));
		const now = Date.now();
		const activityId = crypto.randomUUID();
		const durationMs = 600000;
		const cost = yield* reserveReviewCost({
			ownerId,
			id: activityId,
			provider: c.sandboxProvider,
			size: c.size,
			durationMs,
			nowMs: now,
		}).pipe(
			Effect.onError(() =>
				io(async () => {
					await store.saveConnection({ ...c, state: "lost" });
					await store.releaseConnection(id, id);
					await store.releaseCostReservation(activityId);
				}).pipe(Effect.orDie),
			),
		);
		const a: ReviewNativeActivity = {
			id: activityId,
			connectionId: id,
			ownerId,
			provider: c.sandboxProvider,
			providerSandboxId: null,
			startedAtMs: now,
			stoppedAtMs: null,
			deadlineMs: now + durationMs - 30000,
			maximumCostMicros: cost,
			state: "admitted",
		};
		yield* io(() => store.saveActivity(a));
		c = {
			...c,
			state: "authenticating",
			loginActivityId: activityId,
			expiresAtMs: a.deadlineMs,
			updatedAtMs: now,
		};
		yield* io(() => store.saveConnection(c));
		const p = yield* (yield* SandboxProviders).get(c.sandboxProvider);
		const authorized = yield* io(() => store.getConnection(id));
		if (authorized?.state !== "authenticating")
			return yield* forbidden("review_connection_revoked");
		const timeoutSeconds = Math.floor((a.deadlineMs - Date.now()) / 1000);
		if (timeoutSeconds < 1)
			return yield* serviceUnavailable("review_login_deadline_expired");
		const sandbox = yield* p.fork({
			sandboxId: id,
			providerLabel: `zuse-review-${id}`,
			metadata: { "zuse-sandbox-id": id, "zuse-resource-kind": "review" },
			sizeId: c.size,
			snapshotId: profile.templateId,
			timeoutSeconds,
			env: {},
			network: {
				kind: "restricted",
				allowOut: [
					"api.anthropic.com",
					"claude.ai",
					"console.anthropic.com",
					"platform.claude.com",
				],
				denyOut: [],
			},
			onTimeout: "terminate",
		});
		c = { ...c, providerSandboxId: sandbox.providerSandboxId };
		yield* io(() => store.saveConnection(c));
		yield* io(() =>
			store.saveActivity({
				...a,
				providerSandboxId: sandbox.providerSandboxId,
				state: "running",
			}),
		);
		yield* observeCloudRuntimeUsage({
			accountId: ownerId,
			resourceKind: "review",
			resourceId: activityId,
			provider: c.sandboxProvider,
			providerSandboxId: sandbox.providerSandboxId,
			runningSinceMs: now,
			observedAtMs: Date.now(),
			...resolveSandboxResources(p, c.size),
		});
		yield* p.startProcess(sandbox.providerSandboxId, {
			command: "/usr/local/bin/node",
			args: [
				profile.workerModule,
				"login",
				"--status-file",
				STATUS,
				"--callback-file",
				CALLBACK,
			],
			env: { ZUSE_REVIEW_CLAUDE_EXECUTABLE: profile.claudeExecutable },
			tag: "zuse-review-login",
			user: "root",
		});
		return publicConnection(c);
	},
);
const completeReviewConnectionInternal = Effect.fn("completeReviewConnection")(
	function* (
		_ownerId: string,
		actorId: string,
		id: string,
		callbackUrl: string,
	) {
		const c = yield* owned(actorId, id);
		if (
			c.state !== "authenticating" ||
			!c.providerSandboxId ||
			!c.verificationUrl ||
			Date.now() >= (c.expiresAtMs ?? 0)
		)
			return yield* forbidden("review_login_expired");
		const authorizationUrl = c.verificationUrl;
		const urls = yield* Effect.try({
			try: () => ({
				callback: new URL(callbackUrl),
				authorization: new URL(authorizationUrl),
			}),
			catch: () => forbidden("review_login_callback_invalid"),
		});
		const redirect = urls.authorization.searchParams.get("redirect_uri");
		const expected = redirect ? new URL(redirect) : null;
		if (
			!expected ||
			urls.callback.origin !== expected.origin ||
			urls.callback.pathname !== expected.pathname ||
			urls.callback.searchParams.get("state") !==
				urls.authorization.searchParams.get("state") ||
			!urls.callback.searchParams.get("code")
		)
			return yield* forbidden("review_login_callback_invalid");
		const p = yield* (yield* SandboxProviders).get(c.sandboxProvider);
		// File creation and rename occur within the same trusted process with restrictive mode from birth.
		yield* p.startProcess(c.providerSandboxId, {
			command: "/usr/local/bin/node",
			args: [
				"-e",
				"const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p+'.tmp',process.argv[2],{mode:0o600,flag:'wx'});fs.renameSync(p+'.tmp',p)",
				CALLBACK,
				JSON.stringify({ callbackUrl }),
			],
			user: "root",
			tag: "zuse-review-callback",
		});
		return publicConnection(c);
	},
);
const revokeReviewConnectionInternal = Effect.fn("revokeReviewConnection")(
	function* (_ownerId: string, actorId: string, id: string) {
		const c = yield* owned(actorId, id);
		const store = yield* ReviewLifecycleStore;
		yield* io(() => store.revokeConnection(id, Date.now()));
		if (c.providerSandboxId) {
			const p = yield* (yield* SandboxProviders).get(c.sandboxProvider);
			yield* p.kill(c.providerSandboxId);
		}
		return publicConnection({
			...c,
			state: "revoked",
			verificationUrl: undefined,
			expiresAtMs: undefined,
		});
	},
);
export const reconcileReviewConnections = Effect.fn(
	"reconcileReviewConnections",
)(function* () {
	const store = yield* ReviewLifecycleStore;
	const activities = yield* io(() => store.listOpenActivities());
	for (const a of activities.filter((a) => a.kind !== "check")) {
		const c = yield* io(() => store.getConnection(a.connectionId));
		if (!c) continue;
		if (c.state === "revoked") {
			yield* stopLoginActivity(c, a, false).pipe(Effect.result);
		} else yield* refreshReviewConnection(c).pipe(Effect.result);
	}
	const review = yield* Effect.serviceOption(ReviewStore);
	if (Option.isSome(review))
		for (const a of activities.filter((a) => a.kind === "check")) {
			yield* Effect.gen(function* () {
				const core = review.value;
				const run = a.runId
					? yield* io(() => core.getRun(a.runId ?? ""))
					: null;
				const allowed = run
					? yield* io(() => core.canReadRunArtifacts(run.id))
					: false;
				if (
					allowed &&
					run &&
					["provisioning", "reviewing"].includes(run.state) &&
					Date.now() < a.deadlineMs
				)
					return;
				const provider = yield* (yield* SandboxProviders).get(a.provider);
				const recovered = a.providerSandboxId
					? null
					: yield* provider.recoverByLabel(`zuse-review-${a.id}`);
				const sandboxId =
					a.providerSandboxId ?? recovered?.providerSandboxId ?? null;
				if (sandboxId) {
					yield* provider.kill(sandboxId);
					if (yield* provider.inspect(sandboxId))
						return yield* serviceUnavailable("review_check_stop_unconfirmed");
				}
				const stoppedAtMs = Date.now();
				yield* observeCloudRuntimeUsage({
					accountId: a.ownerId,
					resourceKind: "review",
					resourceId: a.id,
					provider: a.provider,
					providerSandboxId: sandboxId ?? undefined,
					observedAtMs: stoppedAtMs,
					...resolveSandboxResources(provider, a.size),
				});
				yield* io(() =>
					store.saveActivity({
						...a,
						providerSandboxId: sandboxId,
						stoppedAtMs,
						state: "stopped",
					}),
				);
			}).pipe(Effect.result);
		}
	return activities.length;
});

export const getReviewSetupResources = (
	...args: Parameters<typeof getReviewSetupResourcesInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* getReviewSetupResourcesInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});

export const createReviewConnection = (
	...args: Parameters<typeof createReviewConnectionInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* createReviewConnectionInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});

export const getReviewConnection = (
	...args: Parameters<typeof getReviewConnectionInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* getReviewConnectionInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});

export const loginReviewConnection = (
	...args: Parameters<typeof loginReviewConnectionInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* loginReviewConnectionInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});

export const completeReviewConnection = (
	...args: Parameters<typeof completeReviewConnectionInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* completeReviewConnectionInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});

export const revokeReviewConnection = (
	...args: Parameters<typeof revokeReviewConnectionInternal>
) =>
	Effect.gen(function* () {
		const optional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(optional))
			return yield* serviceUnavailable("review_native_unavailable");
		return yield* revokeReviewConnectionInternal(...args).pipe(
			Effect.provideService(ReviewLifecycleStore, optional.value),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("review_native_provider_unavailable"),
			),
		);
	});
