import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { Migration0032ReactorEffectReceipts } from "../../src/persistence/migrations/0032_reactor_effect_receipts.ts";
import { Migration0054ProviderEffectOutcomes } from "../../src/persistence/migrations/0054_provider_effect_outcomes.ts";
import { makeReactorEffectJournal } from "../../src/provider/reactor-effect-journal.ts";

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("reactor effect journal", () => {
	it("retains an ambiguous started provider effect across journal recreation", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* Migration0032ReactorEffectReceipts;
				yield* Migration0054ProviderEffectOutcomes;
				const sql = yield* SqlClient.SqlClient;
				const firstProcess = makeReactorEffectJournal(sql);
				const started = yield* firstProcess.begin("provider-turn-1");

				const restartedProcess = makeReactorEffectJournal(sql);
				const recovered = yield* restartedProcess.begin("provider-turn-1");
				yield* restartedProcess.markOutcomeUnknown("provider-turn-1");
				yield* restartedProcess.complete("provider-turn-1");

				return {
					started,
					recovered,
					state: yield* restartedProcess.state("provider-turn-1"),
					terminal: yield* restartedProcess.isCompleted("provider-turn-1"),
				};
			}),
		);

		expect(result).toEqual({
			started: "started",
			recovered: "already-started",
			state: "outcome-unknown",
			terminal: true,
		});
	});

	it("treats pre-migration receipts as completed effects", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* Migration0032ReactorEffectReceipts;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO reactor_effect_receipts(effect_id, completed_at)
					VALUES ('legacy-effect', '2026-01-01T00:00:00.000Z')
				`;
				yield* Migration0054ProviderEffectOutcomes;
				const journal = makeReactorEffectJournal(sql);
				return {
					state: yield* journal.state("legacy-effect"),
					begin: yield* journal.begin("legacy-effect"),
				};
			}),
		);

		expect(result).toEqual({ state: "completed", begin: "completed" });
	});

	it("releases only a positively undelivered started effect for retry", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* Migration0032ReactorEffectReceipts;
				yield* Migration0054ProviderEffectOutcomes;
				const sql = yield* SqlClient.SqlClient;
				const journal = makeReactorEffectJournal(sql);

				yield* journal.begin("known-undelivered");
				yield* journal.releaseUndelivered("known-undelivered");
				const released = yield* journal.state("known-undelivered");

				yield* journal.begin("ambiguous");
				yield* journal.markOutcomeUnknown("ambiguous");
				yield* journal.releaseUndelivered("ambiguous");

				return {
					released,
					retry: yield* journal.begin("known-undelivered"),
					ambiguous: yield* journal.state("ambiguous"),
				};
			}),
		);

		expect(result).toEqual({
			released: "missing",
			retry: "started",
			ambiguous: "outcome-unknown",
		});
	});
});
