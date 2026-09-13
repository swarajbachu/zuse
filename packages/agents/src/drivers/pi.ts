import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentEvent,
	AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type StartSessionInput,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { normalizeNativeToolName } from "../kernel/native-tool-name.ts";
import { ProviderCheckpointBatcher } from "../kernel/provider-checkpoint-batcher.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { type PiFrame, PiRpcClient, piObject } from "./pi-rpc.ts";

const attempt = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});

const string = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" ? value : 0);
const contentText = (value: unknown) =>
	Array.isArray(value)
		? value
				.map((part) => string(piObject(part).text))
				.filter(Boolean)
				.join("\n")
		: string(value);

export const startPiSession = (
	input: StartSessionInput,
	cwd: string,
	binary: string,
	sessionId: AgentSessionId,
	resumeCursor: string | null = null,
): Effect.Effect<
	ProviderSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();
		const emit = (event: AgentEvent) => {
			Queue.offerUnsafe(events, event);
		};
		const batcher = new ProviderCheckpointBatcher({ emit });
		let active = false;
		let interrupted = false;
		let closed = false;
		let errorDelivered = false;
		let generation = 0;
		let messageId = randomUUID();
		let instructions = input.workspaceInstructions;
		let modelWindow: number | null = null;
		let compactStarted = 0;
		let compactId = AgentItemId.make(randomUUID());
		const blocks = new Map<
			number,
			{ text: string; thinking: boolean; revision: number }
		>();
		const dialogs = new Map<
			string,
			{
				method: string;
				options: string[];
				timer?: ReturnType<typeof setTimeout>;
			}
		>();
		const publishBlock = (index: number, final: boolean) => {
			const block = blocks.get(index);
			if (!block) return;
			const shared = {
				itemId: AgentItemId.make(`${messageId}:${index}`),
				text: block.text,
				checkpoint: { revision: ++block.revision, final },
			};
			batcher.offer(
				block.thinking
					? { _tag: "Thinking", ...shared, redacted: false }
					: { _tag: "AssistantMessage", ...shared },
			);
		};
		const finish = () => {
			for (const index of blocks.keys()) publishBlock(index, true);
			blocks.clear();
			batcher.flush();
		};
		const fail = (error: unknown) => {
			if (closed || errorDelivered) return;
			errorDelivered = true;
			finish();
			active = false;
			emit({
				_tag: "Error",
				providerId: "pi",
				message: error instanceof Error ? error.message : String(error),
			});
		};
		const cancelDialogs = () => {
			for (const [id, dialog] of dialogs) {
				emit({
					_tag: "UserQuestionResolved",
					itemId: AgentItemId.make(id),
					resolution: "cancelled",
				});
				clearTimeout(dialog.timer);
				try {
					rpc.notify({ type: "extension_ui_response", id, cancelled: true });
				} catch {}
			}
			dialogs.clear();
		};
		const compactEvent = (done: boolean, frame: PiFrame) => {
			if (!done) {
				compactStarted = Date.now();
				compactId = AgentItemId.make(randomUUID());
			}
			emit({
				_tag: "ContextCompaction",
				itemId: compactId,
				providerId: "pi",
				startedAt: compactStarted,
				durationMs: done ? Date.now() - compactStarted : 0,
				beforeTokens:
					typeof frame.tokensBefore === "number" ? frame.tokensBefore : null,
				afterTokens:
					typeof frame.estimatedTokensAfter === "number"
						? frame.estimatedTokensAfter
						: null,
				status: done ? "completed" : "in_progress",
			});
		};
		const onEvent = (frame: PiFrame) => {
			switch (frame.type) {
				case "message_start":
					finish();
					messageId = randomUUID();
					break;
				case "message_update": {
					const delta = piObject(frame.assistantMessageEvent);
					const index = number(delta.contentIndex);
					if (delta.type === "text_delta" || delta.type === "thinking_delta") {
						const block = blocks.get(index) ?? {
							text: "",
							thinking: delta.type === "thinking_delta",
							revision: 0,
						};
						block.text += string(delta.delta);
						blocks.set(index, block);
						publishBlock(index, false);
					}
					break;
				}
				case "message_end": {
					const message = piObject(frame.message);
					if (message.role !== "assistant") break;
					if (Array.isArray(message.content))
						message.content.forEach((raw, index) => {
							const part = piObject(raw);
							if (part.type !== "text" && part.type !== "thinking") return;
							const block = blocks.get(index) ?? {
								text: "",
								thinking: part.type === "thinking",
								revision: 0,
							};
							block.text = string(
								part.type === "thinking" ? part.thinking : part.text,
							);
							blocks.set(index, block);
						});
					finish();
					const usage = piObject(message.usage);
					if (message.usage)
						emit({
							_tag: "UsageDelta",
							inputTokens: number(usage.input),
							outputTokens: number(usage.output),
							cacheReadTokens: number(usage.cacheRead),
							cacheCreationTokens: number(usage.cacheWrite),
							model: string(message.model),
						});
					if (message.usage)
						emit({
							_tag: "ContextUsage",
							providerId: "pi",
							usedTokens:
								number(usage.input) +
								number(usage.output) +
								number(usage.cacheRead) +
								number(usage.cacheWrite),
							windowTokens: modelWindow && modelWindow > 0 ? modelWindow : null,
							precision: "estimated",
							source: "pi-message-usage",
						});
					// Settle failures at agent_end, after Pi's retries and tools have stopped.
					break;
				}
				case "tool_execution_start": {
					const args = piObject(frame.args);
					batcher.offer({
						_tag: "ToolUse",
						itemId: AgentItemId.make(string(frame.toolCallId)),
						tool: normalizeNativeToolName(string(frame.toolName)),
						input: {
							...args,
							...(typeof args.path === "string"
								? { file_path: args.path }
								: {}),
							...(typeof args.oldText === "string"
								? { old_string: args.oldText, new_string: args.newText }
								: {}),
						},
					});
					break;
				}
				case "tool_execution_end":
					batcher.offer({
						_tag: "ToolResult",
						itemId: AgentItemId.make(string(frame.toolCallId)),
						output: contentText(piObject(frame.result).content),
						isError: frame.isError === true,
					});
					break;
				case "auto_compaction_start":
					compactEvent(false, frame);
					break;
				case "auto_compaction_end":
					compactEvent(true, piObject(frame.result));
					break;
				case "extension_ui_request": {
					const id = string(frame.id);
					const method = string(frame.method);
					if (!["confirm", "select", "input", "editor"].includes(method)) break;
					const options =
						method === "confirm"
							? ["Yes", "No"]
							: Array.isArray(frame.options)
								? frame.options.filter(
										(v): v is string => typeof v === "string",
									)
								: [];
					const dialog: {
						method: string;
						options: string[];
						timer?: ReturnType<typeof setTimeout>;
					} = { method, options };
					if (typeof frame.timeout === "number")
						dialog.timer = setTimeout(
							() => {
								if (dialogs.delete(id))
									emit({
										_tag: "UserQuestionResolved",
										itemId: AgentItemId.make(id),
										resolution: "timed-out",
									});
							},
							Math.max(0, frame.timeout),
						);
					dialogs.set(id, dialog);
					emit({
						_tag: "UserQuestion",
						itemId: AgentItemId.make(id),
						questions: [
							{
								question: [frame.title, frame.message, frame.prefill]
									.filter((v) => typeof v === "string" && v)
									.join("\n\n"),
								options,
							},
						],
					});
					break;
				}
				case "agent_end": {
					cancelDialogs();
					if (!active) break;
					finish();
					active = false;
					const messages = Array.isArray(frame.messages)
						? frame.messages.map(piObject)
						: [];
					const last = messages.filter((m) => m.role === "assistant").at(-1);
					if (interrupted) emit({ _tag: "Interrupted" });
					else if (
						last?.stopReason === "error" ||
						last?.stopReason === "aborted"
					)
						emit({
							_tag: "Error",
							providerId: "pi",
							message:
								string(last.errorMessage) || "Pi could not complete the turn.",
						});
					else emit({ _tag: "Completed", reason: "ended" });
					break;
				}
			}
		};
		// A native file is the only resume authority; never fall back to --continue.
		if (resumeCursor !== null) {
			yield* attempt(async () => {
				if (!isAbsolute(resumeCursor))
					throw new Error("Pi resume path must be absolute.");

				let buffer = "";
				let headerSeen = false;
				const validateLine = (line: string) => {
					if (!line.trim()) return;
					const entry = piObject(JSON.parse(line));
					if (!headerSeen && entry.type !== "session")
						throw new Error("Invalid Pi session file.");
					headerSeen = true;
				};
				// Validate incrementally so large histories do not get loaded twice in memory.
				for await (const chunk of createReadStream(resumeCursor, {
					encoding: "utf8",
				})) {
					buffer += chunk;
					while (true) {
						const end = buffer.indexOf("\n");
						if (end < 0) break;
						validateLine(buffer.slice(0, end));
						buffer = buffer.slice(end + 1);
					}
					if (buffer.length > 32 * 1024 * 1024)
						throw new Error("Pi session entry exceeds 32 MiB.");
				}
				validateLine(buffer);
				if (!headerSeen) throw new Error("Empty Pi session file.");
			}).pipe(
				Effect.mapError(
					(error) =>
						new AgentSessionStartError({
							providerId: "pi",
							reason: `Cannot resume Pi session ${resumeCursor}: ${error.message}`,
						}),
				),
			);
		}

		const nativeFile =
			resumeCursor ??
			(yield* attempt(async () => {
				const root = resolve(
					process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
					"sessions",
					"zuse",
				);
				await mkdir(root, { recursive: true, mode: 0o700 });
				const file = join(root, `${randomUUID()}.jsonl`);
				// Pi recognizes an empty explicit file and initializes its own native header.
				await writeFile(file, "", { flag: "wx", mode: 0o600 });
				return file;
			}).pipe(
				Effect.mapError(
					(error) =>
						new AgentSessionStartError({
							providerId: "pi",
							reason: error.message,
						}),
				),
			));
		const rpc = new PiRpcClient(
			binary,
			["--mode", "rpc", "--session", nativeFile],
			cwd,
			onEvent,
			(error) => {
				if (!closed) {
					cancelDialogs();
					fail(error);
					void Effect.runPromise(Queue.end(events));
				}
			},
		);
		yield* attempt(async () => {
			const state = await rpc.request("get_state");
			const file = string(state.sessionFile);
			modelWindow =
				typeof piObject(state.model).contextWindow === "number"
					? number(piObject(state.model).contextWindow)
					: null;
			if (!isAbsolute(file) || file !== nativeFile)
				throw new Error(
					"Pi did not open the expected persistent session file.",
				);
			if (input.permissionMode && input.permissionMode !== "default")
				throw new Error(
					"Pi uses native permissions and does not support Zuse permission modes.",
				);
			if (input.model && input.model !== "auto") {
				const slash = input.model.indexOf("/");
				if (slash < 1)
					throw new Error("Choose a Pi model using provider/model-id.");
				const selected = await rpc.request("set_model", {
					provider: input.model.slice(0, slash),
					modelId: input.model.slice(slash + 1),
				});
				modelWindow =
					typeof selected.contextWindow === "number"
						? selected.contextWindow
						: null;
			}
			emit({ _tag: "Started", sessionId, providerId: "pi", mode: "sdk" });
			emit({
				_tag: "SessionCursor",
				cursor: file,
				strategy: "pi-session-file",
			});
		}).pipe(
			Effect.tapError(() => Effect.promise(() => rpc.close())),
			Effect.onInterrupt(() => Effect.promise(() => rpc.close())),
			Effect.mapError(
				(error) =>
					new AgentSessionStartError({
						providerId: "pi",
						reason: error.message,
					}),
			),
		);
		const handle: ProviderSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, refs = [], fileRefs = [], skillRefs = []) =>
				attempt(async () => {
					errorDelivered = false;
					if (closed) throw new Error("Pi session is closed.");
					if (active) throw new Error("Pi already has an active turn.");
					const images = await Promise.all(
						refs.map(async (ref) => {
							const attachment = await Effect.runPromise(
								attachments.read(ref.id),
							);
							if (!attachment)
								throw new Error(`Attachment unavailable: ${ref.originalName}`);
							if (
								![
									"image/png",
									"image/jpeg",
									"image/webp",
									"image/gif",
								].includes(attachment.mimeType)
							)
								throw new Error(
									`Pi does not support attachment type ${attachment.mimeType}. Attach a workspace file reference instead.`,
								);
							return {
								type: "image",
								data: Buffer.from(attachment.bytes).toString("base64"),
								mimeType: attachment.mimeType,
							};
						}),
					);
					active = true;
					interrupted = false;
					const turnGeneration = ++generation;
					if (/^\/compact(?:\s|$)/.test(text.trim())) {
						compactEvent(false, {});
						const result = await rpc.request(
							"compact",
							{ customInstructions: text.trim().slice(8).trim() },
							300_000,
						);
						compactEvent(true, result);
						if (interrupted || generation !== turnGeneration) return;
						active = false;
						emit({ _tag: "Completed", reason: "ended" });
						return;
					}
					const message = prefixFirstPromptWithWorkspaceInstructions(
						instructions,
						[
							text,
							...fileRefs.map(
								(ref) => `Referenced ${ref.kind}: ${ref.absPath}`,
							),
							...skillRefs.map((ref) => `/skill:${ref.name} ${ref.args}`),
						].join("\n"),
					);
					await rpc.request(
						"prompt",
						{ message, ...(images.length ? { images } : {}) },
						null,
					);
					instructions = undefined;
					const state = text.trim().startsWith("/")
						? await rpc.request("get_state")
						: {};
					// Extension commands may complete without invoking the agent loop.
					if (
						active &&
						dialogs.size === 0 &&
						generation === turnGeneration &&
						state.isStreaming === false &&
						state.isCompacting === false
					) {
						finish();
						active = false;
						emit({ _tag: "Completed", reason: "ended" });
					}
				}).pipe(Effect.catch((error) => Effect.sync(() => fail(error)))),
			interrupt: () =>
				attempt(async () => {
					interrupted = true;
					cancelDialogs();
					await rpc.request("clear_queue");
					await rpc.request("abort");
					if (active) {
						finish();
						active = false;
						emit({ _tag: "Interrupted" });
					}
				}).pipe(
					Effect.catch((error) =>
						Effect.promise(async () => {
							fail(error);
							await rpc.close();
						}),
					),
				),
			close: () =>
				Effect.promise(async () => {
					if (closed) return;
					closed = true;
					interrupted = true;
					cancelDialogs();
					finish();
					// Let Pi stop tools in their own process groups before terminating the RPC process.
					try {
						await rpc.request("clear_queue", {}, 1000);
						await rpc.request("abort", {}, 1000);
					} catch {
						/* A crashed process still needs bounded teardown. */
					}
					await rpc.close();
					if (active) {
						active = false;
						emit({ _tag: "Interrupted" });
					}
					batcher.cancel();
					await Effect.runPromise(Queue.end(events));
				}),
			setPermissionMode: (mode) =>
				mode === "default"
					? Effect.void
					: Effect.sync(() =>
							fail(
								new Error(
									"Pi uses native permissions; Zuse permission modes are unsupported.",
								),
							),
						),
			answerQuestion: (itemId, answers) =>
				Effect.sync(() => {
					const dialog = dialogs.get(itemId);
					if (!dialog) return;
					const answer = answers.find((a) => a.questionIndex === 0);
					const index = answer?.selected[0];
					const value =
						index !== undefined ? dialog.options[index] : answer?.other;
					rpc.notify({
						type: "extension_ui_response",
						id: itemId,
						...(value === undefined
							? { cancelled: true }
							: dialog.method === "confirm"
								? { confirmed: index === 0 }
								: { value }),
					});
					clearTimeout(dialog.timer);
					dialogs.delete(itemId);
				}),
		};
		return handle;
	});
