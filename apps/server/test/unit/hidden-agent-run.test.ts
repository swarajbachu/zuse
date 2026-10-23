import type {
	AgentEvent,
	AgentSessionId,
	FolderId,
	ProviderEventEnvelope,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Exit, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	HiddenAgentRunner,
	HiddenAgentRunnerLive,
	limitHeadTail,
} from "../../src/provider/hidden-agent-run.ts";
import { ProviderService } from "../../src/provider/services/provider-service.ts";

type FakeProvider = {
	readonly starts: Array<{
		input: StartSessionInput;
		tools: unknown;
		mode: string;
	}>;
	readonly closed: Array<AgentSessionId>;
	readonly emit: (event: AgentEvent) => Effect.Effect<void>;
	readonly layer: Layer.Layer<HiddenAgentRunner>;
};

const makeFakeProvider = Effect.gen(function* () {
	const queue = yield* Queue.unbounded<ProviderEventEnvelope>();
	const starts: FakeProvider["starts"] = [];
	const closed: Array<AgentSessionId> = [];
	let turnId: string | undefined;
	const provider = {
		start: (
			input: StartSessionInput,
			_resume: unknown,
			getRuntimeMode: () => string,
			tools: unknown,
		) =>
			Effect.sync(() => {
				starts.push({ input, tools, mode: getRuntimeMode() });
				turnId = input.initialTurnId;
				return { sessionId: input.sessionId };
			}),
		events: () => Stream.fromQueue(queue),
		close: (sessionId: AgentSessionId) =>
			Effect.sync(() => {
				closed.push(sessionId);
			}),
	};
	const emit = (event: AgentEvent) =>
		Queue.offer(queue, {
			scope: "turn",
			turnId: turnId as never,
			event,
		}).pipe(Effect.asVoid);
	const layer = HiddenAgentRunnerLive.pipe(
		Layer.provide(Layer.succeed(ProviderService, provider as never)),
	);
	return { starts, closed, emit, layer } satisfies FakeProvider;
});

const baseInput = {
	label: "test",
	folderId: "folder" as FolderId,
	providerId: "claude" as const,
	model: "model",
	prompt: "prompt",
};

describe("HiddenAgentRunner", () => {
	it("starts read-only runs with the read-only policy and their toolsets, then closes", async () => {
		const fake = await Effect.runPromise(makeFakeProvider);
		const toolset = { definitions: [], call: async () => ({ content: [] }) };
		const collected = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* HiddenAgentRunner;
				return yield* runner.run(
					{
						...baseInput,
						access: { _tag: "ReadOnly", cwd: "/repo", toolsets: [toolset] },
						timeout: "5 seconds",
					},
					(events) =>
						Effect.gen(function* () {
							yield* fake.emit({
								_tag: "AssistantMessage",
								text: "hi",
							} as never);
							yield* fake.emit({ _tag: "Completed", reason: "ended" });
							yield* fake.emit({
								_tag: "AssistantMessage",
								text: "late",
							} as never);
							return yield* Stream.runCollect(events);
						}),
				);
			}).pipe(Effect.provide(fake.layer)),
		);
		expect(collected.map((event) => event._tag)).toEqual([
			"AssistantMessage",
			"Completed",
		]);
		const start = fake.starts[0];
		expect(start?.input.toolPolicy).toBe("read-only");
		expect(start?.input.cwdOverride).toBe("/repo");
		expect(start?.mode).toBe("approval-required");
		expect(start?.tools).toEqual({ orchestration: null, toolsets: [toolset] });
		expect(fake.closed).toEqual([start?.input.sessionId]);
	});

	it("text-only runs never get the repo or tools", async () => {
		const fake = await Effect.runPromise(makeFakeProvider);
		await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* HiddenAgentRunner;
				return yield* runner.run(
					{ ...baseInput, access: { _tag: "TextOnly" }, timeout: "5 seconds" },
					() => Effect.void,
				);
			}).pipe(Effect.provide(fake.layer)),
		);
		const start = fake.starts[0];
		expect(start?.input.toolPolicy).toBeUndefined();
		expect(start?.input.cwdOverride).not.toBe("/repo");
		expect(start?.tools).toBeNull();
		expect(fake.closed).toHaveLength(1);
	});

	it("fails an idle run and still closes its session", async () => {
		const fake = await Effect.runPromise(makeFakeProvider);
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const runner = yield* HiddenAgentRunner;
				return yield* runner.run(
					{
						...baseInput,
						access: { _tag: "TextOnly" },
						timeout: "5 seconds",
						idleTimeout: "20 millis",
					},
					(events) => Stream.runDrain(events),
				);
			}).pipe(Effect.provide(fake.layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(JSON.stringify(exit)).toContain("idle");
		expect(fake.closed).toHaveLength(1);
	});

	it("fails a run past its total timeout and still closes its session", async () => {
		const fake = await Effect.runPromise(makeFakeProvider);
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const runner = yield* HiddenAgentRunner;
				return yield* runner.run(
					{ ...baseInput, access: { _tag: "TextOnly" }, timeout: "20 millis" },
					() => Effect.never,
				);
			}).pipe(Effect.provide(fake.layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(JSON.stringify(exit)).toContain("timeout");
		expect(fake.closed).toHaveLength(1);
	});
});

describe("limitHeadTail", () => {
	it("keeps both ends of long text", () => {
		const limited = limitHeadTail(`start ${"x".repeat(1_000)} end`, 100);
		expect(limited.startsWith("start")).toBe(true);
		expect(limited.endsWith("end")).toBe(true);
		expect(limited).toContain("[Content truncated]");
	});
});
