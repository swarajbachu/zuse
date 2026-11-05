import {
	type Automation,
	AutomationConfig,
	AutomationError,
	type FolderId,
	type WorkspaceActor,
} from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { automationCapabilities } from "./capabilities.ts";
import {
	AutomationRegistry,
	type AutomationRegistryShape,
} from "./registry-service.ts";
import { AUTOMATION_TEMPLATES } from "./templates.ts";

export interface AutomationAgentSave {
	readonly configJson: string;
	readonly requestId: string;
	readonly id?: string;
	readonly expectedRevision?: number;
}
type Handler = (
	projectId: FolderId,
	input?: AutomationAgentSave,
	actor?: WorkspaceActor,
) => Promise<unknown>;

/** Late binding follows the Zot router: the registry itself owns conversation services. */
export class AutomationAgentRouter extends Context.Service<
	AutomationAgentRouter,
	{
		register: (handler: Handler) => () => void;
		bindAuthorization: (
			authorize: (actor: WorkspaceActor | undefined) => Promise<boolean>,
		) => () => void;
		call: Handler;
	}
>()("zuse/AutomationAgentRouter") {}

export const makeAutomationAgentRouterLayer = (cloud = false) =>
	Layer.sync(AutomationAgentRouter, () => {
		let handler: Handler | undefined;
		let authorize = (actor: WorkspaceActor | undefined): Promise<boolean> =>
			Promise.resolve(!cloud && actor === undefined);
		return {
			bindAuthorization(next: typeof authorize) {
				const previous = authorize;
				authorize = next;
				return () => {
					if (authorize === next) authorize = previous;
				};
			},
			register(next: Handler) {
				handler = next;
				return () => {
					if (handler === next) handler = undefined;
				};
			},

			call: async (projectId, input, actor) => {
				if (!(await authorize(actor)))
					return {
						ok: false,
						error: "Automation administration access is required.",
					};
				return handler
					? handler(projectId, input, actor)
					: { ok: false, error: "Project automation tools are unavailable." };
			},
		};
	});

export const AutomationAgentRouterLive = makeAutomationAgentRouterLayer();

// Webhook credentials stay in private storage; discovery returns definition metadata only.
const publicDefinition = (automation: Automation) => ({
	id: automation.id,
	revision: automation.revision,
	config: automation.config,
	nextRunAt: automation.nextRunAt,
});

export const automationAgentOperation = (
	registry: AutomationRegistryShape,
	projectId: FolderId,
	input?: AutomationAgentSave,
) =>
	Effect.gen(function* () {
		if (!input)
			return {
				projectId,
				definitionSchema: Schema.toJsonSchemaDocument(AutomationConfig),
				capabilities: automationCapabilities(registry.cloudMachines),
				templates: AUTOMATION_TEMPLATES,
				automations: (yield* registry.list(projectId)).map(publicDefinition),
			};
		const raw = yield* Effect.try(() => JSON.parse(input.configJson));
		const config = yield* Schema.decodeUnknownEffect(AutomationConfig)(raw);
		if (config.projectId !== projectId)
			return yield* new AutomationError({
				message: "Automation must belong to the current session's project.",
			});
		if (input.id) {
			const existing = yield* registry.get(input.id);
			if (existing.config.projectId !== projectId)
				return yield* new AutomationError({
					message: "Automation must belong to the current session's project.",
				});
			if (input.expectedRevision === undefined)
				return yield* new AutomationError({
					message:
						"Updating an automation requires its expectedRevision from automation_catalog.",
				});
		}
		const saved = yield* registry.save({
			config,
			id: input.id,
			expectedRevision: input.expectedRevision,
			requestId: `agent:${projectId}:${input.requestId}`,
		});
		return publicDefinition(saved);
	});

export const AutomationAgentToolsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const registry = yield* AutomationRegistry;
		const router = yield* AutomationAgentRouter;
		const runtime = yield* Effect.context<never>();
		const unregister = router.register((projectId, input) =>
			Effect.runPromiseWith(runtime)(
				automationAgentOperation(registry, projectId, input).pipe(
					Effect.map((result) => ({ ok: true, result })),
					Effect.catchCause((cause) =>
						Effect.succeed({ ok: false, error: String(cause) }),
					),
				),
			),
		);
		yield* Effect.addFinalizer(() => Effect.sync(unregister));
	}),
);
