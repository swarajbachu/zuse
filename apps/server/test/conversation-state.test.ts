import {
	DEFAULT_RUNTIME_MODE,
	FolderId,
	RuntimeMode,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { ConversationState } from "../src/conversation/core/conversation-state.ts";

const run = <A>(effect: Effect.Effect<A, never, ConversationState>) =>
	Effect.runPromise(effect.pipe(Effect.provide(ConversationState.layer)));

describe("ConversationState", () => {
	test("isolates session caches and uses the runtime default", async () => {
		const first = SessionId.make("session-1");
		const second = SessionId.make("session-2");
		const project = FolderId.make("project-1");
		const runtimeMode = RuntimeMode.make("full-access");

		const result = await run(
			Effect.gen(function* () {
				const state = yield* ConversationState;
				state.setProjectId(first, project);
				state.setRuntimeMode(first, runtimeMode);
				state.rememberActiveTurn(first, "turn-1");
				return {
					firstProject: state.projectId(first),
					secondProject: state.projectId(second),
					firstMode: state.runtimeMode(first),
					secondMode: state.runtimeMode(second),
					firstActive: state.activeTurn(first) !== undefined,
					secondActive: state.activeTurn(second) !== undefined,
				};
			}),
		);

		expect(result).toEqual({
			firstProject: project,
			secondProject: undefined,
			firstMode: runtimeMode,
			secondMode: DEFAULT_RUNTIME_MODE,
			firstActive: true,
			secondActive: false,
		});
	});

	test("releases every cache owned by a deleted session", async () => {
		const sessionId = SessionId.make("session-1");
		const result = await run(
			Effect.gen(function* () {
				const state = yield* ConversationState;
				state.setProjectId(sessionId, FolderId.make("project-1"));
				state.setRuntimeMode(sessionId, RuntimeMode.make("full-access"));
				state.setAgents(sessionId, { agents: {}, enableSubagents: true });
				state.rememberActiveTurn(sessionId, "turn-1");
				state.clearSession(sessionId);
				return {
					project: state.projectId(sessionId),
					mode: state.runtimeMode(sessionId),
					agents: state.agents(sessionId),
					active: state.activeTurn(sessionId) !== undefined,
				};
			}),
		);

		expect(result).toEqual({
			project: undefined,
			mode: DEFAULT_RUNTIME_MODE,
			agents: undefined,
			active: false,
		});
	});
});
