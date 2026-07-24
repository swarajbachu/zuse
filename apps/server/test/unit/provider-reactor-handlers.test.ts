import { AgentTurnId, SessionId } from "@zuse/contracts";
import { TurnAlreadyRunning } from "@zuse/domain/core/decider";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeProviderReactorHandlers,
	type ProviderReactorHandlersOptions,
} from "../../src/conversation/core/provider-reactor-handlers.ts";

describe("provider reactor handlers", () => {
	it("requeues a scheduled successor that was superseded before replay", async () => {
		const dispatched: Array<{
			readonly commandId: string;
			readonly command: { readonly _tag: string };
		}> = [];
		const completed: string[] = [];
		const sessionDomain = {
			dispatch: (input: Parameters<SessionDomainApi["dispatch"]>[0]) => {
				dispatched.push(input);
				return input.command._tag === "SubmitTurn"
					? Effect.fail(new TurnAlreadyRunning({ turnId: "turn-current" }))
					: Effect.succeed({
							commandId: input.commandId,
							streamId: input.streamId,
							streamVersion: 1,
							eventIds: [],
						});
			},
		} as unknown as SessionDomainApi;
		const reactorEffects = {
			isCompleted: () => Effect.succeed(false),
			complete: (effectId: string) =>
				Effect.sync(() => {
					completed.push(effectId);
				}),
		} as ProviderReactorHandlersOptions["reactorEffects"];
		const handlers = makeProviderReactorHandlers({
			reactorEffects,
			getSession: (() =>
				Effect.die("unused")) as ProviderReactorHandlersOptions["getSession"],
			openProviderSession: (() =>
				Effect.die(
					"unused",
				)) as ProviderReactorHandlersOptions["openProviderSession"],
			persistMessage: (() =>
				Effect.die(
					"unused",
				)) as ProviderReactorHandlersOptions["persistMessage"],
			ndjsonAppend: () => Effect.void,
			setStatus: () => Effect.void,
			settleTurnFromReactor: () => Effect.void,
			provider: {} as ProviderReactorHandlersOptions["provider"],
			sessionDomain,
			autoNameChat: () => Effect.void,
		});

		await Effect.runPromise(
			handlers.handleScheduledSuccessor({
				commandId: "reactor:scheduled-successor:event-ready:0",
				streamId: SessionId.make("session-1"),
				correlationId: "correlation-1",
				causationEventId: "event-ready",
				command: {
					_tag: "StartScheduledSuccessor",
					turnId: AgentTurnId.make("turn-scheduled"),
					queueId: "queue-1",
					inputJson:
						'{"text":"preserve me","attachments":[],"fileRefs":[],"skillRefs":[],"annotations":[]}',
				},
			}),
		);

		expect(dispatched.map(({ command }) => command._tag)).toEqual([
			"SubmitTurn",
			"EnqueueTurn",
		]);
		expect(dispatched[1]).toMatchObject({
			commandId: "reactor:scheduled-successor:event-ready:0:requeue",
			command: {
				_tag: "EnqueueTurn",
				queueId: "queue-1",
				inputJson:
					'{"text":"preserve me","attachments":[],"fileRefs":[],"skillRefs":[],"annotations":[]}',
				position: 0,
				ready: true,
			},
		});
		expect(completed).toEqual(["reactor:scheduled-successor:event-ready:0"]);
	});
});
