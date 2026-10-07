import type { ReviewResult } from "@zuse/contracts";
import {
	resolveSandboxResources,
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Context, Effect, Layer } from "effect";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { type ApiConfig, ApiConfiguration } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { MachineStore } from "./machine-store.ts";
import { ReviewCheckExecution } from "./review-check-execution.ts";
import type { ReviewRunRecord } from "./review-domain.ts";
import {
	ReviewLifecycleStore,
	type ReviewLifecycleStoreApi,
	type ReviewManagedAttempt,
} from "./review-lifecycle-store.ts";
import { reserveReviewCost } from "./review-pricing.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { ReviewStore, type ReviewStoreApi } from "./review-store.ts";

const WORKER_TAG = "zuse-review-worker";
export interface ReviewLifecycleDependencies {
	verify?(
		attempt: ReviewManagedAttempt,
		result: ReviewResult,
	): Promise<ReviewResult>;
	core: ReviewStoreApi;
	store: ReviewLifecycleStoreApi;
	configuration: ApiConfig;
	provider(id: string): Promise<SandboxProviderAdapter>;
	reserve(
		run: ReviewRunRecord,
		attemptId: string,
		durationMs: number,
		nowMs: number,
	): Promise<number>;
	observe(
		attempt: ReviewManagedAttempt,
		nowMs: number,
		running: boolean,
	): Promise<void>;
	token(attemptId: string, leaseToken: string): Promise<string>;
	hash(token: string): Promise<string>;
}
const call = <A>(value: Effect.Effect<A, unknown>) => Effect.runPromise(value);
const requestSeconds = (deadline: number, now: number) => {
	const remaining = Math.floor((deadline - now) / 1000);
	if (remaining < 1) throw Error("review_budget_expired");
	return remaining;
};
export interface ReviewLifecycleApi {
	park(attemptId: string, nowMs: number): Promise<void>;
	reconcile(nowMs: number): Promise<{ dispatched: number; reconciled: number }>;
	dispatch(id: string, nowMs: number): Promise<boolean>;
	supervise(attempt: ReviewManagedAttempt, nowMs: number): Promise<void>;
}
export class ReviewLifecycle extends Context.Service<
	ReviewLifecycle,
	ReviewLifecycleApi
>()("api/ReviewLifecycle") {}
/** Stateful provider actions use persisted intent and stable connection labels before I/O. */
export const makeReviewLifecycle = (
	d: ReviewLifecycleDependencies,
): ReviewLifecycleApi => {
	const stopNative = async (
		a: ReviewManagedAttempt,
		nowMs: number,
		preserveAuth: boolean,
	) => {
		const c = await d.store.getConnection(a.run.modelConnectionId);
		const p = await d.provider(a.provider);
		const sandboxId = a.providerSandboxId ?? c?.providerSandboxId;
		if (a.lifecycle.stage !== "checking" || !preserveAuth) {
			await d.store.updateAttempt(a.id, a.leaseToken, { stage: "stopping" });
			if (sandboxId) {
				const observed = await call(p.inspect(sandboxId));
				if (preserveAuth && !observed)
					throw Error("review_auth_sandbox_missing");
				if (observed) {
					if (preserveAuth) {
						if (observed.state !== "paused") await call(p.pause(sandboxId));
						const paused = await call(p.inspect(sandboxId));
						if (paused?.state !== "paused")
							throw Error("review_pause_unconfirmed");
					} else {
						await call(p.kill(sandboxId));
						if (await call(p.inspect(sandboxId)))
							throw Error("review_stop_unconfirmed");
					}
				}
			}
			nowMs = Math.max(nowMs, Date.now());
			await d.observe(a, nowMs, false);
			await d.store.updateAttempt(a.id, a.leaseToken, {
				stage:
					preserveAuth && a.lifecycle.pendingResult ? "checking" : "stopping",
			});
			await d.core.stopAttempt(a.id, a.leaseToken, nowMs);
		}

		return { connection: c, sandboxId, stoppedAtMs: a.stoppedAtMs ?? nowMs };
	};
	const finish = async (
		a: ReviewManagedAttempt,
		nowMs: number,
		preserveAuth: boolean,
	) => {
		const {
			connection: c,
			sandboxId,
			stoppedAtMs,
		} = await stopNative(a, nowMs, preserveAuth);
		nowMs = stoppedAtMs;
		nowMs = a.stoppedAtMs ?? nowMs;
		let published = false;
		if (
			preserveAuth &&
			a.lifecycle.pendingResult &&
			(await d.core.renewRun(
				a.runId,
				a.leaseToken,
				Math.max(Date.now(), nowMs),
			))
		) {
			let result = a.lifecycle.pendingResult;
			if (d.verify) {
				const pulse = setInterval(() => {
					void d.core
						.renewRun(a.runId, a.leaseToken, Date.now())
						.catch(() => false);
				}, 5000);
				try {
					result = await d.verify({ ...a, stoppedAtMs: nowMs }, result);
				} finally {
					clearInterval(pulse);
				}
			}
			published = await d.core.acceptResult(
				a.runId,
				a.leaseToken,
				result,
				Date.now(),
			);
		}

		const reconnect = a.lifecycle.errorCode === "review_reconnect_required";
		if (reconnect && sandboxId) {
			const adapter = await d.provider(a.provider);
			await call(adapter.kill(sandboxId));
			if (await call(adapter.inspect(sandboxId)))
				throw Error("review_reconnect_stop_unconfirmed");
		}
		if (c && (!preserveAuth || reconnect))
			await d.store.saveConnection({
				...c,
				state: "lost",
				providerSandboxId: null,
				updatedAtMs: nowMs,
			});
		await d.store.updateAttempt(a.id, a.leaseToken, { stage: "stopped" });
		await d.store.releaseConnection(a.run.modelConnectionId, a.leaseToken);
		// Keep financial reservations until settlement; unknown provider costs are never erased.
		if (!a.providerSandboxId && !sandboxId)
			await d.store.releaseCostReservation(a.id);
		if (!published)
			await d.store.finishRun(
				a.runId,
				a.lifecycle.errorCode ?? "review_worker_stopped",
				nowMs,
			);
	};
	const supervise = async (a: ReviewManagedAttempt, nowMs: number) => {
		const owner = await d.store.claimSupervisor(a.id, nowMs);
		if (!owner) return;
		try {
			const current = await d.store.getAttempt(a.id);
			if (
				!current ||
				(current.stoppedAtMs !== null && current.lifecycle.stage !== "checking")
			)
				return;
			a = current;
			if (!d.configuration.review?.enabled)
				await d.core.cancelRun(a.ownerId, a.runId, nowMs);
			const c = await d.store.getConnection(a.run.modelConnectionId);
			if (!a.lifecycle.connectionId) {
				await finish(a, nowMs, false);
				return;
			}
			const revoked =
				!d.configuration.review?.enabled ||
				c?.state !== "ready" ||
				!(await d.core.canReadRunArtifacts(a.runId));
			const uncertainStart =
				a.lifecycle.stage === "starting" && !a.lifecycle.workerStarted;
			const cancelled = [
				"cancelled",
				"superseded",
				"failed",
				"blocked",
			].includes(a.run.state);
			const expired = nowMs >= a.lifecycle.deadlineMs;
			const stale =
				a.lifecycle.workerStarted && nowMs - a.lifecycle.heartbeatAtMs > 60000;
			if (
				revoked ||
				uncertainStart ||
				cancelled ||
				expired ||
				stale ||
				a.lifecycle.resultReceived ||
				a.lifecycle.errorCode
			) {
				const safe =
					!revoked &&
					!uncertainStart &&
					a.lifecycle.cleanupConfirmed &&
					!!c &&
					c.state !== "revoked";
				await finish(a, nowMs, safe);
				return;
			}
			const p = await d.provider(a.provider);
			let sandboxId = a.providerSandboxId ?? c?.providerSandboxId;
			if (!sandboxId) {
				const recovered = await call(
					p.recoverByLabel(`zuse-review-${a.run.modelConnectionId}`),
				);
				sandboxId = recovered?.providerSandboxId ?? null;
			}
			if (!sandboxId) {
				await d.store.updateAttempt(a.id, a.leaseToken, {
					errorCode: "review_auth_sandbox_missing",
				});
				await finish(a, nowMs, false);
				return;
			}
			if (!a.providerSandboxId) {
				if (!(await d.core.renewRun(a.runId, a.leaseToken, nowMs)))
					throw Error("review_lease_lost");
				if (!(await d.core.attachSandbox(a.id, a.leaseToken, sandboxId, nowMs)))
					throw Error("review_attach_fenced");
			}
			const observed = await call(p.inspect(sandboxId));
			if (!observed) {
				await d.store.updateAttempt(a.id, a.leaseToken, {
					errorCode: "review_auth_sandbox_missing",
				});
				await finish({ ...a, providerSandboxId: sandboxId }, nowMs, false);
				return;
			}
			if (a.lifecycle.workerStarted) {
				if (observed.state !== "running") {
					await finish({ ...a, providerSandboxId: sandboxId }, nowMs, false);
					return;
				}
				await d.core.renewRun(a.runId, a.leaseToken, nowMs);
				await d.observe({ ...a, providerSandboxId: sandboxId }, nowMs, true);
				return;
			}
			if (!(await d.core.renewRun(a.runId, a.leaseToken, Date.now())))
				throw Error("review_lease_lost");
			// Prior run was confirmed clean before pause; deadline bounds resumed processes on provider side.
			if (observed.state === "paused")
				await call(
					p.resume(
						sandboxId,
						requestSeconds(a.lifecycle.deadlineMs, Date.now()),
						"terminate",
						a.run.worker.size,
					),
				);
			else
				await call(
					p.extendTimeout(
						sandboxId,
						requestSeconds(a.lifecycle.deadlineMs, Date.now()),
					),
				);
			const module = d.configuration.review?.workerModule;
			if (!module || !(await call(p.pathExists(sandboxId, module))))
				throw Error("review_worker_artifact_missing");
			await call(
				p.setNetwork(sandboxId, {
					kind: "restricted",
					allowOut: [
						"api.anthropic.com",
						"claude.ai",
						"console.anthropic.com",
						"platform.claude.com",
						"github.com",
						"api.github.com",
						new URL(
							d.configuration.publicApiOrigin ?? d.configuration.apiIssuer,
						).hostname,
					],
					denyOut: [],
				}),
			);
			if (!(await d.core.renewRun(a.runId, a.leaseToken, Date.now())))
				throw Error("review_lease_lost");
			const token = await d.token(a.id, a.leaseToken);
			await d.store.updateAttempt(a.id, a.leaseToken, {
				stage: "starting",
				heartbeatAtMs: nowMs,
			});
			await call(
				p.replaceProcess(
					sandboxId,
					{ tag: WORKER_TAG },
					{
						command: "/usr/local/bin/node",
						args: [
							module,
							"run",
							"--attempt-id",
							a.id,
							"--api-origin",
							d.configuration.publicApiOrigin ?? d.configuration.apiIssuer,
						],
						env: {
							ZUSE_REVIEW_BOOT_TOKEN: token,
							ZUSE_REVIEW_CLAUDE_EXECUTABLE:
								d.configuration.review?.claudeExecutable ?? "",
						},
						tag: WORKER_TAG,
						user: "root",
					},
				),
			);
			await d.store.updateAttempt(a.id, a.leaseToken, {
				stage: "running",
				workerStarted: true,
				heartbeatAtMs: nowMs,
			});
			await d.observe({ ...a, providerSandboxId: sandboxId }, nowMs, true);
		} catch {
			// Uncertain starts must not be retried blindly: terminate the dedicated sandbox.
			const current = await d.store.getAttempt(a.id);
			if (
				current?.lifecycle.stage === "checking" &&
				current.stoppedAtMs !== null
			)
				return;
			if (
				current &&
				(current.stoppedAtMs === null || current.lifecycle.stage === "checking")
			) {
				await d.store.updateAttempt(a.id, a.leaseToken, {
					errorCode: "review_lifecycle_failure",
					stage: "unknown",
				});
				await finish(
					{
						...current,
						lifecycle: {
							...current.lifecycle,
							errorCode: "review_lifecycle_failure",
						},
					},
					nowMs,
					false,
				).catch(() => undefined);
			}
		} finally {
			await d.store.releaseSupervisor(a.id, owner);
		}
	};
	const dispatch = async (id: string, nowMs: number) => {
		const run = await d.core.getRun(id);
		if (run?.state !== "queued") return false;
		const readiness = getReviewReadiness(
			run.agentProvider,
			d.configuration.review,
		);
		const claim = await d.core.claimRun(id, nowMs);
		if (!claim) return false;
		const block = async (reason: string) => {
			await d.core.blockRun(id, claim.leaseToken, reason, nowMs);
			return false;
		};
		if (!readiness.available) return block(readiness.reasons.join(","));
		if (
			run.fork &&
			!(await d.core.checkForkApproved(
				run.repositoryId,
				run.pullNumber,
				run.headSha,
			))
		)
			return block("fork_approval_required");
		const c = await d.store.getConnection(run.modelConnectionId);
		const enrollment = (await d.core.listEnrollments(run.ownerId)).find(
			(e) => e.id === run.enrollmentId,
		);
		if (
			!c ||
			!enrollment ||
			c.ownerActorId !== enrollment.enabledBy ||
			c.agentProvider !== run.agentProvider ||
			!c.models.includes(run.model) ||
			c.state !== "ready"
		)
			return block("review_connection_unavailable");
		if (
			run.worker.provider !== "e2b" ||
			c.sandboxProvider !== run.worker.provider ||
			c.size !== run.worker.size ||
			!c.providerSandboxId
		)
			return block("review_placement_unavailable");
		const p = await d.provider(run.worker.provider);
		if (!p.sizes.some((size) => size.sizeId === run.worker.size))
			return block("review_size_unavailable");
		if (
			!(await d.store.claimConnection(
				c.id,
				c.ownerActorId,
				claim.leaseToken,
				nowMs,
			))
		)
			return block("review_connection_busy");
		const attemptId = crypto.randomUUID();
		const lifetime = Math.min(
			Math.floor(run.worker.maxRuntimeMs * 0.7),
			420000,
		);
		if (lifetime < 80000) {
			await d.store.releaseConnection(c.id, claim.leaseToken);
			return block("review_runtime_budget_too_small");
		}
		let recorded = false;
		try {
			if (
				!(await d.core.recordAttempt({
					id: attemptId,
					runId: id,
					leaseToken: claim.leaseToken,
					provider: run.worker.provider,
					maximumLifetimeMs: lifetime,
					nowMs,
				}))
			)
				return false;
			recorded = true;
			const token = await d.token(attemptId, claim.leaseToken);
			const cost = await d.reserve(run, attemptId, lifetime, nowMs);
			if (
				run.worker.maxCostMicros !== undefined &&
				cost > run.worker.maxCostMicros
			)
				throw Error("review_run_budget_exceeded");
			if (
				!(await d.store.initializeAttempt(attemptId, claim.leaseToken, {
					connectionId: c.id,
					providerIdentity: c.providerIdentity,
					stage: "admitted",
					deadlineMs: nowMs + lifetime - 30000,
					maximumCostMicros: cost,
					heartbeatAtMs: nowMs,
					workerStarted: false,
					cleanupConfirmed: false,
					resultReceived: false,
					bootHash: await d.hash(token),
				}))
			)
				throw Error("review_attempt_fenced");
			const attempt = await d.store.getAttempt(attemptId);
			if (!attempt) throw Error("review_attempt_missing");
			await supervise(attempt, nowMs);
			return true;
		} catch (error) {
			if (recorded) {
				await d.core.stopAttempt(attemptId, claim.leaseToken, nowMs);
				await d.store.releaseCostReservation(attemptId);
				await d.store.finishRun(
					id,
					error instanceof Error ? error.message : "review_admission_failed",
					nowMs,
				);
			}
			return false;
		} finally {
			if (
				!recorded ||
				(await d.store.getAttempt(attemptId))?.stoppedAtMs !== null
			)
				await d.store.releaseConnection(c.id, claim.leaseToken);
		}
	};
	return {
		park: async (id, nowMs) => {
			const token = await d.store.claimSupervisor(id, nowMs);
			if (!token) return;
			try {
				const a = await d.store.getAttempt(id);
				if (!a?.lifecycle.resultReceived || a.stoppedAtMs !== null) return;
				const current = await d.core.canReadRunArtifacts(a.runId);
				if (
					a.lifecycle.cleanupConfirmed &&
					a.lifecycle.pendingResult &&
					current
				)
					await stopNative(a, nowMs, true);
				else await finish(a, nowMs, false);
			} finally {
				await d.store.releaseSupervisor(id, token);
			}
		},
		dispatch,
		supervise,
		reconcile: async (nowMs) => {
			const active = await d.store.listActiveAttempts(50);
			for (const a of active) await supervise(a, nowMs);
			const due = await d.core.dueRunIds(nowMs, 20);
			let dispatched = 0;
			for (const id of due) if (await dispatch(id, nowMs)) dispatched++;
			return { dispatched, reconciled: active.length };
		},
	};
};
export const ReviewLifecycleLive = Layer.effect(
	ReviewLifecycle,
	Effect.gen(function* () {
		const checks = yield* ReviewCheckExecution;
		const core = yield* ReviewStore;
		const store = yield* ReviewLifecycleStore;
		const providers = yield* SandboxProviders;
		const configuration = yield* ApiConfiguration;
		const billing = yield* CloudBillingStore;
		const machines = yield* MachineStore;
		const workspaces = yield* CloudWorkspaceStore;
		const price = (
			run: ReviewRunRecord,
			id: string,
			durationMs: number,
			nowMs: number,
		) =>
			call(
				reserveReviewCost({
					ownerId: run.ownerId,
					id,
					provider: run.worker.provider,
					size: run.worker.size,
					durationMs,
					nowMs,
					maxCostMicros: run.worker.maxCostMicros,
				}).pipe(
					Effect.provideService(SandboxProviders, providers),
					Effect.provideService(CloudBillingStore, billing),
					Effect.provideService(MachineStore, machines),
				),
			);
		return makeReviewLifecycle({
			verify: (attempt, result) => checks.run(attempt, result),
			core,
			store,
			configuration,
			provider: (id) => call(providers.get(id)),
			reserve: price,
			hash: (token) => call(sha256Hex(token)),
			token: (id, lease) => call(sha256Hex(`review-worker-v1:${id}:${lease}`)),
			observe: async (a, nowMs, running) => {
				const adapter = await call(providers.get(a.provider));
				await call(
					observeCloudRuntimeUsage({
						accountId: a.ownerId,
						resourceKind: "review",
						resourceId: a.id,
						provider: a.provider,
						providerSandboxId: a.providerSandboxId ?? undefined,
						runningSinceMs: running
							? (a.allocatedAtMs ?? a.createdAtMs)
							: undefined,
						observedAtMs: nowMs,
						...resolveSandboxResources(adapter, a.run.worker.size),
					}).pipe(
						Effect.provideService(ApiConfiguration, configuration),
						Effect.provideService(CloudBillingStore, billing),
						Effect.provideService(CloudWorkspaceStore, workspaces),
						Effect.provideService(SandboxProviders, providers),
					),
				);
			},
		});
	}),
);
export {
	completeReviewConnection,
	createReviewConnection,
	getReviewConnection,
	getReviewSetupResources,
	loginReviewConnection,
	revokeReviewConnection,
} from "./review-native-connections.ts";
