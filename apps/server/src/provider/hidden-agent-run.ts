import * as os from "node:os";
import type { AppToolset } from "@zuse/agents/mcp-gateway";
import {
	type AgentEvent,
	AgentSessionId,
	AgentTurnId,
	type FolderId,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import {
	Context,
	Data,
	type Duration,
	Effect,
	Layer,
	Result,
	Stream,
} from "effect";

import { ProviderService } from "./services/provider-service.ts";

/**
 * What a hidden run may touch.
 *
 * - `TextOnly` answers from its prompt alone. It runs in an empty scratch
 *   directory under full access so a stray tool call can neither reach the
 *   repo nor raise a permission toast for a session nobody can see.
 * - `ReadOnly` reads `cwd` and calls the given toolsets, nothing else. The
 *   session's `read-only` tool policy denies anything that would prompt.
 */
export type HiddenAgentAccess =
	| { readonly _tag: "TextOnly" }
	| {
			readonly _tag: "ReadOnly";
			readonly cwd: string;
			readonly toolsets: ReadonlyArray<AppToolset>;
	  };

export interface HiddenAgentRunInput {
	/** Prefix for the throwaway session id, for logs: `title`, `review-guide`. */
	readonly label: string;
	readonly folderId: FolderId;
	/** Runs on the caller's chosen provider so it reuses that provider's auth. */
	readonly providerId: ProviderId;
	readonly model: string;
	readonly prompt: string;
	readonly access: HiddenAgentAccess;
	/** Ceiling on the whole run. */
	readonly timeout: Duration.Input;
	/** Ceiling on silence between events; a stuck provider fails this first. */
	readonly idleTimeout?: Duration.Input;
}

export class HiddenAgentRunError extends Data.TaggedError(
	"HiddenAgentRunError",
)<{
	readonly reason: "start" | "closed" | "timeout" | "idle";
	readonly message: string;
}> {}

/** The run's events, ending with the turn's `Completed` or `Interrupted`. */
export type HiddenAgentEvents = Stream.Stream<AgentEvent, HiddenAgentRunError>;

export interface HiddenAgentRunnerShape {
	/**
	 * Start a throwaway session that nobody sees, hand its single turn's
	 * events to `consume`, and close the session however `consume` ends:
	 * success, failure, timeout, or interruption.
	 */
	readonly run: <A, E, R>(
		input: HiddenAgentRunInput,
		consume: (events: HiddenAgentEvents) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | HiddenAgentRunError, R>;
}

export class HiddenAgentRunner extends Context.Service<
	HiddenAgentRunner,
	HiddenAgentRunnerShape
>()("memoize/HiddenAgentRunner") {}

const isTurnEnd = (event: AgentEvent): boolean =>
	event._tag === "Completed" || event._tag === "Interrupted";

/** Keep the head and tail of long text: what matters often sits in either. */
export const limitHeadTail = (text: string, limit: number): string => {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	const half = Math.floor(limit / 2);
	return `${trimmed.slice(0, half).trimEnd()}\n[Content truncated]\n${trimmed.slice(-half).trimStart()}`;
};

export const HiddenAgentRunnerLive = Layer.effect(
	HiddenAgentRunner,
	Effect.gen(function* () {
		const provider = yield* ProviderService;

		const run: HiddenAgentRunnerShape["run"] = (input, consume) =>
			Effect.suspend(() => {
				const sid = AgentSessionId.make(
					`${input.label}-${crypto.randomUUID()}`,
				);
				const turnId = AgentTurnId.make(
					`${input.label}-turn-${crypto.randomUUID()}`,
				);
				const access = input.access;
				const runtimeMode: RuntimeMode =
					access._tag === "ReadOnly" ? "approval-required" : "full-access";
				const start = provider
					.start(
						{
							folderId: input.folderId,
							providerId: input.providerId,
							mode: "sdk",
							sessionId: sid,
							initialPrompt: input.prompt,
							initialTurnId: turnId,
							model: input.model,
							cwdOverride:
								access._tag === "ReadOnly" ? access.cwd : os.tmpdir(),
							permissionMode: "default",
							...(access._tag === "ReadOnly"
								? { toolPolicy: "read-only" as const }
								: {}),
						},
						null,
						() => runtimeMode,
						access._tag === "ReadOnly"
							? { orchestration: null, toolsets: access.toolsets }
							: null,
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new HiddenAgentRunError({
									reason: "start",
									message:
										"reason" in cause && typeof cause.reason === "string"
											? cause.reason
											: cause._tag,
								}),
						),
					);
				const turnEvents = provider.events(sid).pipe(
					Stream.filterMap((envelope) =>
						envelope.scope === "turn" && envelope.turnId === turnId
							? Result.succeed(envelope.event)
							: Result.fail(undefined),
					),
					Stream.takeUntil(isTurnEnd),
					Stream.mapError(
						() =>
							new HiddenAgentRunError({
								reason: "closed",
								message: "The agent session ended unexpectedly.",
							}),
					),
				);
				const events: HiddenAgentEvents =
					input.idleTimeout === undefined
						? turnEvents
						: turnEvents.pipe(
								Stream.timeoutOrElse({
									duration: input.idleTimeout,
									orElse: () =>
										Stream.fail(
											new HiddenAgentRunError({
												reason: "idle",
												message: "The agent stopped responding.",
											}),
										),
								}),
							);
				return start.pipe(
					Effect.andThen(consume(events)),
					// However the run ends, its provider process goes with it. The
					// timeout interrupts this effect, so it closes before the caller
					// sees the failure.
					Effect.ensuring(provider.close(sid).pipe(Effect.ignore)),
					Effect.timeoutOrElse({
						duration: input.timeout,
						orElse: () =>
							Effect.fail(
								new HiddenAgentRunError({
									reason: "timeout",
									message: "The agent took too long.",
								}),
							),
					}),
				);
			});

		return { run } satisfies HiddenAgentRunnerShape;
	}),
);
