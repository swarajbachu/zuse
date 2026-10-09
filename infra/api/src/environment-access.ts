import { Effect } from "effect";
import { requireOrganizationMember } from "./organizations.ts";
import type { EnvironmentRecord } from "./store.ts";

/** Discovery is a short-lived hint. The host still authorizes each workspace RPC. */
export const canDiscoverEnvironment = Effect.fn("canDiscoverEnvironment")(
	function* (
		environment: EnvironmentRecord,
		subject: string,
		nowMs: number,
		staleMs: number,
	) {
		if (environment.accountId === subject) return true;
		if (
			environment.lastSeenAtMs === undefined ||
			nowMs - environment.lastSeenAtMs > staleMs
		)
			return false;
		for (const candidate of environment.sharingAudience ?? []) {
			if (candidate.subject !== subject) continue;
			const allowed = yield* Effect.gen(function* () {
				// The publisher must still belong to the organization it is sharing with.
				yield* requireOrganizationMember(
					environment.accountId,
					candidate.organizationId,
				);
				const member = yield* requireOrganizationMember(
					subject,
					candidate.organizationId,
					candidate.adminOnly,
				);
				return member.id === candidate.membershipId;
			}).pipe(
				Effect.catchTag("ApiError", (error) =>
					error.status === 403 || error.status === 404
						? Effect.succeed(false)
						: Effect.fail(error),
				),
			);
			if (allowed) return true;
		}
		return false;
	},
);
