import { InstallationStore } from "@zuse/slack/installations";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { openApiString, sealApiString } from "../api-sealing.ts";
import { ApiConfiguration } from "../config.ts";

export class SlackPersistence extends Context.Service<
	SlackPersistence,
	InstallationStore
>()("api/SlackPersistence") {}

export const SlackPersistenceLive = Layer.effect(
	SlackPersistence,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const config = yield* ApiConfiguration;
		const run = (operation: Effect.Effect<string, unknown, ApiConfiguration>) =>
			Effect.runPromise(
				operation.pipe(Effect.provideService(ApiConfiguration, config)),
			);
		return new InstallationStore(
			{
				query: (query, values = []) =>
					Effect.runPromise(sql.unsafe(query, [...values])),
			},
			{
				seal: (context, value) => run(sealApiString(context, value)),
				open: (context, value) => run(openApiString(context, value)),
			},
		);
	}),
);
