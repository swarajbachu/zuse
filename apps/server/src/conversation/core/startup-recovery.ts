import { joinId } from "@zuse/domain/agent-engine/ids";
import type { AttemptOwnership } from "@zuse/domain/engine/dispatch";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Delivery evidence is still checked by the job; existence never authorizes resend. */
export const hasRecoverableProviderSend = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	attempt: AttemptOwnership,
) =>
	sql<{ present: number }>`
	SELECT EXISTS(SELECT 1 FROM jobs WHERE session_id = ${sessionId}
		AND kind IN ('provider.turn.send', 'provider.turn.recover') AND status IN ('pending', 'running', 'waiting')
		AND json_valid(request_json)
		AND json_extract(request_json, '$.turnId') = ${attempt.turnId}
		AND json_extract(request_json, '$.attemptId') = ${attempt.attemptId}) AS present
`.pipe(
		Effect.map((rows) => rows[0]?.present === 1),
		Effect.orDie,
	);

/** Older engines parked known startup failures for boot retry. Keep them user-driven. */
export const retireLegacyStartupRetries = (sql: SqlClient.SqlClient) =>
	sql`UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
		completed_at = COALESCE(completed_at, updated_at)
		WHERE kind = 'provider.turn.send' AND status = 'waiting'
		AND last_error LIKE 'Provider turn could not be started after durable intent:%'
		AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = jobs.session_id AND sessions.status = 'error')
	`.pipe(Effect.asVoid, Effect.orDie);

interface RuntimeRecoveryRow {
	id: string;
	status: string;
	queue_paused: number;
	archived_at: string | null;
	provider_reservation_id: string | null;
	attachment: string | null;
	turn_id: string | null;
	attempt_id: string | null;
	phase: string | null;
	turn_status: string | null;
}

/** Requires exclusive runtime ownership and no workers. Performs only local durable work. */
export const reconcileSessionRuntime = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
) =>
	Effect.gen(function* () {
		const recoveryId = crypto.randomUUID();
		let after: string | null = null;
		while (true) {
			const rows: readonly RuntimeRecoveryRow[] =
				yield* sql<RuntimeRecoveryRow>`
			SELECT s.id, s.status, s.queue_paused, s.archived_at, s.provider_reservation_id,
				(SELECT e.type FROM events e WHERE e.stream_kind = 'session' AND e.stream_id = s.id
					AND e.type IN ('ProviderAttached', 'ProviderDetached') ORDER BY e.stream_version DESC LIMIT 1) AS attachment,
				t.id AS turn_id, t.active_attempt_id AS attempt_id, t.phase, t.status AS turn_status
			FROM sessions s LEFT JOIN session_turns t ON t.session_id = s.id AND t.status IN ('starting', 'running', 'finalizing')
			WHERE ${after === null ? sql.literal("1") : sql`s.id > ${after}`} ORDER BY s.id LIMIT 100
		`.pipe(Effect.orDie);
			if (rows.length === 0) break;
			for (const row of rows) {
				after = row.id;
				const dispatch = (
					suffix: string,
					command: Parameters<SessionDomainApi["dispatch"]>[0]["command"],
					expectedAttempt?: AttemptOwnership,
				) =>
					domain
						.dispatch({
							commandId: joinId("recovery", recoveryId, row.id, suffix),
							streamId: row.id,
							command,
							expectedAttempt,
						})
						.pipe(Effect.orDie);
				const now = Date.now();
				if (
					row.provider_reservation_id !== null ||
					row.attachment === "ProviderAttached"
				) {
					yield* dispatch("stop", {
						_tag: "RequestProviderStop",
						requestedAt: now,
					});
					yield* dispatch("detach", {
						_tag: "DetachProvider",
						detachedAt: now,
					});
				}
				if (row.archived_at !== null) {
					if (row.turn_id !== null)
						yield* dispatch("archived-turn", {
							_tag: "SettleTurn",
							turnId: row.turn_id,
							outcome: "interrupted",
							settledAt: now,
						});
					continue;
				}
				if (row.turn_status === "finalizing") continue;
				if (row.turn_id !== null && row.attempt_id !== null) {
					const attempt = { turnId: row.turn_id, attemptId: row.attempt_id };
					if (row.queue_paused === 1 && row.phase === "running") {
						const requests =
							yield* sql`SELECT 1 FROM events WHERE stream_kind = 'session' AND stream_id = ${row.id}
							AND type = 'ProviderTurnRequested' AND json_valid(payload_json)
							AND json_extract(payload_json, '$.turnId') = ${row.turn_id} LIMIT 1`.pipe(
								Effect.orDie,
							);

						if (requests.length === 0) continue;
					}
					if (yield* hasRecoverableProviderSend(sql, row.id, attempt)) {
						yield* dispatch(
							"pending",
							{ _tag: "SetStatus", status: "booting", updatedAt: now },
							attempt,
						);
						continue;
					}

					if (row.status === "error") {
						const failedSend = yield* sql`SELECT 1 FROM jobs
							WHERE session_id = ${row.id} AND kind = 'provider.turn.send'
							AND status = 'failed' AND json_valid(request_json)
							AND json_extract(request_json, '$.turnId') = ${row.turn_id}
							AND json_extract(request_json, '$.attemptId') = ${row.attempt_id}
							LIMIT 1`.pipe(Effect.orDie);
						if (failedSend.length > 0) continue;
					}
					const interrupted =
						row.phase === "interrupt-requested" ||
						row.phase === "interrupt-acknowledged";
					if (!interrupted) {
						const evidence =
							yield* sql`SELECT 1 FROM session_attempts WHERE session_id = ${row.id} AND id = ${row.attempt_id} AND provider_turn_json IS NOT NULL LIMIT 1`.pipe(
								Effect.orDie,
							);
						if (evidence.length > 0) {
							yield* dispatch(
								"recover",
								{
									_tag: "RecoverTurn",
									turnId: row.turn_id,
									expectedAttemptId: row.attempt_id,
									requestedAt: now,
								},
								attempt,
							);
							continue;
						}
					}
					if (!interrupted)
						yield* dispatch(
							"explain",
							{
								_tag: "PersistMessage",
								messageId: joinId("runtime-loss", row.id, row.attempt_id),
								turnId: row.turn_id,
								role: "system",
								kind: "error",
								contentJson: JSON.stringify({
									_tag: "error",
									message:
										"The Agent Engine stopped before this turn settled. Its delivery is not being repeated automatically. Review the provider result before retrying.",
								}),
								parentItemId: null,
								createdAt: now,
							},
							attempt,
						);
					yield* dispatch(
						"settle",
						{
							_tag: "SettleTurn",
							turnId: row.turn_id,
							outcome: interrupted ? "interrupted" : "error",
							settledAt: now,
						},
						attempt,
					);
				} else if (row.status === "running" || row.status === "booting") {
					yield* dispatch("orphan-status", {
						_tag: "SetStatus",
						status: "error",
						updatedAt: now,
					});
				}
			}
		}
	});
