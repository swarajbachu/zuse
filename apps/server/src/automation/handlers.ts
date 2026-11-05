import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Redacted } from "effect";
import { connectionWorkspaceActor } from "../lan-auth/services/connection-identity.ts";
import { AutomationService } from "./service.ts";

const SessionAutomationHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("schedule.create", (input) =>
		Effect.gen(function* () {
			const service = yield* AutomationService;
			const actor = yield* connectionWorkspaceActor;
			return yield* service.create(input, actor);
		}),
	),
	MemoizeRpcs.toLayerHandler("schedule.list", ({ sessionId }) =>
		Effect.flatMap(AutomationService, (service) => service.list(sessionId)),
	),
	MemoizeRpcs.toLayerHandler("schedule.update", (input) =>
		Effect.gen(function* () {
			const service = yield* AutomationService;
			const actor = yield* connectionWorkspaceActor;
			return yield* service.update(input, actor);
		}),
	),
	MemoizeRpcs.toLayerHandler("schedule.delete", ({ sessionId, taskId }) =>
		Effect.flatMap(AutomationService, (service) =>
			service.remove(sessionId, taskId),
		),
	),
	MemoizeRpcs.toLayerHandler(
		"schedule.trigger",
		({ sessionId, taskId, eventId }) =>
			Effect.flatMap(AutomationService, (service) =>
				service.trigger(sessionId, taskId, eventId),
			),
	),
	MemoizeRpcs.toLayerHandler("secrets.request", (input) =>
		Effect.flatMap(AutomationService, (service) =>
			service.requestSecret(input),
		),
	),
	MemoizeRpcs.toLayerHandler("secrets.list", ({ sessionId }) =>
		Effect.flatMap(AutomationService, (service) =>
			service.listSecrets(sessionId),
		),
	),
	MemoizeRpcs.toLayerHandler(
		"secrets.respond",
		({ sessionId, requestId, value }) =>
			Effect.flatMap(AutomationService, (service) =>
				service.respondSecret(
					sessionId,
					requestId,
					value === undefined ? undefined : Redacted.value(value),
				),
			),
	),
);

import { automationCapabilities } from "./capabilities.ts";
import { AutomationRegistry } from "./registry-service.ts";
import { AUTOMATION_TEMPLATES } from "./templates.ts";

const ProjectAutomationHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("automation.templates", () =>
		Effect.succeed(AUTOMATION_TEMPLATES),
	),
	MemoizeRpcs.toLayerHandler("automation.capabilities", () =>
		Effect.map(AutomationRegistry, (svc) =>
			automationCapabilities(svc.cloudMachines),
		),
	),
	MemoizeRpcs.toLayerHandler("automation.list", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.list(input.projectId)),
	),
	MemoizeRpcs.toLayerHandler("automation.get", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.get(input.id)),
	),
	MemoizeRpcs.toLayerHandler("automation.save", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.save(input)),
	),
	MemoizeRpcs.toLayerHandler("automation.delete", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.delete(input.id)),
	),
	MemoizeRpcs.toLayerHandler("automation.run", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) =>
			svc.run(input.id, input.requestId),
		),
	),
	MemoizeRpcs.toLayerHandler("automation.runs", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) =>
			svc.runs(input.id, input.limit),
		),
	),
	MemoizeRpcs.toLayerHandler("automation.cancel", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.cancel(input.runId)),
	),
	MemoizeRpcs.toLayerHandler("automation.dispatch", (input) =>
		Effect.flatMap(AutomationRegistry, (svc) => svc.dispatchEvent(input)),
	),
);

export const AutomationHandlersLayer = Layer.mergeAll(
	SessionAutomationHandlersLayer,
	ProjectAutomationHandlersLayer,
);
