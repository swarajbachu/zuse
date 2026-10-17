import {
	SimulatorTools,
	type SimulatorToolsClient,
	SimulatorToolTarget,
} from "@zuse/agents/drivers/simulator-tools";
import { ChatId, SimulatorError, type SimulatorState } from "@zuse/contracts";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../app-paths.ts";
import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import {
	errorMessage,
	SimulatorController,
	type SimulatorPreferences,
} from "./controller.ts";
export class SimulatorService extends Context.Service<
	SimulatorService,
	{
		controller: SimulatorController;
		changes: () => Stream.Stream<SimulatorState>;
		tools: SimulatorToolsClient;
	}
>()("zuse/SimulatorService") {}
export const SimulatorServiceLive = Layer.effect(
	SimulatorService,
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const config = yield* ConfigStoreService;
		const sql = yield* SqlClient.SqlClient;
		const updates = yield* PubSub.sliding<SimulatorState>({
			capacity: 1,
			replay: 1,
		});
		yield* Effect.addFinalizer(() => PubSub.shutdown(updates));
		const preferences = async (): Promise<SimulatorPreferences> => {
			const settings = await Effect.runPromise(config.getSettings());
			return {
				enabled: settings.simulatorSupportEnabled ?? false,
				agentAccessEnabled: settings.simulatorAgentAccessEnabled ?? false,
				onboardingCompleted: settings.simulatorOnboardingCompleted ?? false,
			};
		};
		const controller = yield* Effect.acquireRelease(
			Effect.sync(
				() =>
					new SimulatorController({
						root: paths.userData,
						preferences,
						filterSessions: async (sessions) => {
							if (!sessions.length) return sessions;
							const ids = [
								...new Set(sessions.map((session) => session.chatId)),
							];
							const rows = await Effect.runPromise(
								sql<{
									id: string;
								}>`SELECT id FROM chats WHERE ${sql.in("id", ids)}`,
							);
							const existing = new Set(rows.map((row) => row.id));
							return sessions.filter((session) => existing.has(session.chatId));
						},
						savePreferences: async (value) => {
							await Effect.runPromise(
								config.updateSettings({
									simulatorSupportEnabled: value.enabled,
									simulatorAgentAccessEnabled: value.agentAccessEnabled,
									simulatorOnboardingCompleted: value.onboardingCompleted,
								}),
							);
						},
						publish: (state) => {
							void Effect.runPromise(PubSub.publish(updates, state)).catch(
								() => {},
							);
						},
					}),
			),
			(controller) => Effect.promise(() => controller.dispose()),
		);
		yield* Effect.promise(() => controller.initialize());
		// Settings hand-edits and normal settings RPCs enforce the same live capability gate.
		yield* config.settingsChanges().pipe(
			Stream.runForEach((settings) =>
				Effect.promise(async () => {
					const next = {
						enabled: settings.simulatorSupportEnabled ?? false,
						agentAccessEnabled: settings.simulatorAgentAccessEnabled ?? false,
						onboardingCompleted: settings.simulatorOnboardingCompleted ?? false,
					};
					if (
						controller.state.enabled !== next.enabled ||
						controller.state.agentAccessEnabled !== next.agentAccessEnabled ||
						controller.state.onboardingCompleted !== next.onboardingCompleted
					)
						await controller.reconcile(next);
				}),
			),
			Effect.forkScoped({ startImmediately: true }),
		);
		const tools: SimulatorToolsClient = {
			call: async (sessionId, name, args, signal) => {
				signal.throwIfAborted();
				if (!controller.state.enabled || !controller.state.agentAccessEnabled)
					throw new Error(
						"Agent device access is off. Turn it on in the Simulator panel.",
					);
				const [row] = await Effect.runPromise(
					sql<{
						chat_id: string;
					}>`SELECT chat_id FROM sessions WHERE id=${sessionId}`,
				);
				if (!row)
					throw new Error("Device tools require a current Zuse chat session.");
				const chatId = ChatId.make(row.chat_id);
				if (name === "device_list") {
					const state = await controller.refresh();
					await controller.requireAccess(true);
					signal.throwIfAborted();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									devices: state.devices,
									open: state.sessions.filter(
										(session) => session.chatId === chatId,
									),
									detail: state.detail,
								}),
							},
						],
					};
				}
				const input = Schema.decodeUnknownSync(SimulatorToolTarget)(args),
					target = { chatId, deviceId: input.deviceId };
				if (name === "device_open") {
					const device = await controller.open(target, true);
					const agentDevice = await controller.agentTarget(target);
					return {
						content: [
							{ type: "text", text: JSON.stringify({ device, agentDevice }) },
						],
					};
				}
				if (name === "device_screenshot")
					return {
						content: [
							{
								type: "image",
								data: await controller.screenshot(target, true),
								mimeType: "image/png",
							},
						],
					};
				if (name === "device_close") {
					await controller.close(target, input.shutdown ?? false, true);
					return {
						content: [{ type: "text", text: "Device session closed." }],
					};
				}
				throw new Error("Unknown device tool");
			},
		};
		return { controller, changes: () => Stream.fromPubSub(updates), tools };
	}),
);
export const SimulatorToolsLive = Layer.effect(
	SimulatorTools,
	Effect.map(SimulatorService, (service) => service.tools),
);
export const simulatorEffect = <A>(work: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (cause) => new SimulatorError({ reason: errorMessage(cause) }),
	});
