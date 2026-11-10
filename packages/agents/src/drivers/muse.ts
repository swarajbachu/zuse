import {
	type FoldedItem,
	readSessionDurability,
	Session,
	type Turn,
} from "@muse-code/sdk";
import {
	type AgentEvent,
	AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type PermissionKind,
	type PermissionMode,
	type RuntimeMode,
	type StartSessionInput,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Schema, Stream } from "effect";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { normalizeNativeToolName } from "../kernel/native-tool-name.ts";
import {
	decidePermission,
	isSensitivePath,
} from "../kernel/permission-policy.ts";
import { ProviderCheckpointBatcher } from "../kernel/provider-checkpoint-batcher.ts";
import { withProviderStartup } from "../kernel/provider-startup.ts";
import { classifyTool } from "../kernel/tool-classify.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import type { McpGatewayHttpServer } from "../mcp-gateway/index.ts";
import type { RequestPermission } from "./codex.ts";
import { museWorkspaceRoot, openMuseHost } from "./muse-client.ts";

const object = Schema.Record(Schema.String, Schema.Unknown);
const SessionResult = Schema.Struct({
	session: Schema.Struct({
		sessionId: Schema.NonEmptyString,
		permissionState: Schema.optional(
			Schema.Struct({ profileId: Schema.String }),
		),
	}),
});
const Question = Schema.Struct({
	userInputId: Schema.String,
	questions: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			question: Schema.String,
			options: Schema.Array(Schema.Struct({ label: Schema.String })),
			selection: Schema.Struct({ mode: Schema.String }),
		}),
	),
});
type Question = typeof Question.Type;
const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const attempt = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) => new Error(errorMessage(error)),
	});

export const startMuseSession = (
	input: StartSessionInput,
	cwd: string,
	binary: string,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: () => RuntimeMode,
	resumeCursor: string | null = null,
	managedMcp?: McpGatewayHttpServer,
): Effect.Effect<
	ProviderSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	withProviderStartup(function* (startup) {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();
		const emit = (event: AgentEvent) => {
			Queue.offerUnsafe(events, event);
		};
		const batcher = new ProviderCheckpointBatcher({ emit });
		let closed = false;
		let failed = false;
		let retire = () => {};
		let active: Turn | undefined;
		let sending = false;
		let recovery = Promise.resolve();
		let interrupted = false;
		let permissionMode: PermissionMode = input.permissionMode ?? "default";
		let instructions = input.workspaceInstructions;
		const questions = new Map<string, Question>();
		const revisions = new Map<string, number>();
		const toolRevisions = new Map<string, number>();
		const cancelQuestions = () => {
			for (const id of questions.keys())
				emit({
					_tag: "UserQuestionResolved",
					itemId: AgentItemId.make(id),
					resolution: "cancelled",
				});
			questions.clear();
		};
		const fail = (error: unknown) => {
			if (closed || failed) return;
			failed = true;
			batcher.flush();
			cancelQuestions();
			emit({ _tag: "Error", providerId: "muse", message: errorMessage(error) });
			Queue.endUnsafe(events);
			retire();
		};
		const host = yield* attempt(() =>
			startup.acquire(
				() =>
					openMuseHost(binary, cwd, {
						env: input.executionEnv,
						readOnlyTools: input.toolPolicy === "read-only",
						signal: startup.signal,
					}),
				async (host) => {
					await host.close();
				},
			),
		).pipe(
			Effect.mapError(
				(error) =>
					new AgentSessionStartError({
						providerId: "muse",
						reason: error.message,
					}),
			),
		);
		retire = () => {
			void host.close().catch(() => {});
		};
		const connection = host.connection;
		let session: Session | undefined;
		const pending: Array<{ method: string; params?: unknown }> = [];
		const renderItem = (item: FoldedItem) => {
			if (item.kind === "agentMessage" || item.kind === "reasoning") {
				const fields = session?.fold.items;
				const text =
					item.status !== "inProgress"
						? (item.text ?? item.summary?.join("\n") ?? "")
						: item.kind === "agentMessage"
							? (fields?.accumulated(item.itemId) ?? item.text ?? "")
							: [
									...new Set([
										...(item.summary ?? []).map((_, i) => `summary.${i}`),
										...(fields?.accumulatedFields(item.itemId) ?? []).filter(
											(field) => field.startsWith("summary."),
										),
									]),
								]
									.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
									.map(
										(field) =>
											fields?.accumulated(item.itemId, field) ??
											item.summary?.[Number(field.slice(8))] ??
											"",
									)
									.join("\n");
				const revision = (revisions.get(item.itemId) ?? 0) + 1;
				revisions.set(item.itemId, revision);
				const shared = {
					itemId: AgentItemId.make(item.itemId),
					text,
					checkpoint: { revision, final: item.status !== "inProgress" },
				};
				batcher.offer(
					item.kind === "reasoning"
						? { _tag: "Thinking", ...shared, redacted: false }
						: { _tag: "AssistantMessage", ...shared },
				);
			} else if (item.kind !== "userMessage" && item.kind !== "compaction") {
				if ((toolRevisions.get(item.itemId) ?? 0) >= item.revision) return;
				const first = !toolRevisions.has(item.itemId);
				toolRevisions.set(item.itemId, item.revision);
				if (first) {
					let args: Record<string, unknown> = {};
					try {
						args = Schema.decodeUnknownSync(object)(
							JSON.parse(item.args ?? "{}"),
						);
					} catch {}
					batcher.offer({
						_tag: "ToolUse",
						itemId: AgentItemId.make(item.itemId),
						tool: normalizeNativeToolName(
							typeof item.tool === "string"
								? item.tool
								: item.kind === "userShell"
									? "Bash"
									: String(item.kind),
						),
						input: item.commandText
							? { command: item.commandText }
							: {
									...args,
									...(typeof args.path === "string"
										? { file_path: args.path }
										: {}),
									...(item.objective ? { description: item.objective } : {}),
								},
					});
				}
				if (item.status !== "inProgress")
					batcher.offer({
						_tag: "ToolResult",
						itemId: AgentItemId.make(item.itemId),
						output:
							item.visibleOutput ??
							item.result?.text ??
							item.result?.summary ??
							item.finalSummary ??
							item.failureReason ??
							item.fallbackText ??
							"",
						isError: item.status !== "completed",
					});
			}
		};
		const presentQuestion = (raw: unknown) => {
			const question = Schema.decodeUnknownSync(Question)(raw);
			if (questions.has(question.userInputId)) return;
			questions.set(question.userInputId, question);
			emit({
				_tag: "UserQuestion",
				itemId: AgentItemId.make(question.userInputId),
				questions: question.questions.map((q) => ({
					question: q.question,
					options: q.options.map((o) => o.label),
					multiSelect: q.selection.mode === "multiple",
				})),
			});
		};
		const notification = (event: { method: string; params?: unknown }) => {
			if (closed || failed) return;
			if (!session) {
				pending.push(event);
				return;
			}
			try {
				const params = Schema.decodeUnknownSync(object)(event.params ?? {});
				if (params.sessionId !== session.sessionId) return;
				const applied = session.apply(event);
				if (event.method === "session/contextUsage") {
					const usage = Schema.decodeUnknownSync(
						Schema.Struct({
							usedTokens: Schema.Number,
							windowTokens: Schema.optional(Schema.Number),
						}),
					)(params);
					emit({
						_tag: "ContextUsage",
						providerId: "muse",
						usedTokens: usage.usedTokens,
						windowTokens: usage.windowTokens ?? null,
						precision: "exact",
						source: "muse-context-usage",
					});
				}
				if (event.method === "view/gap")
					recovery = applied.io.then(() => {
						if (!closed && !failed) {
							for (const item of session?.fold.items.list() ?? [])
								renderItem(item);
							for (const question of session?.fold.pendingUserInputs() ?? [])
								presentQuestion(question);
						}
					});
				if (
					(applied.fold.kind === "item" &&
						applied.fold.outcome.kind !== "ignoredStaleRevision") ||
					(applied.fold.kind === "itemDelta" &&
						applied.fold.outcome.kind === "appended")
				) {
					const id =
						typeof params.itemId === "string"
							? params.itemId
							: typeof params.item === "object" && params.item !== null
								? Schema.decodeUnknownSync(
										Schema.Struct({ itemId: Schema.String }),
									)(params.item).itemId
								: undefined;
					const item = id ? session.fold.items.get(id) : undefined;
					if (item) renderItem(item);
				}
				if (event.method === "userInput/requested") presentQuestion(params);
				if (
					event.method === "userInput/settled" &&
					params.outcome === "answered" &&
					typeof params.userInputId === "string"
				)
					questions.delete(params.userInputId);
				if (
					event.method === "userInput/settled" &&
					params.outcome !== "answered" &&
					typeof params.userInputId === "string" &&
					questions.delete(params.userInputId)
				)
					emit({
						_tag: "UserQuestionResolved",
						itemId: AgentItemId.make(params.userInputId),
						resolution:
							params.outcome === "timedOut" ? "timed-out" : "cancelled",
					});
			} catch (error) {
				fail(error);
			}
		};
		connection.onNotification(notification);
		connection.onServerRequest(async (request) => {
			if (
				request.method === "approval/request" ||
				request.method === "userInput/request"
			)
				return {};
			throw new Error(`Unsupported Muse request: ${request.method}`);
		});
		connection.onProtocolError((error) => {
			fail(error);
		});
		yield* attempt(async () => {
			const workspaceRoot = await museWorkspaceRoot(cwd);
			if (
				managedMcp &&
				!host.initializeResult.grantedCapabilities.includes("sessionMcp")
			)
				throw new Error("Update Muse Code to enable session MCP tools.");
			const config = managedMcp
				? {
						mcpServers: {
							zuse: {
								transport: "streamableHttp",
								mode: "optional",
								url: managedMcp.url,
								headers: managedMcp.headers,
							},
						},
					}
				: undefined;
			const result = await connection.command(
				resumeCursor ? "session/resume" : "session/start",
				{
					...(resumeCursor
						? { sessionId: resumeCursor, excludeItems: true }
						: {
								workspaceRoot,
								providerId: "meta",
								approvalMode: "promptUnmatched",
								...(input.model && input.model !== "auto"
									? { modelId: input.model }
									: {}),
							}),
					permissionProfile: ":ask-me",
					...(config ? { config } : {}),
				},
			);
			const snapshot = Schema.decodeUnknownSync(SessionResult)(result).session;
			const nativeId = snapshot.sessionId;
			const profile =
				snapshot.permissionState ??
				Schema.decodeUnknownSync(SessionResult)(
					await connection.command("session/read", { sessionId: nativeId }),
				).session.permissionState;
			if (profile?.profileId !== ":ask-me")
				throw new Error(
					"Muse did not apply the requested permission profile. Update Muse Code before continuing.",
				);
			if (resumeCursor && nativeId !== resumeCursor)
				throw new Error("Muse resumed a different session.");
			session = new Session({
				sessionId: nativeId,
				connection,
				durability: readSessionDurability(host.initializeResult),
			});
			session.onGapError((error) => {
				fail(error);
			});
			session.onApprovalError((error) => {
				fail(error);
			});
			session.onApproval(async (approval) => {
				let args: Record<string, unknown> = {};
				try {
					args = Schema.decodeUnknownSync(object)(JSON.parse(approval.rawArgs));
				} catch {}
				const path =
					[args.path, args.file_path, args.filePath].find(
						(v): v is string => typeof v === "string",
					) ?? "";
				const sensitive = approval.protectedWrite || isSensitivePath(path);
				const category = classifyTool(approval.toolName);
				const verdict =
					input.toolPolicy === "read-only" && category !== "read"
						? "deny"
						: decidePermission({
								runtimeMode: getRuntimeMode(),
								permissionMode,
								category,
								sensitive,
							});
				const kind: PermissionKind =
					category === "edit"
						? { _tag: "FileWrite", path }
						: category === "execute"
							? {
									_tag: "Bash",
									command:
										typeof args.command === "string"
											? args.command
											: approval.rawArgs,
								}
							: category === "network"
								? {
										_tag: "Network",
										url:
											typeof args.url === "string"
												? args.url
												: approval.rawArgs,
									}
								: {
										_tag: "Other",
										tool: approval.toolName,
										summary: approval.rawArgs,
									};
				const decision =
					verdict === "prompt"
						? await requestPermission(sessionId, kind, { forcePrompt: true })
						: undefined;
				const allow =
					!closed &&
					!failed &&
					(verdict === "allow" ||
						decision?._tag === "AllowOnce" ||
						decision?._tag === "AllowForSession" ||
						decision?._tag === "AlwaysAllow");
				const choice = approval.availableChoices.find(
					(c) =>
						c.scope === "once" &&
						c.decision === (allow ? "approved" : "denied"),
				);
				if (!choice)
					throw new Error("Muse did not offer a safe approval choice.");
				return { choiceId: choice.choiceId };
			});
			for (const event of pending.splice(0)) notification(event);
			if (resumeCursor) {
				await connection.command("session/setApprovalMode", {
					sessionId: nativeId,
					mode: "promptUnmatched",
				});
				if (input.model && input.model !== "auto")
					await connection.command("session/setModel", {
						sessionId: nativeId,
						modelId: input.model,
						providerId: "meta",
					});
			}
			if (failed) throw new Error("Muse session failed during initialization.");
			emit({ _tag: "Started", sessionId, providerId: "muse", mode: "sdk" });
			emit({
				_tag: "SessionCursor",
				cursor: nativeId,
				strategy: "muse-session-id",
			});
		}).pipe(
			Effect.timeout("30 seconds"),
			Effect.mapError(
				(error) =>
					new AgentSessionStartError({
						providerId: "muse",
						reason: error.message,
					}),
			),
		);
		if (!session)
			return yield* new AgentSessionStartError({
				providerId: "muse",
				reason: "Muse did not open a session.",
			});
		const live = session;
		void host.child.exit.then((exit) => {
			live.hostExited(exit);
			if (!closed)
				fail(new Error("Muse host exited. Reopen the session to resume."));
		});
		void connection.closed.then(() => {
			live.hostExited({ kind: "transportEof" });
			if (!closed)
				fail(
					new Error("Muse connection closed. Reopen the session to resume."),
				);
		});
		const close = async () => {
			if (closed) return;
			closed = true;
			cancelQuestions();
			batcher.cancel();
			await host.close();
			Queue.endUnsafe(events);
		};
		startup.add(close);
		return {
			events: Stream.fromQueue(events),
			send: (text, refs = [], fileRefs = [], skillRefs = []) =>
				attempt(async () => {
					if (closed || failed)
						throw new Error(
							"Muse session is unavailable. Reopen it to resume.",
						);
					if (active || sending)
						throw new Error("Muse already has an active turn.");
					sending = true;
					interrupted = false;
					try {
						const inputParts: Array<
							| { type: "text"; text: string }
							| { type: "image"; base64Data: string; mediaType: string }
						> = [];
						for (const ref of refs) {
							const attachment = await Effect.runPromise(
								attachments.read(ref.id),
							);
							if (
								!attachment ||
								![
									"image/png",
									"image/jpeg",
									"image/webp",
									"image/gif",
								].includes(attachment.mimeType)
							)
								throw new Error(
									`Muse cannot load image attachment: ${ref.originalName}`,
								);
							inputParts.push({
								type: "image",
								base64Data: Buffer.from(attachment.bytes).toString("base64"),
								mediaType: attachment.mimeType,
							});
						}
						inputParts.unshift({
							type: "text",
							text: prefixFirstPromptWithWorkspaceInstructions(
								instructions,
								[
									text,
									...fileRefs.map(
										(ref) => `Referenced ${ref.kind}: ${ref.absPath}`,
									),
									...skillRefs.map((ref) => `/skill:${ref.name} ${ref.args}`),
								].join("\n"),
							),
						});
						const effort = input.modelOptions?.reasoning;
						const allowedEfforts = [
							"none",
							"minimal",
							"low",
							"medium",
							"high",
							"xhigh",
							"max",
							"ultra",
						] as const;
						const reasoningEffort = allowedEfforts.find(
							(value) => value === effort,
						);
						const workspaceRoot = await museWorkspaceRoot(cwd);
						if (interrupted || closed) {
							if (!closed) emit({ _tag: "Interrupted" });
							return;
						}
						let turn: Turn;
						if (/^\/compact\s*$/.test(text.trim())) {
							const commandId = connection.mintCommandId();
							turn = live.turn(commandId);
							const result = await connection.command(
								"session/compact",
								{ sessionId: live.sessionId },
								{ commandId },
							);
							if (result.status === "noop") {
								emit({ _tag: "Completed", reason: "ended" });
								return;
							}
							if (result.status !== "accepted")
								throw new Error("Muse rejected context compaction.");
						} else {
							turn = await live.sendUserTurn({
								input: inputParts,
								displayText: text,
								workspaceRoots: [workspaceRoot],
								...(reasoningEffort ? { reasoningEffort } : {}),
							});
						}
						active = turn;
						if (interrupted && !closed && !failed)
							await connection.command("turn/interrupt", {
								sessionId: live.sessionId,
								turnId: turn.turnId,
							});
						instructions = undefined;
						const outcome = await turn.completed;
						await recovery;
						if (outcome.kind === "completed" && outcome.params.usage) {
							const usage = outcome.params.usage;
							emit({
								_tag: "UsageDelta",
								inputTokens: usage.inputTokens,
								outputTokens: usage.outputTokens,
								cacheReadTokens: usage.cacheReadTokens ?? usage.cachedTokens,
								cacheCreationTokens: usage.cacheWriteTokens ?? 0,
								model: input.model ?? "",
							});
						}
						batcher.flush();
						if (closed || failed) return;
						if (outcome.kind !== "completed")
							throw new Error("Muse turn ended without a completion result.");
						if (outcome.params.terminal === "completed")
							emit({ _tag: "Completed", reason: "ended" });
						else if (
							outcome.params.terminal === "interrupted" ||
							outcome.params.terminal === "cancelled"
						)
							emit({ _tag: "Interrupted" });
						else
							throw new Error(
								outcome.params.error?.message ??
									outcome.params.reason ??
									"Muse could not complete the turn.",
							);
					} finally {
						active = undefined;
						sending = false;
					}
				}).pipe(Effect.catch((error) => Effect.sync(() => fail(error)))),
			interrupt: () =>
				attempt(async () => {
					interrupted = true;
					if (active)
						await connection.command("turn/interrupt", {
							sessionId: live.sessionId,
							turnId: active.turnId,
						});
				}).pipe(Effect.catch((error) => Effect.sync(() => fail(error)))),
			close: () => Effect.promise(close),
			stopBackgroundTask: (taskId) =>
				attempt(async () => {
					await connection.command("task/stop", {
						sessionId: live.sessionId,
						taskId,
					});
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					permissionMode = mode;
				}),
			answerQuestion: (id, answers) =>
				attempt(async () => {
					const prompt = questions.get(id);
					if (!prompt) throw new Error("Muse question is no longer pending.");
					await connection.command("userInput/answer", {
						sessionId: live.sessionId,
						userInputId: id,
						answers: prompt.questions.map((question, index) => {
							const answer = answers.find((a) => a.questionIndex === index);
							if (!answer) throw new Error("Answer every Muse question.");
							const labels = answer.selected.map((i) => {
								const option = question.options[i];
								if (!option) throw new Error("Invalid Muse option.");
								return option.label;
							});
							return {
								questionId: question.id,
								...(answer.other
									? { freeText: answer.other }
									: question.selection.mode === "multiple"
										? { selectedLabels: labels }
										: { selectedLabel: labels[0] }),
							};
						}),
					});
				}),
			cancelQuestion: (id) =>
				attempt(async () => {
					await connection.command("userInput/cancel", {
						sessionId: live.sessionId,
						userInputId: id,
					});
				}),
		} satisfies ProviderSessionHandle;
	});
