import type { MachinePersistenceRecord } from "./machine-store.ts";

export const MAX_RECONCILE_ATTEMPTS = 8;
export const MAX_RECONCILE_BACKOFF_MS = 15 * 60 * 1_000;

export const retryAt = (nowMs: number, attemptCount: number): number =>
	nowMs +
	Math.min(
		MAX_RECONCILE_BACKOFF_MS,
		5_000 * 2 ** Math.min(attemptCount, MAX_RECONCILE_ATTEMPTS),
	);

export const withProviderFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
	error: { readonly code: "transient" | "not-found" | "rejected" },
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	const exhausted =
		attemptCount >= MAX_RECONCILE_ATTEMPTS || error.code === "rejected";
	return {
		...machine,
		state: exhausted ? "failed" : machine.state,
		statusCode: exhausted ? "reconciliation-failed" : "provider-unavailable",
		stableFailureCode:
			error.code === "rejected"
				? "provider-rejected"
				: error.code === "not-found"
					? "provider-machine-missing"
					: "provider-temporarily-unavailable",
		attemptCount,
		nextActionAtMs: exhausted
			? nowMs + MAX_RECONCILE_BACKOFF_MS
			: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};

export const withBillingFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	return {
		...machine,
		state: "destroying",
		statusCode: "reconciliation-failed",
		stableFailureCode: "billing-provider-unavailable",
		attemptCount,
		nextActionAtMs: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};

export const withCancellationBillingFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	return {
		...machine,
		statusCode: "reconciliation-failed",
		stableFailureCode: "billing-provider-unavailable",
		attemptCount,
		nextActionAtMs: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};
