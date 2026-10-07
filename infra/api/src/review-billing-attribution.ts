import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
export interface ReviewExecutionWindow {
	provider: string;
	providerSandboxId?: string;
	internalResourceId: string;
	startedAtMs: number;
	endedAtMs: number;
}
export interface ReviewBillingResource {
	accountId: string;
	resourceId: string;
	providerSandboxId: string;
}
export class ReviewBillingAttribution extends Context.Service<
	ReviewBillingAttribution,
	{
		resolve: (
			window: ReviewExecutionWindow,
		) => Promise<ReviewBillingResource | null>;
	}
>()("api/ReviewBillingAttribution") {}
/** A paused native sandbox is reused. Its current connection owner is never a settlement attribution. */
export const ReviewBillingAttributionLive = Layer.effect(
	ReviewBillingAttribution,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return {
			resolve: async (window) => {
				if (
					!window.providerSandboxId ||
					!Number.isSafeInteger(window.startedAtMs) ||
					!Number.isSafeInteger(window.endedAtMs) ||
					window.endedAtMs <= window.startedAtMs
				)
					return null;
				const rows = await Effect.runPromise(sql<{
					account_id: string;
					resource_id: string;
					provider_sandbox_id: string;
				}>`
   SELECT a.owner_id AS account_id,a.id AS resource_id,a.provider_sandbox_id FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id
   WHERE a.provider=${window.provider} AND a.provider_sandbox_id=${window.providerSandboxId} AND (a.id=${window.internalResourceId} OR r.model_connection_id=${window.internalResourceId})
    AND a.created_at_ms<=${window.startedAtMs} AND a.stopped_at_ms>=${window.endedAtMs}
   UNION ALL
   SELECT owner_id AS account_id,id AS resource_id,provider_sandbox_id FROM api_review_native_activities
   WHERE provider=${window.provider} AND provider_sandbox_id=${window.providerSandboxId} AND (connection_id=${window.internalResourceId} OR id=${window.internalResourceId})
    AND started_at_ms<=${window.startedAtMs} AND stopped_at_ms>=${window.endedAtMs}`);
				// Ambiguity is a reconciliation condition, not permission to pick a payer.
				if (rows.length !== 1) return null;
				const row = rows[0];
				if (!row) return null;
				return {
					accountId: row.account_id,
					resourceId: row.resource_id,
					providerSandboxId: row.provider_sandbox_id,
				};
			},
		};
	}),
);
