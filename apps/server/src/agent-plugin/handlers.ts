import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import { AgentPluginError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { AppPaths } from "../app-paths.ts";
import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import {
	executeAgentPlugin,
	inspectAgentPlugin,
	listAgentPlugins,
	type PluginClient,
} from "./manager.ts";

// Serialize native config/cache mutations, including calls from multiple windows.
let pending: Promise<unknown> = Promise.resolve();
const run = <A>(
	operation: (client: PluginClient) => Promise<A>,
	mutate = false,
) =>
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		if (paths.telemetryIdentity?.kind !== "desktop")
			return yield* new AgentPluginError({
				reason: "Agent plugins are available on the local desktop.",
			});
		const config = yield* ConfigStoreService;
		const settings = yield* config.getSettings();
		return yield* Effect.tryPromise({
			try: async (cancel) => {
				const perform = async () => {
					cancel.throwIfAborted();
					const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
					const client = await CodexAppServerClient.start({
						codexPath: settings.providerBinaryPaths?.codex ?? null,
						startupTimeoutMs: 10_000,
						onNotification: () => {},
						onServerRequest: (_request, respond) => respond({}),
					});
					const close = () => client.close();
					signal.addEventListener("abort", close, { once: true });
					try {
						signal.throwIfAborted();
						return await operation(client);
					} finally {
						signal.removeEventListener("abort", close);
						client.close();
					}
				};
				if (!mutate) return perform();
				const result = pending.then(perform, perform);
				pending = result.catch(() => {});
				return result;
			},
			catch: (cause) =>
				new AgentPluginError({
					reason:
						cause instanceof Error
							? cause.message
							: "Codex plugin operation failed. Update Codex and retry.",
				}),
		});
	});
export const AgentPluginHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("agentPlugin.catalog", () =>
		run(listAgentPlugins),
	),
	MemoizeRpcs.toLayerHandler("agentPlugin.inspect", (locator) =>
		run((client) => inspectAgentPlugin(client, locator)),
	),
	MemoizeRpcs.toLayerHandler("agentPlugin.execute", (command) =>
		run((client) => executeAgentPlugin(client, command), true),
	),
);
