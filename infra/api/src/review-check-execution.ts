import { ReviewCheck, type ReviewResult } from "@zuse/contracts";
import {
	resolveSandboxResources,
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Context, Effect, Layer, Schema } from "effect";
import type { CloudBillingStore } from "./cloud-billing-store.ts";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import type { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import type { MachineStore } from "./machine-store.ts";
import {
	reviewInstallationToken,
	verifyReviewRepository,
} from "./review-github.ts";
import {
	ReviewLifecycleStore,
	type ReviewLifecycleStoreApi,
	type ReviewManagedAttempt,
	type ReviewNativeActivity,
} from "./review-lifecycle-store.ts";
import { screenReviewOutput } from "./review-output-screen.ts";
import { reserveReviewCost } from "./review-pricing.ts";
import { ReviewStore, type ReviewStoreApi } from "./review-store.ts";
import type { ApiStore } from "./store.ts";

const STATUS = "/run/zuse-review-checks/status.json";
const RUN_REQUESTED = "/run/zuse-review-checks/run-requested";
const MODULE = "/opt/zuse/review-check-runner.mjs";
const CheckStatus = Schema.Struct({
	phase: Schema.Literals(["prepared", "complete", "failed"]),
	checks: Schema.optional(
		Schema.Array(ReviewCheck).check(Schema.isMaxLength(3)),
	),
	reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export interface ReviewCheckExecutionApi {
	run(
		attempt: ReviewManagedAttempt,
		result: ReviewResult,
	): Promise<ReviewResult>;
}
export class ReviewCheckExecution extends Context.Service<
	ReviewCheckExecution,
	ReviewCheckExecutionApi
>()("api/ReviewCheckExecution") {}
export interface ReviewCheckDependencies {
	store: ReviewLifecycleStoreApi;
	core: ReviewStoreApi;
	templateId: string;
	provider(id: string): Promise<SandboxProviderAdapter>;
	authorize(
		a: ReviewManagedAttempt,
	): Promise<{ cloneUrl: string; token: string }>;
	reserve(
		a: ReviewManagedAttempt,
		id: string,
		durationMs: number,
		nowMs: number,
		maximumCostMicros?: number,
	): Promise<number>;
	observe(
		a: ReviewManagedAttempt,
		activity: ReviewNativeActivity,
		running: boolean,
	): Promise<void>;
	now(): number;
	sleep(ms: number): Promise<void>;
}
const call = <A>(effect: Effect.Effect<A, unknown>) =>
	Effect.runPromise(effect);
/** Tests run only after native compute is confirmed paused. No model/auth-home is copied. */
export function makeReviewCheckExecution(
	d: ReviewCheckDependencies,
): ReviewCheckExecutionApi {
	return {
		run: async (a, result) => {
			const id = `review-check-${a.id}`;
			const label = `zuse-review-${id}`;
			const provider = await d.provider(a.provider);
			let activity = await d.store.getActivity(id);
			let sandboxId = activity?.providerSandboxId ?? null;
			let durableResult: ReviewResult | undefined;
			const stop = async () => {
				if (!activity) return;
				if (!sandboxId)
					sandboxId =
						(await call(provider.recoverByLabel(label)))?.providerSandboxId ??
						null;
				if (sandboxId) {
					await call(provider.kill(sandboxId));
					if (await call(provider.inspect(sandboxId)))
						throw Error("review_check_stop_unconfirmed");
				} else if (d.now() < activity.deadlineMs) {
					// A lost create response may still be allocating. No replacement and no early settlement.
					throw Error("review_check_allocation_unconfirmed");
				}
				const stoppedAtMs = d.now();
				activity = {
					...activity,
					providerSandboxId: sandboxId,
					stoppedAtMs,
					state: "stopped",
				};
				await d.store.saveActivity(activity);
				await d.observe(a, activity, false);
			};
			const persist = async (next: ReviewResult) => {
				if (
					!(await d.store.updateAttempt(a.id, a.leaseToken, {
						pendingResult: next,
					}))
				)
					throw Error("review_check_fenced");
				durableResult = next;
				return next;
			};
			if (result.checks !== undefined || result.checksReason !== undefined) {
				if (activity?.state !== "stopped") await stop();
				return result;
			}
			const incomplete = async (reason: string) =>
				persist({
					...result,
					status: "partial",
					checks: [],
					checksReason: reason,
				});
			if (!d.templateId && !activity)
				return incomplete("review_check_image_unavailable");
			if (a.stoppedAtMs === null)
				throw Error("review_inference_stop_unconfirmed");
			const budget = await d.store.getRunExecutionBudget(a.runId);
			const availableMs = Math.min(
				180000,
				a.run.worker.maxRuntimeMs - budget.allocatedMs,
			);
			const availableCost =
				a.run.worker.maxCostMicros === undefined
					? undefined
					: a.run.worker.maxCostMicros - budget.maximumCostMicros;
			if (
				!activity &&
				(availableMs < 40000 ||
					(availableCost !== undefined && availableCost <= 0))
			)
				return incomplete("review_check_budget_exhausted");
			try {
				if (!activity) {
					const now = d.now();
					if (!(await d.core.renewRun(a.runId, a.leaseToken, now)))
						throw Error("review_check_cancelled");
					const maximumCostMicros = await d.reserve(
						a,
						id,
						availableMs,
						now,
						availableCost,
					);
					activity = {
						id,
						kind: "check",
						runId: a.runId,
						attemptId: a.id,
						size: a.run.worker.size,
						connectionId: a.run.modelConnectionId,
						ownerId: a.ownerId,
						provider: a.provider,
						providerSandboxId: null,
						startedAtMs: now,
						stoppedAtMs: null,
						deadlineMs: now + availableMs - 30000,
						maximumCostMicros,
						state: "admitted",
					};
					await d.store.saveActivity(activity);
					const grant = await d.authorize(a);
					const sandbox = await call(
						provider.fork({
							sandboxId: id,
							providerLabel: label,
							metadata: {
								"zuse-sandbox-id": id,
								"zuse-resource-kind": "review",
							},
							snapshotId: d.templateId,
							sizeId: a.run.worker.size,
							timeoutSeconds: Math.max(
								1,
								Math.floor((activity.deadlineMs - d.now()) / 1000),
							),
							env: {},
							network: {
								kind: "restricted",
								allowOut: ["github.com", "registry.npmjs.org"],
								denyOut: [],
							},
							onTimeout: "terminate",
						}),
					);
					sandboxId = sandbox.providerSandboxId;
					activity = {
						...activity,
						providerSandboxId: sandboxId,
						state: "running",
					};
					await d.store.saveActivity(activity);
					await d.observe(a, activity, true);
					await call(
						provider.startProcess(sandboxId, {
							command: "/usr/local/bin/node",
							args: [
								MODULE,
								"prepare",
								JSON.stringify({
									cloneUrl: grant.cloneUrl,
									baseSha: result.snapshot.mergeBaseSha,
									headSha: result.snapshot.headSha,
									deadlineMs: activity.deadlineMs,
								}),
							],
							env: { ZUSE_REVIEW_GIT_TOKEN: grant.token },
							user: "root",
							tag: "zuse-review-check-prepare",
						}),
					);
				} else if (activity.state === "stopped")
					return incomplete("review_check_interrupted");
				if (!sandboxId)
					sandboxId =
						(await call(provider.recoverByLabel(label)))?.providerSandboxId ??
						null;
				if (!sandboxId) throw Error("review_check_allocation_unconfirmed");
				// A root-owned exclusive run marker in the image makes this idempotent after control-plane restarts.
				while (d.now() < activity.deadlineMs - 1000) {
					if (
						!(await d.core.renewRun(a.runId, a.leaseToken, d.now())) ||
						!(await d.core.canReadRunArtifacts(a.runId))
					)
						throw Error("review_check_cancelled");
					if (await call(provider.pathExists(sandboxId, STATUS, "root"))) {
						const text = await call(
							provider.readTextFile(sandboxId, STATUS, "root"),
						);
						if (text.length > 60000) throw Error("review_check_output_invalid");
						const status = Schema.decodeUnknownSync(
							Schema.fromJsonString(CheckStatus),
						)(text);
						if (status.phase === "failed")
							throw Error("review_check_setup_failed");
						if (status.phase === "complete") {
							if (
								status.checks === undefined ||
								(status.checks.length === 0 &&
									status.reason !== "not_available")
							)
								throw Error("review_check_output_missing");
							const checks = (status.checks ?? []).map((check) => ({
								...check,
								base: {
									...check.base,
									output: screenReviewOutput(check.base.output)
										? check.base.output
										: "[Output withheld: possible secret]",
								},
								head: {
									...check.head,
									output: screenReviewOutput(check.head.output)
										? check.head.output
										: "[Output withheld: possible secret]",
								},
							}));
							const next = await persist({
								...result,
								checks,
								...(checks.length === 0
									? { checksReason: "review_check_no_supported_script" }
									: {}),
								...(checks.some((c) =>
									[c.base.status, c.head.status].some(
										(s) => s === "timeout" || s === "inconclusive",
									),
								)
									? {
											status: "partial" as const,
											checksReason: "review_checks_incomplete",
										}
									: {}),
							});
							await stop();
							return next;
						}
						if (
							await call(provider.pathExists(sandboxId, RUN_REQUESTED, "root"))
						) {
							await d.sleep(1000);
							continue;
						}
						await call(provider.setNetwork(sandboxId, { kind: "quarantined" }));
						// Persist before outbound start: unknown launch never authorizes another execution.
						await call(
							provider.writeTextFile(sandboxId, RUN_REQUESTED, a.id, "root"),
						);
						await call(
							provider.startProcess(sandboxId, {
								command: "/usr/local/bin/node",
								args: [
									MODULE,
									"run",
									JSON.stringify({
										cloneUrl: `https://github.com/${a.run.repositoryFullName}.git`,
										baseSha: result.snapshot.mergeBaseSha,
										headSha: result.snapshot.headSha,
										deadlineMs: activity.deadlineMs,
									}),
								],
								env: {},
								user: "root",
								tag: "zuse-review-check-run",
							}),
						);
					}
					await d.sleep(1000);
				}
				throw Error("review_check_timeout");
			} catch (error) {
				// Preserve verified evidence when teardown failed; reconciliation resumes stop only.
				if (durableResult) throw error;
				const next = await incomplete("review_checks_incomplete");
				await stop();
				return next;
			}
		},
	};
}
export const ReviewCheckExecutionLive = Layer.effect(
	ReviewCheckExecution,
	Effect.gen(function* () {
		const store = yield* ReviewLifecycleStore;
		const core = yield* ReviewStore;
		const config = yield* ApiConfiguration;
		const providers = yield* SandboxProviders;
		type Requirements =
			| ApiConfiguration
			| SandboxProviders
			| CloudBillingStore
			| CloudWorkspaceStore
			| MachineStore
			| ApiStore;
		const context = yield* Effect.context<Requirements>();
		const run = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
			Effect.runPromise(Effect.provide(effect, context));
		return makeReviewCheckExecution({
			store,
			core,
			templateId: config.review?.checkTemplateId ?? "",
			provider: (id) => run(providers.get(id)),
			now: Date.now,
			sleep: (ms) => run(Effect.sleep(ms)),
			authorize: async (a) => {
				const enrollment = (await core.listEnrollments(a.ownerId)).find(
					(e) =>
						e.id === a.run.enrollmentId &&
						e.version === a.run.enrollmentVersion &&
						e.enabled,
				);
				if (!enrollment) throw Error("review_check_revoked");
				const proof = await run(
					verifyReviewRepository(
						enrollment.enabledBy,
						a.ownerId,
						a.run.repositoryId,
					),
				);
				if (proof.installationId !== a.run.installationId)
					throw Error("review_check_revoked");
				const grant = await run(
					reviewInstallationToken(proof.installationId, proof.repositoryId),
				);
				return {
					cloneUrl: `https://github.com/${proof.repositoryFullName}.git`,
					token: grant.token,
				};
			},
			reserve: (a, id, durationMs, nowMs, maxCostMicros) =>
				run(
					reserveReviewCost({
						ownerId: a.ownerId,
						id,
						provider: a.provider,
						size: a.run.worker.size,
						durationMs,
						nowMs,
						maxCostMicros,
					}),
				),
			observe: async (a, activity, running) => {
				const p = await run(providers.get(a.provider));
				await run(
					observeCloudRuntimeUsage({
						accountId: a.ownerId,
						resourceKind: "review",
						resourceId: activity.id,
						provider: a.provider,
						providerSandboxId: activity.providerSandboxId ?? undefined,
						runningSinceMs: running ? activity.startedAtMs : undefined,
						observedAtMs: activity.stoppedAtMs ?? Date.now(),
						...resolveSandboxResources(p, a.run.worker.size),
					}),
				);
			},
		});
	}),
);
