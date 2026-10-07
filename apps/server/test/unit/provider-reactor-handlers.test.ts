import {
	AgentSessionNotFoundError,
	AgentTurnId,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import { TurnAlreadyRunning } from "@zuse/domain/core/decider";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	makeProviderReactorHandlers,
	type ProviderReactorHandlersOptions,
} from "../../src/conversation/core/provider-reactor-handlers.ts";

describe("provider reactor handlers", () => {
	const providerTurnInput = {
		commandId: "reactor:provider-turn:event-1:0",
		streamId: SessionId.make("session-1"),
		correlationId: "correlation-1",
		causationEventId: "event-1",
		command: {
			_tag: "SendProviderTurn" as const,
			turnId: "turn-provider-send",
			providerInputJson:
				'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[],"annotations":[]}',
		},
	};

	it.each([
		["grok", "Grok CLI not found on PATH. Install Grok and try again."],
		["claude", "claude-auth-reconnect-required"],
		["grok", "Provider connection timed out before startup."],
	] as const)("pauses failed %s startup instead of replaying it during catch-up", async (providerId, reason) => {
		let state: "missing" | "started" | "completed" = "missing";
		const errors: string[] = [];
		const ensureForTurn = vi.fn(() =>
			Effect.fail(new SessionStartError({ providerId, reason })),
		);
		const send = vi.fn(() =>
			Effect.fail(
				new AgentSessionNotFoundError({
					sessionId: SessionId.make("session-1"),
				}),
			),
		);
		const setStatus = vi.fn(() => Effect.void);
		const releaseUndelivered = vi.fn(() =>
			Effect.sync(() => {
				state = "missing";
			}),
		);
		const handlers = makeProviderReactorHandlers({
			reactorEffects: {
				isCompleted: () => Effect.sync(() => state === "completed"),
				begin: () =>
					Effect.sync(() => {
						if (state === "completed") return "completed" as const;
						if (state === "started") return "already-started" as const;
						state = "started";
						return "started" as const;
					}),
				complete: () =>
					Effect.sync(() => {
						state = "completed";
					}),
				releaseUndelivered,
			} as unknown as ProviderReactorHandlersOptions["reactorEffects"],
			getSession: () => Effect.succeed({ providerId } as never),
			ensureForTurn,
			persistMessage: (_id, content) =>
				Effect.sync(() => {
					if (content._tag === "error") errors.push(content.message);
					return {} as never;
				}),
			ndjsonAppend: () => Effect.void,
			setStatus,
			resolveActiveTurn: () =>
				Effect.succeed(AgentTurnId.make("turn-provider-send")),
			getProviderStartJson: () => Effect.succeed(null),
			settleTurnFromReactor: () =>
				Effect.die(
					"the original request must remain available for explicit retry",
				),
			rememberActiveTurn: () => undefined,
			provider: {
				send,
			} as unknown as ProviderReactorHandlersOptions["provider"],
			sessionDomain: {} as ProviderReactorHandlersOptions["sessionDomain"],
			autoNameChat: () => Effect.void,
		});
		// Periodic catch-up and runtime restarts can encounter the same durable event.
		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await Effect.runPromise(
				handlers.handleProviderTurn(providerTurnInput).pipe(Effect.exit),
			);
			expect(result._tag).toBe(
				attempt === 0 && providerId !== "claude" ? "Failure" : "Success",
			);
		}
		expect(send).toHaveBeenCalledTimes(1);
		expect(ensureForTurn).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([reason]);
		expect(state).toBe("completed");
		expect(releaseUndelivered).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenLastCalledWith(
			SessionId.make("session-1"),
			"error",
		);
	});

	it("does not replay a provider request after a crash leaves a started effect", async () => {
		let effectState: "absent" | "started" | "completed" | "outcome-unknown" =
			"absent";
		let crashBeforeCompletion = true;
		const providerSend = vi.fn(() => Effect.void);
		const persistedErrors: string[] = [];
		const settled: string[] = [];
		const reactorEffects = {
			isCompleted: () =>
				Effect.sync(
					() =>
						effectState === "completed" || effectState === "outcome-unknown",
				),
			begin: () =>
				Effect.sync(() => {
					if (effectState === "absent") {
						effectState = "started";
						return "started" as const;
					}
					if (effectState === "started") return "already-started" as const;
					return effectState;
				}),
			markOutcomeUnknown: () =>
				Effect.sync(() => {
					effectState = "outcome-unknown";
				}),
			releaseUndelivered: () =>
				Effect.sync(() => {
					effectState = "absent";
				}),
			complete: () =>
				Effect.sync(() => {
					if (crashBeforeCompletion) {
						crashBeforeCompletion = false;
						throw new Error("simulated crash after provider send");
					}
					effectState = "completed";
				}),
		} as unknown as ProviderReactorHandlersOptions["reactorEffects"];
		const handlers = makeProviderReactorHandlers({
			reactorEffects,
			getSession: (() =>
				Effect.die("unused")) as ProviderReactorHandlersOptions["getSession"],
			ensureForTurn: (() =>
				Effect.die(
					"unused",
				)) as ProviderReactorHandlersOptions["ensureForTurn"],
			persistMessage: (_sessionId, content) =>
				Effect.sync(() => {
					if (content._tag === "error") persistedErrors.push(content.message);
					return {} as never;
				}),
			ndjsonAppend: () => Effect.void,
			setStatus: () => Effect.void,
			resolveActiveTurn: () =>
				Effect.succeed(AgentTurnId.make("turn-provider-send")),
			getProviderStartJson: () => Effect.succeed(null),
			settleTurnFromReactor: (_sessionId, turnId) =>
				Effect.sync(() => {
					settled.push(turnId);
				}),
			rememberActiveTurn: () => undefined,
			provider: {
				send: providerSend,
			} as unknown as ProviderReactorHandlersOptions["provider"],
			sessionDomain: {} as ProviderReactorHandlersOptions["sessionDomain"],
			autoNameChat: () => Effect.void,
		});
		await expect(
			Effect.runPromise(handlers.handleProviderTurn(providerTurnInput)),
		).rejects.toThrow("simulated crash after provider send");
		await Effect.runPromise(handlers.handleProviderTurn(providerTurnInput));

		expect(providerSend).toHaveBeenCalledTimes(1);
		expect(effectState).toBe("outcome-unknown");
		expect(persistedErrors).toEqual([
			expect.stringContaining("did not send it again"),
		]);
		expect(settled).toEqual(["turn-provider-send"]);
	});

	it("does not restart after a provider send dies with an ambiguous outcome", async () => {
		let effectState: "absent" | "started" | "completed" | "outcome-unknown" =
			"absent";
		let externalDeliveries = 0;
		const ensureForTurn = vi.fn(() => Effect.succeed(true));
		const providerSend = vi.fn(() =>
			Effect.sync(() => {
				externalDeliveries += 1;
			}).pipe(Effect.andThen(Effect.die("transport died after delivery"))),
		);
		const persistedErrors: string[] = [];
		const reactorEffects = {
			isCompleted: () => Effect.succeed(false),
			begin: () =>
				Effect.sync(() => {
					effectState = "started";
					return "started" as const;
				}),
			markOutcomeUnknown: () =>
				Effect.sync(() => {
					effectState = "outcome-unknown";
				}),
			releaseUndelivered: () =>
				Effect.sync(() => {
					effectState = "absent";
				}),
			complete: () =>
				Effect.sync(() => {
					effectState = "completed";
				}),
		} as unknown as ProviderReactorHandlersOptions["reactorEffects"];
		const handlers = makeProviderReactorHandlers({
			reactorEffects,
			getSession: (() =>
				Effect.die("unused")) as ProviderReactorHandlersOptions["getSession"],
			ensureForTurn,
			persistMessage: (_sessionId, content) =>
				Effect.sync(() => {
					if (content._tag === "error") persistedErrors.push(content.message);
					return {} as never;
				}),
			ndjsonAppend: () => Effect.void,
			setStatus: () => Effect.void,
			resolveActiveTurn: () =>
				Effect.succeed(AgentTurnId.make("turn-provider-send")),
			getProviderStartJson: () => Effect.succeed(null),
			settleTurnFromReactor: () => Effect.void,
			rememberActiveTurn: () => undefined,
			provider: {
				send: providerSend,
			} as unknown as ProviderReactorHandlersOptions["provider"],
			sessionDomain: {} as ProviderReactorHandlersOptions["sessionDomain"],
			autoNameChat: () => Effect.void,
		});

		await Effect.runPromise(handlers.handleProviderTurn(providerTurnInput));

		expect(externalDeliveries).toBe(1);
		expect(providerSend).toHaveBeenCalledTimes(1);
		expect(ensureForTurn).not.toHaveBeenCalled();
		expect(effectState).toBe("outcome-unknown");
		expect(persistedErrors).toEqual([
			expect.stringContaining("did not send it again"),
		]);
	});

	it("does not replay a retained provider-start prompt after a crash", async () => {
		let effectState: "absent" | "started" | "completed" | "outcome-unknown" =
			"absent";
		let crashBeforeCompletion = true;
		const ensureForTurn = vi.fn(() => Effect.succeed(true));
		const persistedErrors: string[] = [];
		const reactorEffects = {
			isCompleted: () =>
				Effect.sync(
					() =>
						effectState === "completed" || effectState === "outcome-unknown",
				),
			begin: () =>
				Effect.sync(() => {
					if (effectState === "absent") {
						effectState = "started";
						return "started" as const;
					}
					if (effectState === "started") return "already-started" as const;
					return effectState;
				}),
			markOutcomeUnknown: () =>
				Effect.sync(() => {
					effectState = "outcome-unknown";
				}),
			releaseUndelivered: () => Effect.void,
			complete: () =>
				Effect.sync(() => {
					if (crashBeforeCompletion) {
						crashBeforeCompletion = false;
						throw new Error("simulated crash after provider start");
					}
					effectState = "completed";
				}),
		} as unknown as ProviderReactorHandlersOptions["reactorEffects"];
		const handlers = makeProviderReactorHandlers({
			reactorEffects,
			getSession: () =>
				Effect.succeed({ providerId: "codex", status: "booting" } as never),
			ensureForTurn,
			persistMessage: (_sessionId, content) =>
				Effect.sync(() => {
					if (content._tag === "error") persistedErrors.push(content.message);
					return {} as never;
				}),
			ndjsonAppend: () => Effect.void,
			setStatus: () => Effect.void,
			resolveActiveTurn: () =>
				Effect.succeed(AgentTurnId.make("turn-provider-send")),
			getProviderStartJson: () => Effect.succeed(null),
			settleTurnFromReactor: () => Effect.void,
			rememberActiveTurn: () => undefined,
			provider: {} as ProviderReactorHandlersOptions["provider"],
			sessionDomain: {} as ProviderReactorHandlersOptions["sessionDomain"],
			autoNameChat: () => Effect.void,
		});
		const input = {
			commandId: "reactor:provider-start:event-legacy:0",
			streamId: SessionId.make("session-1"),
			correlationId: "correlation-1",
			causationEventId: "event-legacy",
			command: {
				_tag: "StartProvider" as const,
				providerStartJson: JSON.stringify({
					initialPrompt: "legacy prompt",
					initialTurnId: "turn-provider-send",
					modelOptionsJson: null,
					enableSubagents: false,
					forkFromResume: false,
					background: false,
					postBootStatus: "running",
				}),
			},
		};

		await expect(
			Effect.runPromise(handlers.handleProviderStart(input)),
		).rejects.toThrow("simulated crash after provider start");
		await Effect.runPromise(handlers.handleProviderStart(input));

		expect(ensureForTurn).toHaveBeenCalledTimes(1);
		expect(effectState).toBe("outcome-unknown");
		expect(persistedErrors).toEqual([
			expect.stringContaining("did not send it again"),
		]);
	});

	it.each([
		[false, true],
		[true, true],
		[false, false],
	])("preserves the queued author on recovery (rich=%s, allowed=%s)", async (rich, allowed) => {
		const actor = { subject: "author", membershipId: "original-membership" };
		const inputJson = JSON.stringify({
			text: "preserve me",
			attachments: rich
				? [
						{
							id: "attachment",
							mimeType: "image/png",
							originalName: "image.png",
						},
					]
				: [],
			fileRefs: [],
			skillRefs: [],
			annotations: [],
			actor,
		});
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
		} as unknown as ProviderReactorHandlersOptions["reactorEffects"];
		const handlers = makeProviderReactorHandlers({
			reactorEffects,
			getSession: (() =>
				Effect.die("unused")) as ProviderReactorHandlersOptions["getSession"],
			ensureForTurn: (() =>
				Effect.die(
					"unused",
				)) as ProviderReactorHandlersOptions["ensureForTurn"],
			persistMessage: (() =>
				Effect.die(
					"unused",
				)) as ProviderReactorHandlersOptions["persistMessage"],
			ndjsonAppend: () => Effect.void,
			setStatus: () => Effect.void,
			resolveActiveTurn: () => Effect.succeed(undefined),
			getProviderStartJson: () => Effect.succeed(null),
			settleTurnFromReactor: () => Effect.void,
			rememberActiveTurn: () => undefined,
			provider: {} as ProviderReactorHandlersOptions["provider"],
			sessionDomain,
			autoNameChat: () => Effect.void,
			authorizeQueuedTurn: () => Effect.succeed(allowed),
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
					inputJson,
				},
			}),
		);

		if (!allowed) {
			expect(dispatched).toEqual([
				expect.objectContaining({
					command: expect.objectContaining({
						_tag: "EnqueueTurn",
						inputJson,
						ready: false,
					}),
				}),
			]);
			expect(completed).toEqual(["reactor:scheduled-successor:event-ready:0"]);
			return;
		}
		expect(dispatched.map(({ command }) => command._tag)).toEqual([
			"SubmitTurn",
			"EnqueueTurn",
		]);
		expect(dispatched[0]).toMatchObject({
			command: { contentJson: expect.stringContaining(JSON.stringify(actor)) },
		});
		expect(dispatched[1]).toMatchObject({
			commandId: "reactor:scheduled-successor:event-ready:0:requeue",
			command: {
				_tag: "EnqueueTurn",
				queueId: "queue-1",
				inputJson,
				position: 0,
				ready: true,
			},
		});
		expect(completed).toEqual(["reactor:scheduled-successor:event-ready:0"]);
	});
});
