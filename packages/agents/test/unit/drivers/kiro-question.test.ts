import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserSend } from "@zuse/agents/drivers/browser-tools";
import { startKiroSession } from "@zuse/agents/drivers/kiro";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type { ProviderDriverEvent } from "@zuse/agents/kernel/driver";
import type {
	AgentEvent,
	AgentSessionId,
	FolderId,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

const AttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached");
};

const fakeProviderFixture = fileURLToPath(
	new URL(
		"../../../../../tests/testkit/fixtures/fake-acp-provider.mjs",
		import.meta.url,
	),
);

describe("Kiro ACP user questions", () => {
	it("publishes and answers AskUserQuestion through the shared ACP codec", async () => {
		const root = mkdtempSync(join(tmpdir(), "zuse-kiro-question-"));
		const executable = join(root, "kiro-cli");
		copyFileSync(fakeProviderFixture, executable);
		chmodSync(executable, 0o755);
		const previousScenario = process.env.ZUSE_FAKE_ACP_SCENARIO;
		const previousStateDirectory = process.env.ZUSE_FAKE_ACP_STATE_DIR;
		process.env.ZUSE_FAKE_ACP_SCENARIO = "question";
		process.env.ZUSE_FAKE_ACP_STATE_DIR = join(root, "state");
		const observed: ProviderDriverEvent[] = [];
		try {
			const input: StartSessionInput = {
				folderId: "kiro-question-folder" as FolderId,
				providerId: "kiro",
				mode: "sdk",
				model: "claude-sonnet-4.5",
				permissionMode: "default",
			};
			const browserSend: BrowserSend = async () => ({
				id: "not-used",
				ok: false,
				error: "not used",
			});
			await Effect.runPromise(
				Effect.gen(function* () {
					const handle = yield* startKiroSession(
						input,
						root,
						executable,
						"kiro-question-session" as AgentSessionId,
						async () => ({ _tag: "AllowOnce" }),
						() => "approval-required",
						browserSend,
						"node",
					);
					const eventFiber = yield* Stream.runForEach(handle.events, (event) =>
						Effect.sync(() => observed.push(event)),
					).pipe(Effect.forkChild);

					yield* handle.send("Ask me before continuing.");
					yield* Effect.promise(() =>
						waitUntil(() =>
							observed.some((event) => event._tag === "UserQuestion"),
						),
					);
					const question = observed.find(
						(
							event,
						): event is Extract<
							AgentEvent,
							{ readonly _tag: "UserQuestion" }
						> => event._tag === "UserQuestion",
					);
					if (question === undefined)
						return yield* Effect.die("question missing");
					yield* handle.answerQuestion(question.itemId, [
						{ questionIndex: 0, selected: [0] },
					]);
					yield* Effect.promise(() =>
						waitUntil(() =>
							observed.some(
								(event) =>
									event._tag === "AssistantMessage" &&
									event.text.includes("Question answered."),
							),
						),
					);

					yield* handle.close();
					yield* Fiber.join(eventFiber);
				}).pipe(Effect.provide(AttachmentsTest)),
			);

			expect(
				observed.find((event) => event._tag === "UserQuestion"),
			).toMatchObject({
				questions: [
					{
						question: "How should the pending change be handled?",
						options: ["Keep changes", "Discard changes"],
						multiSelect: false,
					},
				],
			});
		} finally {
			if (previousScenario === undefined) {
				delete process.env.ZUSE_FAKE_ACP_SCENARIO;
			} else {
				process.env.ZUSE_FAKE_ACP_SCENARIO = previousScenario;
			}
			if (previousStateDirectory === undefined) {
				delete process.env.ZUSE_FAKE_ACP_STATE_DIR;
			} else {
				process.env.ZUSE_FAKE_ACP_STATE_DIR = previousStateDirectory;
			}
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
