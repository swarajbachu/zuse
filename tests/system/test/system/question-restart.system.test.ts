import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClientSession } from "@zuse/client-runtime/connection";
import {
	CommandId,
	type QuestionAttachment,
	type SessionId,
	type SessionInteraction,
} from "@zuse/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import type { SystemRpcClient } from "../../src/rpc-client.ts";
import { withSystemTest } from "../../src/system-scope.ts";

type PendingQuestion = Extract<
	SessionInteraction,
	{ readonly _tag: "Question" }
>;

const waitForPendingQuestion = (
	client: SystemRpcClient,
	sessionId: SessionId,
): Promise<PendingQuestion> =>
	Effect.runPromise(
		client["session.events"]({ sessionId }).pipe(
			Stream.flatMap((frame) => {
				if (frame.kind === "snapshot") {
					return Stream.fromIterable(frame.projection.interactions);
				}
				if (
					frame.kind === "event" &&
					frame.event._tag === "MessagePersisted" &&
					frame.event.message.content._tag === "user_question"
				) {
					return Stream.succeed({
						_tag: "Question" as const,
						id: frame.event.message.content.itemId,
						questions: frame.event.message.content.questions,
						requestedAt: frame.event.message.createdAt,
					});
				}
				return Stream.empty;
			}),
			Stream.filter(
				(interaction): interaction is PendingQuestion =>
					interaction._tag === "Question",
			),
			Stream.runHead,
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(new Error("No pending question observed.")),
					onSome: Effect.succeed,
				}),
			),
			Effect.timeout(10_000),
		),
	);

const readTimelineInteractions = (
	client: SystemRpcClient,
	sessionId: SessionId,
): Promise<ReadonlyArray<SessionInteraction>> =>
	Effect.runPromise(
		client["session.events"]({ sessionId }).pipe(
			Stream.filter((frame) => frame.kind === "snapshot"),
			Stream.map((frame) =>
				frame.kind === "snapshot" ? frame.projection.interactions : [],
			),
			Stream.runHead,
			Effect.map(
				Option.getOrThrowWith(
					() => new Error("Session timeline ended before its snapshot."),
				),
			),
			Effect.timeout(10_000),
		),
	);

const readQuestionAttachments = (
	client: SystemRpcClient,
): Promise<ReadonlyArray<QuestionAttachment>> =>
	Effect.runPromise(
		client["session.questionAttachments"]({}).pipe(
			Stream.filter((change) => change._tag === "snapshot"),
			Stream.map((change) =>
				change._tag === "snapshot" ? change.attachments : [],
			),
			Stream.runHead,
			Effect.map(
				Option.getOrThrowWith(
					() => new Error("Question attachment stream ended before snapshot."),
				),
			),
			Effect.timeout(10_000),
		),
	);

const waitForQuestionAttachment = (
	client: SystemRpcClient,
	sessionId: SessionId,
	itemId: string,
): Promise<QuestionAttachment> =>
	Effect.runPromise(
		client["session.questionAttachments"]({}).pipe(
			Stream.flatMap((change) =>
				change._tag === "snapshot"
					? Stream.fromIterable(change.attachments)
					: change._tag === "change"
						? Stream.succeed(change.attachment)
						: Stream.empty,
			),
			Stream.filter(
				(attachment) =>
					attachment.sessionId === sessionId && attachment.itemId === itemId,
			),
			Stream.runHead,
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.fail(new Error("No live question attachment observed.")),
					onSome: Effect.succeed,
				}),
			),
			Effect.timeout(10_000),
		),
	);

const countQuestionRows = (
	database: DatabaseSync,
	sessionId: SessionId,
	itemId: string,
): { readonly messages: number; readonly events: number } => {
	const messages = database
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM messages
			 WHERE session_id = ?
			   AND kind IN ('user_question', 'user_question_answer')
			   AND json_extract(content_json, '$.itemId') = ?`,
		)
		.get(sessionId, itemId) as { readonly count: number };
	const events = database
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM events AS event
			 INNER JOIN messages AS message
			   ON message.id = json_extract(event.payload_json, '$.messageId')
			 WHERE event.stream_kind = 'session'
			   AND event.stream_id = ?
			   AND event.type = 'MessagePersisted'
			   AND message.kind IN ('user_question', 'user_question_answer')
			   AND json_extract(message.content_json, '$.itemId') = ?`,
		)
		.get(sessionId, itemId) as { readonly count: number };
	return { messages: messages.count, events: events.count };
};

describe("question recovery through production RPC", () => {
	it("removes live callback authority when an in-flight question is interrupted", async () => {
		await withSystemTest("zuse-system-question-interrupt-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "question",
				controlPort: controller.port,
			});
			const session = await scope.rpc(server.endpoint);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			const sessionId = conversation.initialSession.id;
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId,
					commandId: CommandId.make("question-interrupt-send"),
					text: "Ask me a question and wait.",
				}),
			);
			const question = await waitForPendingQuestion(session.client, sessionId);
			await waitForQuestionAttachment(session.client, sessionId, question.id);

			await Effect.runPromise(
				session.client["messages.interrupt"]({
					sessionId,
					commandId: CommandId.make("question-interrupt"),
				}),
			);
			await controller.waitFor("prompt.cancelled");
			await expect
				.poll(() => readQuestionAttachments(session.client))
				.not.toContainEqual({ sessionId, itemId: question.id });
			await expect(
				Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: question.id,
						answers: [{ questionIndex: 0, selected: [0] }],
					}),
				),
			).rejects.toThrow();
		});
	}, 30_000);

	it("removes live callback authority when the provider process exits", async () => {
		await withSystemTest("zuse-system-question-exit-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "question",
				controlPort: controller.port,
			});
			const session = await scope.rpc(server.endpoint);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			const sessionId = conversation.initialSession.id;
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId,
					commandId: CommandId.make("question-provider-exit-send"),
					text: "Ask me a question and wait.",
				}),
			);
			const question = await waitForPendingQuestion(session.client, sessionId);
			await waitForQuestionAttachment(session.client, sessionId, question.id);

			controller.send({ action: "crash", code: 42 });
			await expect
				.poll(() => readQuestionAttachments(session.client))
				.not.toContainEqual({ sessionId, itemId: question.id });
		});
	}, 30_000);

	it("rejects an out-of-range public answer before provider delivery or persistence", async () => {
		await withSystemTest("zuse-system-question-validation-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "question",
				controlPort: controller.port,
			});
			const session = await scope.rpc(server.endpoint);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			const sessionId = conversation.initialSession.id;
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId,
					commandId: CommandId.make("question-validation-send"),
					text: "Ask me a question and wait.",
				}),
			);
			const question = await waitForPendingQuestion(session.client, sessionId);
			await waitForQuestionAttachment(session.client, sessionId, question.id);

			await expect(
				Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: question.id,
						answers: [{ questionIndex: 0, selected: [99] }],
					}),
				),
			).rejects.toThrow();
			expect(controller.events("question.continued")).toEqual([]);
			expect(
				(await readTimelineInteractions(session.client, sessionId)).filter(
					(interaction) => interaction.id === question.id,
				),
			).toHaveLength(1);
			const database = new DatabaseSync(join(server.userData, "zuse.sqlite"));
			try {
				expect(
					database
						.prepare(
							`SELECT COUNT(*) AS count FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
						)
						.get(sessionId, question.id),
				).toEqual({ count: 0 });
				expect(countQuestionRows(database, sessionId, question.id)).toEqual({
					messages: 1,
					events: 1,
				});
			} finally {
				database.close();
			}
		});
	}, 30_000);

	it("automatically redelivers a durable answer when its callback reattaches", async () => {
		await withSystemTest(
			"zuse-system-question-receipt-reissue-",
			async (scope) => {
				const controller = await scope.controller();
				const repository = scope.path("repository");
				initializeSystemRepository(repository);
				let server = await scope.server({
					scenario: "question",
					controlPort: controller.port,
				});
				let session = await scope.rpc(server.endpoint);
				const { conversation } = await createSystemConversation(
					session.client,
					repository,
				);
				const sessionId = conversation.initialSession.id;
				await Effect.runPromise(
					session.client["messages.send"]({
						sessionId,
						commandId: CommandId.make("question-receipt-reissue-send"),
						text: "Ask me a question and wait.",
					}),
				);
				const requested = await controller.waitFor("question.requested");
				const question = await waitForPendingQuestion(
					session.client,
					sessionId,
				);
				await waitForQuestionAttachment(session.client, sessionId, question.id);
				controller.send({ action: "retain-next-question-answer" });
				await controller.waitFor("question.answer-retention-armed");
				await Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: question.id,
						answers: [{ questionIndex: 0, selected: [0] }],
					}),
				);
				await controller.waitFor(
					"question.answer-rejected",
					(event) => event.sessionId === requested.sessionId,
				);
				expect(
					(await readTimelineInteractions(session.client, sessionId)).filter(
						(interaction) => interaction.id === question.id,
					),
				).toEqual([]);

				await session.dispose();
				await server.stop("SIGKILL");
				server = await scope.server({
					scenario: "question-quarantine",
					controlPort: controller.port,
				});
				session = await scope.rpc(server.endpoint);
				const heldBefore = controller.events("question.resume-held").length;
				await Effect.runPromise(
					session.client["session.resume"]({ sessionId }),
				);
				await expect
					.poll(() => controller.events("question.resume-held").length)
					.toBeGreaterThan(heldBefore);
				const resumedBefore = controller.events("question.resumed").length;
				controller.send({ action: "resume-question" });
				await expect
					.poll(() => controller.events("question.resumed").length)
					.toBeGreaterThan(resumedBefore);

				const continued = await controller.waitFor("question.continued");
				expect(continued).toMatchObject({
					outcome: "accepted",
					answers: {
						"How should the pending change be handled?": ["Keep changes"],
					},
				});
				await expect
					.poll(() => readQuestionAttachments(session.client))
					.not.toContainEqual({ sessionId, itemId: question.id });
				const messages = await Effect.runPromise(
					session.client["messages.list"]({ sessionId }),
				);
				expect(
					messages.filter(
						(message) =>
							message.content._tag === "user_question_answer" &&
							message.content.itemId === question.id,
					),
				).toHaveLength(1);
				expect(controller.events("question.continued")).toHaveLength(1);
				const database = new DatabaseSync(join(server.userData, "zuse.sqlite"));
				try {
					expect(
						database
							.prepare(
								`SELECT COUNT(*) AS count FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
							)
							.get(sessionId, question.id),
					).toEqual({ count: 0 });
				} finally {
					database.close();
				}
			},
		);
	}, 60_000);

	it("automatically redelivers a durable cancellation when its callback reattaches", async () => {
		await withSystemTest(
			"zuse-system-question-cancel-reissue-",
			async (scope) => {
				const controller = await scope.controller();
				const repository = scope.path("repository");
				initializeSystemRepository(repository);
				let server = await scope.server({
					scenario: "question",
					controlPort: controller.port,
				});
				let session = await scope.rpc(server.endpoint);
				const { conversation } = await createSystemConversation(
					session.client,
					repository,
				);
				const sessionId = conversation.initialSession.id;
				await Effect.runPromise(
					session.client["messages.send"]({
						sessionId,
						commandId: CommandId.make("question-cancel-reissue-send"),
						text: "Ask me a question and wait.",
					}),
				);
				const requested = await controller.waitFor("question.requested");
				const question = await waitForPendingQuestion(
					session.client,
					sessionId,
				);
				await waitForQuestionAttachment(session.client, sessionId, question.id);
				controller.send({ action: "retain-next-question-answer" });
				await controller.waitFor("question.answer-retention-armed");
				await Effect.runPromise(
					session.client["session.cancelQuestion"]({
						sessionId,
						itemId: question.id,
					}),
				);
				await controller.waitFor(
					"question.answer-rejected",
					(event) => event.sessionId === requested.sessionId,
				);
				expect(
					(await readTimelineInteractions(session.client, sessionId)).filter(
						(interaction) => interaction.id === question.id,
					),
				).toEqual([]);

				await session.dispose();
				await server.stop("SIGKILL");
				server = await scope.server({
					scenario: "question-quarantine",
					controlPort: controller.port,
				});
				session = await scope.rpc(server.endpoint);
				const heldBefore = controller.events("question.resume-held").length;
				await Effect.runPromise(
					session.client["session.resume"]({ sessionId }),
				);
				await expect
					.poll(() => controller.events("question.resume-held").length)
					.toBeGreaterThan(heldBefore);
				const resumedBefore = controller.events("question.resumed").length;
				controller.send({ action: "resume-question" });
				await expect
					.poll(() => controller.events("question.resumed").length)
					.toBeGreaterThan(resumedBefore);

				const continued = await controller.waitFor("question.continued");
				expect(continued).toMatchObject({ outcome: "cancelled" });
				await expect
					.poll(() => readQuestionAttachments(session.client))
					.not.toContainEqual({ sessionId, itemId: question.id });
				const messages = await Effect.runPromise(
					session.client["messages.list"]({ sessionId }),
				);
				expect(
					messages.filter(
						(message) =>
							message.content._tag === "user_question_answer" &&
							message.content.itemId === question.id,
					),
				).toEqual([]);
				expect(controller.events("question.continued")).toHaveLength(1);
				const database = new DatabaseSync(join(server.userData, "zuse.sqlite"));
				try {
					expect(
						database
							.prepare(
								`SELECT COUNT(*) AS count FROM events
							 WHERE stream_kind = 'session' AND stream_id = ?
							   AND type = 'QuestionResolved'
							   AND json_extract(payload_json, '$.itemId') = ?`,
							)
							.get(sessionId, question.id),
					).toEqual({ count: 1 });
					expect(
						database
							.prepare(
								`SELECT COUNT(*) AS count FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
							)
							.get(sessionId, question.id),
					).toEqual({ count: 0 });
				} finally {
					database.close();
				}
			},
		);
	}, 60_000);

	it("recovers a pending cancellation intent across process restart", async () => {
		await withSystemTest(
			"zuse-system-question-cancel-pending-",
			async (scope) => {
				const controller = await scope.controller();
				const repository = scope.path("repository");
				initializeSystemRepository(repository);
				let server = await scope.server({
					scenario: "question",
					controlPort: controller.port,
				});
				let session = await scope.rpc(server.endpoint);
				const { conversation } = await createSystemConversation(
					session.client,
					repository,
				);
				const sessionId = conversation.initialSession.id;
				await Effect.runPromise(
					session.client["messages.send"]({
						sessionId,
						commandId: CommandId.make("question-cancel-pending-send"),
						text: "Ask me a question and wait.",
					}),
				);
				const requested = await controller.waitFor("question.requested");
				const question = await waitForPendingQuestion(
					session.client,
					sessionId,
				);
				await waitForQuestionAttachment(session.client, sessionId, question.id);
				const faultDatabase = new DatabaseSync(
					join(server.userData, "zuse.sqlite"),
				);
				try {
					faultDatabase.exec(`
					CREATE TRIGGER fail_question_cancel_receipt
					BEFORE INSERT ON events
					WHEN NEW.type = 'QuestionResolved'
					BEGIN
						SELECT RAISE(FAIL, 'injected question cancellation receipt failure');
					END
				`);
				} finally {
					faultDatabase.close();
				}
				controller.send({ action: "retain-next-question-answer" });
				await controller.waitFor("question.answer-retention-armed");
				await expect(
					Effect.runPromise(
						session.client["session.cancelQuestion"]({
							sessionId,
							itemId: question.id,
						}),
					),
				).rejects.toThrow();
				await controller.waitFor(
					"question.answer-rejected",
					(event) => event.sessionId === requested.sessionId,
				);
				const pendingDatabase = new DatabaseSync(
					join(server.userData, "zuse.sqlite"),
				);
				try {
					expect(
						pendingDatabase
							.prepare(
								`SELECT action, answers_json FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
							)
							.all(sessionId, question.id),
					).toEqual([{ action: "cancel", answers_json: null }]);
					expect(
						pendingDatabase
							.prepare(
								`SELECT COUNT(*) AS count FROM events
							 WHERE stream_kind = 'session' AND stream_id = ?
							   AND type = 'QuestionResolved'`,
							)
							.get(sessionId),
					).toEqual({ count: 0 });
					pendingDatabase.exec("DROP TRIGGER fail_question_cancel_receipt");
				} finally {
					pendingDatabase.close();
				}
				expect(
					(await readTimelineInteractions(session.client, sessionId)).filter(
						(interaction) => interaction.id === question.id,
					),
				).toHaveLength(1);

				await session.dispose();
				await server.stop("SIGKILL");
				server = await scope.server({
					scenario: "question-quarantine",
					controlPort: controller.port,
				});
				session = await scope.rpc(server.endpoint);
				const heldBefore = controller.events("question.resume-held").length;
				await Effect.runPromise(
					session.client["session.resume"]({ sessionId }),
				);
				await expect
					.poll(() => controller.events("question.resume-held").length)
					.toBeGreaterThan(heldBefore);
				const resumedBefore = controller.events("question.resumed").length;
				controller.send({ action: "resume-question" });
				await expect
					.poll(() => controller.events("question.resumed").length)
					.toBeGreaterThan(resumedBefore);
				await waitForQuestionAttachment(session.client, sessionId, question.id);
				await Effect.runPromise(
					session.client["session.cancelQuestion"]({
						sessionId,
						itemId: question.id,
					}),
				);
				const continued = await controller.waitFor("question.continued");
				expect(continued).toMatchObject({ outcome: "cancelled" });
				expect(
					(await readTimelineInteractions(session.client, sessionId)).filter(
						(interaction) => interaction.id === question.id,
					),
				).toEqual([]);
				const database = new DatabaseSync(join(server.userData, "zuse.sqlite"));
				try {
					expect(
						database
							.prepare(
								`SELECT COUNT(*) AS count FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
							)
							.get(sessionId, question.id),
					).toEqual({ count: 0 });
					expect(
						database
							.prepare(
								`SELECT COUNT(*) AS count FROM events
							 WHERE stream_kind = 'session' AND stream_id = ?
							   AND type = 'QuestionResolved'`,
							)
							.get(sessionId),
					).toEqual({ count: 1 });
				} finally {
					database.close();
				}
			},
		);
	}, 60_000);

	it("reconstructs a live question after process death and deduplicates a lost-ack retry", async () => {
		await withSystemTest("zuse-system-question-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			let server = await scope.server({
				scenario: "question",
				controlPort: controller.port,
			});
			let session: ClientSession<SystemRpcClient> = await scope.rpc(
				server.endpoint,
			);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			const sessionId = conversation.initialSession.id;

			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId,
					commandId: CommandId.make("question-restart-send"),
					text: "Ask me how to handle the pending change.",
				}),
			);
			const requested = await controller.waitFor("question.requested");
			const beforeRestart = await waitForPendingQuestion(
				session.client,
				sessionId,
			);
			expect(beforeRestart.id).toBe(requested.toolCallId);
			expect(beforeRestart.questions).toEqual([
				{
					question: "How should the pending change be handled?",
					options: ["Keep changes", "Discard changes"],
					multiSelect: false,
				},
			]);

			await session.dispose();
			await server.stop("SIGKILL");
			server = await scope.server({
				scenario: "question-quarantine",
				controlPort: controller.port,
			});
			let droppedSession = await scope.droppableRpc(server.endpoint);
			session = droppedSession;

			const reconstructed = await waitForPendingQuestion(
				session.client,
				sessionId,
			);
			await controller.waitFor(
				"question.resume-held",
				(event) => event.sessionId === requested.sessionId,
			);
			expect(reconstructed.id).toBe(beforeRestart.id);
			expect(await readQuestionAttachments(session.client)).not.toContainEqual({
				sessionId,
				itemId: beforeRestart.id,
			});
			await expect(
				Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: beforeRestart.id,
						answers: [{ questionIndex: 0, selected: [0] }],
					}),
				),
			).rejects.toThrow();
			expect(
				(await readTimelineInteractions(session.client, sessionId)).filter(
					(interaction) => interaction.id === beforeRestart.id,
				),
			).toEqual([reconstructed]);
			const quarantinedDatabase = new DatabaseSync(
				join(server.userData, "zuse.sqlite"),
			);
			try {
				expect(
					countQuestionRows(quarantinedDatabase, sessionId, beforeRestart.id),
				).toEqual({ messages: 1, events: 1 });
			} finally {
				quarantinedDatabase.close();
			}

			await Effect.runPromise(session.client["session.resume"]({ sessionId }));
			controller.send({ action: "resume-question" });
			await controller.waitFor(
				"question.resumed",
				(event) => event.toolCallId === beforeRestart.id,
			);
			await waitForQuestionAttachment(
				session.client,
				sessionId,
				beforeRestart.id,
			);
			const replayed = await waitForPendingQuestion(session.client, sessionId);
			expect(replayed.id).toBe(beforeRestart.id);

			// Commit durable intent, then fail the post-provider durable receipt.
			// The fake provider deliberately retains the same blocking callback so a
			// replacement process can reattach it after the server is killed.
			const faultDatabase = new DatabaseSync(
				join(server.userData, "zuse.sqlite"),
			);
			try {
				faultDatabase.exec(`
					CREATE TRIGGER fail_question_answer_receipt
					BEFORE INSERT ON messages
					WHEN NEW.kind = 'user_question_answer'
					BEGIN
						SELECT RAISE(FAIL, 'injected question answer receipt failure');
					END
				`);
			} finally {
				faultDatabase.close();
			}
			controller.send({ action: "retain-next-question-answer" });
			await controller.waitFor("question.answer-retention-armed");
			await expect(
				Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: beforeRestart.id,
						answers: [{ questionIndex: 0, selected: [0] }],
					}),
				),
			).rejects.toThrow();
			await controller.waitFor(
				"question.answer-rejected",
				(event) => event.sessionId === requested.sessionId,
			);
			const pendingDatabase = new DatabaseSync(
				join(server.userData, "zuse.sqlite"),
			);
			try {
				expect(
					pendingDatabase
						.prepare(
							`SELECT answers_json
							 FROM question_answer_deliveries
							 WHERE session_id = ? AND item_id = ?`,
						)
						.all(sessionId, beforeRestart.id),
				).toEqual([
					{
						answers_json: JSON.stringify([{ questionIndex: 0, selected: [0] }]),
					},
				]);
				expect(
					countQuestionRows(pendingDatabase, sessionId, beforeRestart.id),
				).toEqual({ messages: 1, events: 1 });
				pendingDatabase.exec("DROP TRIGGER fail_question_answer_receipt");
			} finally {
				pendingDatabase.close();
			}

			const heldBeforeRecovery = controller.events(
				"question.resume-held",
			).length;
			await droppedSession.dispose();
			await server.stop("SIGKILL");
			server = await scope.server({
				scenario: "question-quarantine",
				controlPort: controller.port,
			});
			droppedSession = await scope.droppableRpc(server.endpoint);
			session = droppedSession;
			await Effect.runPromise(session.client["session.resume"]({ sessionId }));
			await expect
				.poll(() => controller.events("question.resume-held").length)
				.toBeGreaterThan(heldBeforeRecovery);
			expect(await readQuestionAttachments(session.client)).not.toContainEqual({
				sessionId,
				itemId: beforeRestart.id,
			});
			const restartDatabase = new DatabaseSync(
				join(server.userData, "zuse.sqlite"),
			);
			try {
				expect(
					countQuestionRows(restartDatabase, sessionId, beforeRestart.id),
				).toEqual({ messages: 1, events: 1 });
			} finally {
				restartDatabase.close();
			}
			const resumedBeforeRecovery =
				controller.events("question.resumed").length;
			controller.send({ action: "resume-question" });
			await expect
				.poll(() => controller.events("question.resumed").length)
				.toBeGreaterThan(resumedBeforeRecovery);
			await waitForQuestionAttachment(
				session.client,
				sessionId,
				beforeRestart.id,
			);
			expect(
				(await readTimelineInteractions(session.client, sessionId)).filter(
					(interaction) => interaction.id === beforeRestart.id,
				),
			).toHaveLength(1);

			droppedSession.pauseIncoming();
			const firstAnswerOutcome = Effect.runPromise(
				droppedSession.client["session.answerQuestion"]({
					commandId: CommandId.make(crypto.randomUUID()),
					sessionId,
					itemId: beforeRestart.id,
					answers: [{ questionIndex: 0, selected: [0] }],
				}),
			).then(
				() => "acknowledged" as const,
				() => "connection-lost" as const,
			);
			const continued = await controller.waitFor("question.continued");
			expect(continued).toMatchObject({
				outcome: "accepted",
				answers: {
					"How should the pending change be handled?": ["Keep changes"],
				},
			});
			droppedSession.drop();
			expect(await firstAnswerOutcome).toBe("connection-lost");
			await droppedSession.dispose();

			session = await scope.rpc(server.endpoint);
			await expect(
				Effect.runPromise(
					session.client["session.answerQuestion"]({
						commandId: CommandId.make(crypto.randomUUID()),
						sessionId,
						itemId: beforeRestart.id,
						answers: [{ questionIndex: 0, selected: [0] }],
					}),
				),
			).resolves.toBeUndefined();
			expect(
				(await readTimelineInteractions(session.client, sessionId)).filter(
					(interaction) => interaction.id === beforeRestart.id,
				),
			).toEqual([]);
			expect(controller.events("question.continued")).toHaveLength(1);

			const messages = await Effect.runPromise(
				session.client["messages.list"]({ sessionId }),
			);
			expect(
				messages.filter(
					(message) =>
						message.content._tag === "user_question" &&
						message.content.itemId === beforeRestart.id,
				),
			).toHaveLength(1);
			expect(
				messages.filter(
					(message) =>
						message.content._tag === "user_question_answer" &&
						message.content.itemId === beforeRestart.id,
				),
			).toHaveLength(1);

			const database = new DatabaseSync(join(server.userData, "zuse.sqlite"));
			try {
				expect(
					countQuestionRows(database, sessionId, beforeRestart.id),
				).toEqual({
					messages: 2,
					events: 2,
				});
				expect(
					database
						.prepare(
							`SELECT COUNT(*) AS count
								 FROM question_answer_deliveries
								 WHERE session_id = ? AND item_id = ?`,
						)
						.get(sessionId, beforeRestart.id),
				).toEqual({ count: 0 });
			} finally {
				database.close();
			}
		});
	}, 60_000);
});
