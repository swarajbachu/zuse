import { AgentSessionId } from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "./provider/services/provider-service.ts";

/** Shared authoritative idle predicate; callers hold the domain admission transaction. */
export const isEngineIdle = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly domain: SessionDomainApi;
	readonly activeTurnCount: SqlSessionQueriesApi["activeTurnCount"];
	readonly hasSession: ProviderServiceShape["hasSession"];
}) =>
	Effect.gen(function* () {
		if ((yield* options.domain.admission.activeOperations) > 0) return false;
		if ((yield* options.activeTurnCount) > 0) return false;
		if ((yield* options.domain.jobs.unsettledCount) > 0) return false;
		const constructions = yield* options.sql<{
			pending: number;
		}>`SELECT EXISTS(SELECT 1 FROM session_fork_constructions WHERE completed_at IS NULL) AS pending`;
		if (constructions[0]?.pending === 1) return false;
		const restores = yield* options.sql<{
			pending: number;
		}>`SELECT EXISTS(SELECT 1 FROM session_checkpoint_restores WHERE completed_at IS NULL) AS pending`;
		if (restores[0]?.pending === 1) return false;
		const delegations = yield* options.sql<{
			pending: number;
		}>`SELECT EXISTS(SELECT 1 FROM session_delegations WHERE cancelled_at IS NULL AND wake_turn_id IS NULL) AS pending`;
		if (delegations[0]?.pending === 1) return false;
		const reservations = yield* options.sql<{
			id: string;
			provider_reservation_id: string;
		}>`
		SELECT id, provider_reservation_id FROM sessions
		WHERE archived_at IS NULL AND provider_reservation_id IS NOT NULL
	`;

		for (const reservation of reservations)
			if (
				!(yield* options.hasSession(
					AgentSessionId.make(reservation.id),
					reservation.provider_reservation_id,
				))
			)
				return false;
		// Archived turns cannot settle at runtime, so only a live provider keeps them busy.
		const archivedTurns = yield* options.sql<{ id: string }>`
		SELECT DISTINCT s.id FROM sessions s
		JOIN session_turns t ON t.session_id = s.id
		WHERE s.archived_at IS NOT NULL AND t.status IN ('starting', 'running', 'finalizing')
	`;
		for (const session of archivedTurns)
			if (yield* options.hasSession(AgentSessionId.make(session.id)))
				return false;
		return true;
	});
