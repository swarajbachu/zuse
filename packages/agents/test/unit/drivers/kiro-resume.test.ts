import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserSend } from "@zuse/agents/drivers/browser-tools";
import { startKiroSession } from "@zuse/agents/drivers/kiro";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type { TurnScopedProviderEventEnvelope } from "@zuse/agents/kernel/turn-protocol";
import { makeTurnScopedSessionHandle } from "@zuse/agents/kernel/turn-protocol";
import type {
	AgentSessionId,
	AgentTurnId,
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

const input: StartSessionInput = {
	folderId: "kiro-resume-folder" as FolderId,
	providerId: "kiro",
	mode: "sdk",
	model: "",
	permissionMode: "default",
};

const browserSend: BrowserSend = async () => ({
	id: "not-used",
	ok: false,
	error: "not used",
});

const getAssistantText = (
	events: ReadonlyArray<TurnScopedProviderEventEnvelope>,
): ReadonlyArray<string> =>
	events.flatMap((envelope) =>
		envelope.scope === "turn" && envelope.event._tag === "AssistantMessage"
			? [envelope.event.text]
			: [],
	);

describe("Kiro ACP session resume", () => {
	it("does not attach replayed history or load-time idle status to the next turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "zuse-kiro-resume-"));
		const executable = join(root, "kiro-cli");
		const stateDirectory = join(root, "state");
		const cursor = "fake-acp-resumed-session";
		const turnId = "kiro-resumed-turn" as AgentTurnId;
		copyFileSync(fakeProviderFixture, executable);
		chmodSync(executable, 0o755);
		mkdirSync(stateDirectory, { recursive: true });
		writeFileSync(
			join(stateDirectory, `${encodeURIComponent(cursor)}.json`),
			JSON.stringify({
				cwd: root,
				pendingPermission: null,
				pendingQuestion: null,
			}),
		);
		const previousScenario = process.env.ZUSE_FAKE_ACP_SCENARIO;
		const previousStateDirectory = process.env.ZUSE_FAKE_ACP_STATE_DIR;
		process.env.ZUSE_FAKE_ACP_SCENARIO = "resume-replay";
		process.env.ZUSE_FAKE_ACP_STATE_DIR = stateDirectory;

		try {
			const received: TurnScopedProviderEventEnvelope[] = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const resumed = yield* startKiroSession(
						input,
						root,
						executable,
						"kiro-resume-session" as AgentSessionId,
						async () => ({ _tag: "AllowOnce" }),
						() => "approval-required",
						browserSend,
						"node",
						null,
						cursor,
					);
					const scoped = yield* makeTurnScopedSessionHandle(resumed);
					// Deliberately send before starting the consumer: session/load's
					// replay is already queued. Before this fix, the driver's idle
					// marker was queued too and prematurely settled this new turn.
					yield* scoped.send(turnId, "A new prompt after restarting.");
					const eventFiber = yield* Stream.runForEach(scoped.events, (event) =>
						Effect.sync(() => received.push(event)),
					).pipe(Effect.forkChild);
					yield* Effect.promise(() =>
						waitUntil(() =>
							received.some(
								(event) =>
									event.scope === "turn" && event.event._tag === "Completed",
							),
						),
					);
					yield* scoped.close();
					yield* Fiber.join(eventFiber);
				}).pipe(Effect.provide(AttachmentsTest)),
			);

			expect(getAssistantText(received)).toEqual([
				"NEW answer to the post-restart prompt.",
			]);
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
