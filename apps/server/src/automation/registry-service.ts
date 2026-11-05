import type {
	Automation,
	AutomationConfig,
	AutomationDispatchInput,
	AutomationError,
	AutomationRun,
	FolderId,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";
export interface AutomationCompletion {
	runId: string;
	automationId: string;
	eventId: string;
	source: string;
	status: AutomationRun["status"];
	context: Readonly<Record<string, string>>;
	text: string;
}
export interface AutomationRegistryShape {
	/** Whether runs can be started as cloud agents from this runtime. */
	readonly cloudMachines: boolean;
	readonly changes: Stream.Stream<void>;
	pendingSlackNotifications(): Effect.Effect<
		readonly {
			runId: string;
			automationId: string;
			destination: string;
			text: string;
		}[],
		AutomationError
	>;
	ackSlackNotification(
		runId: string,
		destination: string,
	): Effect.Effect<void, AutomationError>;
	processPending(): Effect.Effect<void, AutomationError>;
	completionEvents(): Effect.Effect<
		readonly AutomationCompletion[],
		AutomationError
	>;
	ackCompletion(runId: string): Effect.Effect<void, AutomationError>;
	setWebhook(
		id: string,
		webhook: { url: string; token: string },
	): Effect.Effect<void, AutomationError>;
	list(
		projectId?: FolderId,
	): Effect.Effect<readonly Automation[], AutomationError>;
	get(id: string): Effect.Effect<Automation, AutomationError>;
	save(input: {
		id?: string;
		expectedRevision?: number;
		requestId?: string;
		config: AutomationConfig;
	}): Effect.Effect<Automation, AutomationError>;
	delete(id: string): Effect.Effect<void, AutomationError>;
	run(
		id: string,
		requestId: string,
	): Effect.Effect<AutomationRun, AutomationError>;
	runs(
		id: string,
		limit?: number,
	): Effect.Effect<readonly AutomationRun[], AutomationError>;
	cancel(runId: string): Effect.Effect<AutomationRun, AutomationError>;
	dispatchEvent(
		input: AutomationDispatchInput,
	): Effect.Effect<AutomationRun, AutomationError>;
}
export class AutomationRegistry extends Context.Service<
	AutomationRegistry,
	AutomationRegistryShape
>()("zuse/AutomationRegistry") {}
