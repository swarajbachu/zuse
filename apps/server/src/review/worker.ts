import { getReviewProviderEligibility } from "@zuse/agents/review/eligibility";
import type { ReviewResult, ReviewSnapshot } from "@zuse/contracts";
import {
	type InvestigatorInput,
	type ReviewLimits,
	type ReviewSource,
	runReview,
	type VerifierInput,
} from "@zuse/review";

export interface ReviewWorkerBinding {
	readonly runId: string;
	readonly connectionId: string;
	readonly providerId: string;
	readonly model: string;
	readonly snapshot: ReviewSnapshot;
}

export interface ReviewAgentSession {
	readonly investigate: (input: InvestigatorInput) => Promise<unknown>;
	readonly verify: (input: VerifierInput) => Promise<"confirmed" | "rejected">;
	/** Resolves only after the provider process and its children have stopped. */
	readonly close: () => Promise<void>;
}

/** Internal dependency, never selected by an HTTP request or repository config. */
export interface ReviewAgentFactory {
	/** Every call must create an isolated session without prior transcripts. */
	readonly open: (input: {
		readonly binding: ReviewWorkerBinding;
		readonly role: "investigator" | "verifier";
		readonly signal: AbortSignal;
	}) => Promise<ReviewAgentSession>;
}

export interface ReviewWorkerArtifact {
	readonly version: 1;
	readonly runId: string;
	readonly result: ReviewResult;
}

export interface ReviewWorkerInput {
	readonly binding: ReviewWorkerBinding;
	readonly source: ReviewSource;
	readonly limits?: Partial<ReviewLimits>;
	readonly signal?: AbortSignal;
}

export class ReviewProviderUnavailableError extends Error {
	constructor(readonly reasons: readonly string[]) {
		super("Hosted review provider is unavailable");
		this.name = "ReviewProviderUnavailableError";
	}
}

/** Production entry point: there is no approved native subscription profile yet. */
export async function runNativeReviewWorker(
	input: ReviewWorkerInput,
): Promise<ReviewWorkerArtifact> {
	const eligibility = getReviewProviderEligibility(input.binding.providerId);
	throw new ReviewProviderUnavailableError(eligibility.reasons);
}

function validateBinding(input: ReviewWorkerInput): void {
	for (const value of [
		input.binding.runId,
		input.binding.connectionId,
		input.binding.providerId,
		input.binding.model,
	]) {
		if (!value.trim() || value.length > 256)
			throw new Error("Invalid review worker binding");
	}
	for (const key of [
		"repositoryId",
		"baseRef",
		"baseSha",
		"headSha",
		"mergeBaseSha",
	] as const) {
		if (input.binding.snapshot[key] !== input.source.snapshot[key]) {
			throw new Error("Review worker snapshot mismatch");
		}
	}
}

/**
 * Composition harness for a trusted adapter. This does not provision a worker or
 * grant provider eligibility. The caller owns the connection lease and must kill
 * the whole worker if shutdown cannot be confirmed.
 */
export async function runReviewWithAdapter(
	input: ReviewWorkerInput,
	factory: ReviewAgentFactory,
	shutdownTimeoutMs = 5_000,
): Promise<ReviewWorkerArtifact> {
	validateBinding(input);
	if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
		throw new Error("Invalid shutdown timeout");
	}
	input.signal?.throwIfAborted();
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	const openings = new Set<Promise<void>>();
	const shutdowns = new Set<Promise<void>>();
	const sessions = new Map<ReviewAgentSession, () => Promise<void>>();
	const invoke = async <T>(
		role: "investigator" | "verifier",
		signal: AbortSignal,
		operation: (session: ReviewAgentSession) => Promise<T>,
	): Promise<T> => {
		signal.throwIfAborted();
		const opening = Promise.resolve().then(() =>
			factory.open({ binding: input.binding, role, signal }),
		);
		const tracking = opening.then(
			() => {},
			() => {},
		);
		openings.add(tracking);
		let session: ReviewAgentSession;
		try {
			session = await opening;
		} finally {
			openings.delete(tracking);
		}
		if (sessions.has(session)) {
			throw new Error("Review adapter reused a provider session");
		}
		let closing: Promise<void> | undefined;
		const close = () => {
			if (!closing) {
				closing = Promise.resolve().then(() => session.close());
				shutdowns.add(closing);
				// Keep a rejected shutdown for the final join, without an unhandled rejection.
				void closing.catch(() => {});
			}
			return closing;
		};
		sessions.set(session, close);
		const stop = () => {
			void close();
		};
		signal.addEventListener("abort", stop, { once: true });
		try {
			if (controller.signal.aborted) throw new Error("Review worker stopped");
			signal.throwIfAborted();
			return await operation(session);
		} finally {
			signal.removeEventListener("abort", stop);
			await close();
		}
	};
	let result: ReviewResult;
	try {
		result = await runReview({
			snapshot: input.binding.snapshot,
			source: input.source,
			...(input.limits ? { limits: input.limits } : {}),
			signal: controller.signal,
			investigate: (request) =>
				invoke("investigator", request.signal, (session) =>
					session.investigate(request),
				),
			verify: (request) =>
				invoke("verifier", request.signal, (session) =>
					session.verify(request),
				),
		});
	} finally {
		controller.abort();
		input.signal?.removeEventListener("abort", onAbort);
		for (const close of sessions.values()) void close();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					await Promise.all(openings);
					// A late-opened session observes controller.abort and closes itself.
					await Promise.all(shutdowns);
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Review worker shutdown unconfirmed")),
						shutdownTimeoutMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	return { version: 1, runId: input.binding.runId, result };
}
