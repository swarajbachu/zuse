import { getReviewProviderEligibility } from "@zuse/agents/review/eligibility";
import { Effect, Option, Schema } from "effect";
import { badRequest, serviceUnavailable } from "./errors.ts";
import { githubRequest } from "./github-transport.ts";
import {
	type ReviewComparison,
	shouldAutomaticallyReviewPull,
} from "./review-domain.ts";
import { reviewInstallationToken } from "./review-github.ts";
import { drainReviewPublicationOutbox } from "./review-publication-dispatch.ts";
import { type ReviewInboxEntry, ReviewStore } from "./review-store.ts";

const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const SignedEvent = Schema.Struct({
	repository: Schema.Struct({ id: Positive }),
	installation: Schema.Struct({ id: Positive }),
	action: Schema.optional(Schema.String),
	number: Schema.optional(Positive),
	ref: Schema.optional(Schema.String),
});
const InboxPayload = Schema.Struct({
	installationId: Positive,
	pullNumber: Schema.optional(Positive),
	baseRef: Schema.optional(Schema.String),
});
/** Called only after the existing GitHub HMAC verifier accepts the raw body. */
export const ingestReviewGithubEvent = Effect.fn("ingestReviewGithubEvent")(
	function* (event: string, deliveryId: string | null, raw: Uint8Array) {
		if (event !== "pull_request" && event !== "push") return false;
		const service = yield* Effect.serviceOption(ReviewStore);
		if (Option.isNone(service)) return false;
		if (!deliveryId || !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId))
			return yield* badRequest("review_invalid_delivery");
		const payload = yield* Effect.try({
			try: () =>
				Schema.decodeUnknownSync(SignedEvent)(
					JSON.parse(new TextDecoder().decode(raw)),
				),
			catch: () => badRequest("review_invalid_event"),
		});
		if (
			event === "pull_request" &&
			![
				"opened",
				"reopened",
				"synchronize",
				"ready_for_review",
				"edited",
				"closed",
			].includes(payload.action ?? "")
		)
			return true;
		if (event === "pull_request" && !payload.number)
			return yield* badRequest("review_invalid_event");
		if (event === "push" && !payload.ref?.startsWith("refs/heads/"))
			return true;
		yield* Effect.tryPromise({
			try: () =>
				service.value.enqueueEvent(
					deliveryId,
					payload.repository.id,
					event,
					{
						installationId: payload.installation.id,
						...(payload.number ? { pullNumber: payload.number } : {}),
						...(payload.ref
							? { baseRef: payload.ref.slice("refs/heads/".length) }
							: {}),
					},
					Date.now(),
				),
			catch: () => serviceUnavailable("review_inbox_unavailable"),
		});
		return true;
	},
);
const Pull = Schema.Struct({
	number: Positive,
	state: Schema.String,
	draft: Schema.optional(Schema.Boolean),
	user: Schema.Struct({ id: Positive, type: Schema.optional(Schema.String) }),
	base: Schema.Struct({
		ref: Schema.String,
		sha: Schema.String,
		repo: Schema.Struct({ id: Positive, full_name: Schema.String }),
	}),
	head: Schema.Struct({
		sha: Schema.String,
		repo: Schema.NullOr(Schema.Struct({ id: Positive })),
	}),
});
export const reconcileReviewInbox = Effect.fn("reconcileReviewInbox")(
	function* () {
		const service = yield* Effect.serviceOption(ReviewStore);
		if (Option.isNone(service)) return { processed: 0 };
		const store = service.value;
		const events = yield* Effect.tryPromise({
			try: () => store.claimEvents(Date.now(), 20),
			catch: () => serviceUnavailable("review_inbox_unavailable"),
		});
		let processed = 0;
		for (const event of events) {
			const refreshToken = yield* Effect.tryPromise({
				try: () => store.claimRepositoryRefresh(event.repositoryId, Date.now()),
				catch: () => serviceUnavailable("review_storage_unavailable"),
			});
			const result = yield* (
				refreshToken
					? processEvent(event, refreshToken).pipe(
							Effect.ensuring(
								Effect.promise(() =>
									store.releaseRepositoryRefresh(
										event.repositoryId,
										refreshToken,
									),
								),
							),
						)
					: Effect.fail(serviceUnavailable("review_refresh_busy"))
			).pipe(Effect.result);
			yield* Effect.tryPromise({
				try: () =>
					store.finishEvent(
						event.deliveryId,
						event.leaseToken,
						Date.now(),
						result._tag === "Failure"
							? "review_github_refresh_failed"
							: undefined,
					),
				catch: () => serviceUnavailable("review_inbox_unavailable"),
			});
			if (result._tag === "Success") processed++;
		}
		const due = yield* Effect.tryPromise({
			try: () => store.dueRunIds(Date.now(), 100),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
		for (const id of due) {
			const claim = yield* Effect.tryPromise({
				try: () => store.claimRun(id, Date.now()),
				catch: () => serviceUnavailable("review_storage_unavailable"),
			});
			if (!claim) continue;
			const profile = getReviewProviderEligibility(claim.run.agentProvider);
			yield* Effect.tryPromise({
				try: () =>
					store.blockRun(
						id,
						claim.leaseToken,
						claim.run.fork
							? "fork_approval_required"
							: profile.status === "blocked"
								? profile.reasons.join(",")
								: "review_dispatch_unavailable",
						Date.now(),
					),
				catch: () => serviceUnavailable("review_storage_unavailable"),
			});
		}
		yield* drainReviewPublicationOutbox();
		return { processed };
	},
);
const processEvent = Effect.fn("processReviewEvent")(function* (
	event: ReviewInboxEntry,
	refreshToken: string,
) {
	const service = yield* Effect.serviceOption(ReviewStore);
	if (Option.isNone(service)) return;
	const store = service.value;
	const payload = yield* Schema.decodeUnknownEffect(InboxPayload)(
		event.payload,
	).pipe(Effect.mapError(() => badRequest("review_invalid_event")));
	const grant = yield* reviewInstallationToken(
		payload.installationId,
		event.repositoryId,
	);
	const repository = yield* githubRequest<unknown>(
		`https://api.github.com/repositories/${event.repositoryId}`,
		grant.token,
	).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Struct({ id: Positive, full_name: Schema.String }),
			),
		),
		Effect.mapError(() => badRequest("review_repository_invalid")),
	);
	if (
		repository.id !== event.repositoryId ||
		!/^[^/\s]+\/[^/\s]+$/.test(repository.full_name)
	)
		return yield* badRequest("review_repository_invalid");
	const urls: string[] = [];
	if (payload.pullNumber)
		urls.push(
			`https://api.github.com/repos/${repository.full_name}/pulls/${payload.pullNumber}`,
		);
	else if (payload.baseRef) {
		for (let page = 1; page <= 10; page++) {
			const pulls = yield* githubRequest<unknown>(
				`https://api.github.com/repos/${repository.full_name}/pulls?state=open&base=${encodeURIComponent(payload.baseRef)}&per_page=100&page=${page}`,
				grant.token,
			).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ number: Positive })),
					),
				),
				Effect.mapError(() => badRequest("review_pull_invalid")),
			);
			for (const pull of pulls)
				urls.push(
					`https://api.github.com/repos/${repository.full_name}/pulls/${pull.number}`,
				);
			if (pulls.length < 100) break;
			if (page === 10)
				return yield* serviceUnavailable("review_pull_pagination_limit");
		}
	}
	for (const url of urls) {
		const renewed = yield* Effect.tryPromise({
			try: () =>
				store.renewRepositoryRefresh(
					event.repositoryId,
					refreshToken,
					Date.now(),
				),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
		if (!renewed) return yield* serviceUnavailable("review_refresh_lease_lost");
		const pull = yield* githubRequest<unknown>(url, grant.token).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Pull)),
			Effect.mapError(() => badRequest("review_pull_invalid")),
		);
		if (pull.base.repo.id !== event.repositoryId)
			return yield* badRequest("review_repository_invalid");
		if (pull.state !== "open") {
			yield* Effect.tryPromise({
				try: () => store.closePull(event.repositoryId, pull.number, Date.now()),
				catch: () => serviceUnavailable("review_storage_unavailable"),
			});
			continue;
		}
		if (
			!shouldAutomaticallyReviewPull({
				draft: pull.draft,
				authorType: pull.user.type,
			})
		)
			continue;
		if (
			!/^[a-f0-9]{40,64}$/.test(pull.head.sha) ||
			!/^[a-f0-9]{40,64}$/.test(pull.base.sha)
		)
			return yield* badRequest("review_invalid_sha");
		const comparison: ReviewComparison = {
			repositoryId: event.repositoryId,
			repositoryFullName: repository.full_name,
			installationId: payload.installationId,
			pullNumber: pull.number,
			authorGithubUserId: pull.user.id,
			baseRef: pull.base.ref,
			baseSha: pull.base.sha,
			headSha: pull.head.sha,
			fork: pull.head.repo?.id !== event.repositoryId,
		};
		const created = yield* Effect.tryPromise({
			try: () =>
				store.createRun(comparison, Date.now(), "automatic", refreshToken),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
		if (created?.state !== "queued") continue;
		const claimed = yield* Effect.tryPromise({
			try: () => store.claimRun(created.id, Date.now()),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
		if (!claimed) continue;
		const profile = getReviewProviderEligibility(created.agentProvider);
		const reason = created.fork
			? "fork_approval_required"
			: profile.status === "blocked"
				? profile.reasons.join(",")
				: "review_dispatch_unavailable";
		// No allocation until a certified provider and enrolled native runner are installed.
		yield* Effect.tryPromise({
			try: () =>
				store.blockRun(created.id, claimed.leaseToken, reason, Date.now()),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
	}
});
