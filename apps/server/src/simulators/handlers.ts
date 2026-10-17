import { MemoizeRpcs, SimulatorError } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { filterCatalog } from "../collaboration/services/catalog-visibility.ts";
import { errorMessage } from "./controller.ts";
import { SimulatorService, simulatorEffect } from "./service.ts";
export const SimulatorHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("simulators.state", () =>
		Stream.unwrap(
			Effect.map(SimulatorService, (service) =>
				service
					.changes()
					.pipe(
						Stream.mapEffect((state) =>
							filterCatalog(state.sessions, (scope, session) =>
								scope.chats.has(session.chatId),
							).pipe(Effect.map((sessions) => ({ ...state, sessions }))),
						),
					),
			),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.refresh", () =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.refresh()),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.configure", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.configure(input)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.fix", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.fix(input.requirement)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.open", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.open(input)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.close", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.close(input, input.shutdown)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.screenshot", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.screenshot(input)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.input", (input) =>
		Effect.flatMap(SimulatorService, (service) =>
			simulatorEffect(() => service.controller.input(input, input.input)),
		),
	),
	MemoizeRpcs.toLayerHandler("simulators.frames", (input) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const service = yield* SimulatorService;
				const controller = new AbortController();
				yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
				return Stream.fromAsyncIterable(
					service.controller.frames(input, input.format, controller.signal),
					(cause) =>
						new SimulatorError({
							reason: errorMessage(cause),
						}),
				);
			}),
		),
	),
);
