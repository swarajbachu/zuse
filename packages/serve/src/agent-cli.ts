import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import {
	type AttachmentRef,
	type ChatId,
	ComposerInput,
	type FileRef,
	type LinearIssueRef,
	MemoizeRpcs,
	type MessageId,
	MODELS_BY_PROVIDER,
	type PermissionMode,
	type ProviderId,
	type RuntimeMode,
	type SessionId,
	WIRE_PROTOCOL_VERSION,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect } from "effect";

type RpcClient = Awaited<ReturnType<typeof connect>>["client"];

const GROUPS = new Set([
	"commands",
	"computer",
	"project",
	"model",
	"chat",
	"session",
	"thread",
]);
export const isAgentCliCommand = (argv: ReadonlyArray<string>): boolean =>
	argv[0] !== undefined && GROUPS.has(argv[0]);

export class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

const success = (data: unknown): void => {
	process.stdout.write(
		`${JSON.stringify({ schemaVersion: 1, ok: true, data })}\n`,
	);
};

const failure = (cause: unknown): void => {
	const error =
		cause instanceof CliError
			? cause
			: new CliError(
					"internal_error",
					cause instanceof Error ? cause.message : String(cause),
				);
	process.stdout.write(
		`${JSON.stringify({
			schemaVersion: 1,
			ok: false,
			error: {
				code: error.code,
				message: error.message,
				...(error.details === undefined ? {} : { details: error.details }),
			},
		})}\n`,
	);
	process.exitCode =
		error.code === "invalid_input" ? 2 : error.code === "unauthorized" ? 3 : 1;
};

type Args = {
	readonly positionals: string[];
	readonly flags: Map<string, string[]>;
};
const parse = (argv: ReadonlyArray<string>): Args => {
	const positionals: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i += 1) {
		const value = argv[i];
		if (value === undefined) break;
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const [rawKey, inline] = value.slice(2).split("=", 2);
		if (!rawKey)
			throw new CliError("invalid_input", `Invalid option ${value}.`);
		const next = argv[i + 1];
		let optionValue = inline ?? "true";
		if (inline === undefined && next !== undefined && !next.startsWith("--")) {
			optionValue = next;
			i += 1;
		}
		flags.set(rawKey, [...(flags.get(rawKey) ?? []), optionValue]);
	}
	return { positionals, flags };
};
const one = (args: Args, name: string): string | undefined =>
	args.flags.get(name)?.at(-1);
const many = (args: Args, name: string): string[] => args.flags.get(name) ?? [];
const required = (value: string | undefined, name: string): string => {
	if (!value) throw new CliError("invalid_input", `${name} is required.`);
	return value;
};
const bool = (args: Args, name: string): boolean => one(args, name) === "true";
const readStdin = async (): Promise<string> => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
};
const expandInputJson = async (
	argv: ReadonlyArray<string>,
): Promise<string[]> => {
	const result = [...argv];
	const index = result.findIndex(
		(value) => value === "--input-json" || value.startsWith("--input-json="),
	);
	if (index < 0) return result;
	const inline = result[index]?.split("=", 2)[1];
	const source = inline ?? result[index + 1];
	if (source === undefined)
		throw new CliError(
			"invalid_input",
			"--input-json requires JSON, a file path prefixed with @, or - for stdin.",
		);
	const raw =
		source === "-"
			? await readStdin()
			: source.startsWith("@")
				? await readFile(resolve(source.slice(1)), "utf8")
				: source;
	let input: unknown;
	try {
		input = JSON.parse(raw);
	} catch {
		throw new CliError("invalid_input", "--input-json is not valid JSON.");
	}
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new CliError("invalid_input", "--input-json must contain an object.");
	result.splice(index, inline === undefined ? 2 : 1);
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item === false || item === null || item === undefined) continue;
			result.push(`--${key}`, item === true ? "true" : String(item));
		}
	}
	return result;
};
const promptFor = async (args: Args, message = false): Promise<string> => {
	const direct =
		one(args, message ? "message" : "prompt") ?? one(args, "prompt");
	if (direct !== undefined) return direct;
	const file = one(args, "prompt-file");
	if (file === undefined) return "";
	return file === "-" ? readStdin() : readFile(resolve(file), "utf8");
};

const endpoint = (args: Args, env: NodeJS.ProcessEnv): string => {
	const computer = one(args, "computer") ?? "local";
	if (computer !== "local" && one(args, "ws-url") === undefined) {
		throw new CliError(
			"computer_unavailable",
			"A connected computer requires --ws-url and, when protected, --token.",
			{ computer },
		);
	}
	const raw =
		one(args, "ws-url") ??
		env.ZUSE_WS_URL ??
		`ws://127.0.0.1:${env.ZUSE_PORT ?? "47837"}/rpc`;
	const url = new URL(raw);
	if (url.pathname === "/") url.pathname = "/rpc";
	const token = one(args, "token") ?? env.ZUSE_TOKEN;
	if (token !== undefined) url.searchParams.set("token", token);
	return url.toString();
};

const connect = async (args: Args, env: NodeJS.ProcessEnv) => {
	const layer = wsClientProtocolLayer(endpoint(args, env));
	return makeRpcClientSession(layer, MemoizeRpcs, {
		protocolVersion: WIRE_PROTOCOL_VERSION,
		perform: (client, hello) => client["connect.handshake"](hello),
	});
};
const rpc = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
	Effect.runPromise(effect);

const commandManifest = () => ({
	commands: [
		"computer list",
		"project list",
		"model list",
		"chat list",
		"chat get",
		"chat create",
		"chat rename",
		"chat archive",
		"chat unarchive",
		"chat delete",
		"chat workspace",
		"session list",
		"session get",
		"session create",
		"session read",
		"session send",
		"session fork",
		"session model",
		"session provider",
		"session rename",
		"session archive",
		"session unarchive",
		"session delete",
		"session transcript",
		"session plan",
		"session plan-respond",
		"session answer",
		"session queue-list",
		"session queue-add",
		"session queue-update",
		"session queue-delete",
		"session queue-reorder",
		"session queue-run-next",
		"session queue-flush",
		"session queue-resume",
		"session mode",
		"session interrupt",
		"session resume",
	],
	commonOptions: ["--computer", "--ws-url", "--token", "--project"],
	contextOptions: ["--attach", "--file", "--linear", "--transcript", "--plan"],
	deleteRequires: "--confirm",
	schemaVersion: 1,
});

const resolveProject = async (client: RpcClient, args: Args) => {
	const projects = await rpc(client["workspace.list"]({}));
	const selector = one(args, "project");
	if (!selector) {
		if (projects.length === 1 && projects[0] !== undefined) return projects[0];
		const cwd = resolve(process.cwd());
		const matches = projects.filter(
			(project) =>
				cwd === resolve(project.path) ||
				cwd.startsWith(`${resolve(project.path)}/`),
		);
		if (matches.length === 1 && matches[0] !== undefined) return matches[0];
		throw new CliError(
			"project_required",
			"--project is required when the project cannot be inferred uniquely.",
			{
				candidates: projects.map(({ id, name, path }) => ({ id, name, path })),
			},
		);
	}
	const matches = projects.filter(
		(p) =>
			p.id === selector ||
			p.name === selector ||
			resolve(p.path) === resolve(selector),
	);
	if (matches.length !== 1)
		throw new CliError(
			matches.length ? "ambiguous_selector" : "project_not_found",
			`Project selector matched ${matches.length} projects.`,
			{ candidates: matches },
		);
	const match = matches[0];
	if (match === undefined)
		throw new CliError("project_not_found", "Project not found.");
	return match;
};

const provider = (args: Args): ProviderId => {
	const value = one(args, "provider") ?? "codex";
	if (!(value in MODELS_BY_PROVIDER))
		throw new CliError("invalid_provider", `Unknown provider ${value}.`, {
			providers: Object.keys(MODELS_BY_PROVIDER),
		});
	return value as ProviderId;
};
const model = (args: Args, p: ProviderId): string =>
	one(args, "model") ??
	MODELS_BY_PROVIDER[p].find((m) => m.defaultModel)?.id ??
	MODELS_BY_PROVIDER[p][0]?.id ??
	"default";
const permission = (args: Args): PermissionMode => {
	const raw = one(args, "permission") ?? "default";
	const value = raw === "accept-edits" ? "acceptEdits" : raw;
	if (!["default", "plan", "acceptEdits"].includes(value))
		throw new CliError(
			"invalid_permission_mode",
			`Unknown permission mode ${value}.`,
		);
	return value as PermissionMode;
};
const runtime = (args: Args): RuntimeMode => {
	const value = one(args, "runtime") ?? "approval-required";
	if (
		![
			"approval-required",
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
			"full-access",
		].includes(value)
	)
		throw new CliError(
			"invalid_runtime_mode",
			`Unknown runtime mode ${value}.`,
		);
	return value as RuntimeMode;
};
const asSessionId = (value: string): SessionId => value as SessionId;
const asChatId = (value: string): ChatId => value as ChatId;
const asMessageId = (value: string): MessageId => value as MessageId;

const jsonObject = (value: string | undefined, name: string): unknown => {
	const raw = required(value, name);
	try {
		return JSON.parse(raw);
	} catch {
		throw new CliError("invalid_input", `${name} must be valid JSON.`);
	}
};

const mimeFor = (path: string): string => {
	const ext = path.toLowerCase().split(".").at(-1);
	const mime = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		avif: "image/avif",
	}[ext ?? ""];
	if (!mime)
		throw new CliError(
			"unsupported_attachment",
			`Unsupported image attachment: ${path}.`,
		);
	return mime;
};

const contextFor = async (
	client: RpcClient,
	args: Args,
	sessionId: string,
	project: { id: string; path: string },
) => {
	const attachments: AttachmentRef[] = [];
	const fileRefs: FileRef[] = [];
	for (const inputPath of many(args, "attach")) {
		const absPath = resolve(inputPath);
		const bytes = await readFile(absPath);
		const mimeType = mimeFor(absPath);
		const uploaded = await rpc(
			client["attachments.upload"]({
				sessionId: asSessionId(sessionId),
				bytes,
				mimeType,
				originalName: basename(absPath),
				rootPath: project.path,
			}),
		);
		attachments.push({
			id: uploaded.id,
			mimeType: uploaded.mimeType,
			originalName: basename(absPath),
		});
	}
	for (const inputPath of many(args, "file")) {
		const absPath = resolve(project.path, inputPath);
		const relPath = relative(project.path, absPath);
		if (relPath.startsWith("..") || isAbsolute(relPath))
			throw new CliError(
				"path_outside_project",
				`${inputPath} is outside the selected project.`,
			);
		const info = await stat(absPath).catch(() => null);
		if (!info)
			throw new CliError("file_not_found", `${inputPath} does not exist.`);
		fileRefs.push({
			relPath,
			absPath,
			kind: info.isDirectory() ? "directory" : "file",
		});
	}
	const warnings: unknown[] = [];
	for (const sourceSession of many(args, "transcript")) {
		const source = await rpc(
			client["session.get"]({ sessionId: asSessionId(sourceSession) }),
		);
		if (source.projectId !== project.id)
			throw new CliError(
				"project_session_mismatch",
				"Transcript source must belong to the selected project.",
			);
		const throughMessage = one(args, "through-message");
		const exported = await rpc(
			client["session.exportTranscript"]({
				sessionId: asSessionId(sourceSession),
				...(throughMessage
					? { uptoMessageId: asMessageId(throughMessage) }
					: {}),
			}),
		);
		const saved = await rpc(
			client["context.saveText"]({
				sessionId: asSessionId(sessionId),
				text: exported.markdown,
				ext: "md",
				rootPath: project.path,
			}),
		);
		fileRefs.push({ ...saved, kind: "file" });
	}
	for (const sourceSession of many(args, "plan")) {
		const source = await rpc(
			client["session.get"]({ sessionId: asSessionId(sourceSession) }),
		);
		if (source.projectId !== project.id)
			throw new CliError(
				"project_session_mismatch",
				"Plan source must belong to the selected project.",
			);
		const { plan } = await rpc(
			client["session.latestPlan"]({ sessionId: asSessionId(sourceSession) }),
		);
		if (plan === null)
			throw new CliError(
				"plan_not_found",
				`Session ${sourceSession} has no proposed plan.`,
			);
		const saved = await rpc(
			client["context.saveText"]({
				sessionId: asSessionId(sessionId),
				text: plan,
				ext: "md",
				rootPath: project.path,
			}),
		);
		fileRefs.push({ ...saved, kind: "file" });
	}
	for (const issueSelector of many(args, "linear")) {
		const workspace = one(args, "linear-workspace");
		const result = await rpc(
			client["linear.listIssues"]({
				query: issueSelector,
				...(workspace ? { workspaceIds: [workspace] } : {}),
			}),
		);
		const matches = result.issues.filter(
			(issue) =>
				issue.identifier.toLowerCase() === issueSelector.toLowerCase() ||
				issue.issueId === issueSelector,
		);
		if (matches.length !== 1)
			throw new CliError(
				matches.length ? "ambiguous_linear_issue" : "linear_issue_not_found",
				`Linear selector matched ${matches.length} exact issues.`,
				{ candidates: result.issues },
			);
		const issue = matches[0];
		if (issue === undefined)
			throw new CliError("linear_issue_not_found", "Linear issue not found.");
		const prepared = await rpc(
			client["linear.prepareContext"]({
				sessionId: asSessionId(sessionId),
				issues: [
					{
						workspaceId: issue.workspaceId,
						issueId: issue.issueId,
						identifier: issue.identifier,
					} satisfies LinearIssueRef,
				],
				rootPath: project.path,
			}),
		);
		fileRefs.push(
			...prepared.files.map(({ relPath, absPath }) => ({
				relPath,
				absPath,
				kind: "file" as const,
			})),
		);
		attachments.push(...prepared.attachments);
		warnings.push(...prepared.warnings);
	}
	return { attachments, fileRefs, warnings };
};

const composer = (
	text: string,
	context: Awaited<ReturnType<typeof contextFor>>,
) =>
	new ComposerInput({
		text,
		attachments: context.attachments,
		fileRefs: context.fileRefs,
		skillRefs: [],
		annotations: [],
	});

const execute = async (
	argv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
): Promise<unknown> => {
	const args = parse(argv);
	let [group, action] = args.positionals;
	if (group === "commands") return commandManifest();
	if (group === "thread") {
		group = action === "create" ? "chat" : "session";
	}
	let session: Awaited<ReturnType<typeof connect>>;
	try {
		session = await connect(args, env);
	} catch (cause) {
		if (cause instanceof Error && cause.message.includes("SocketOpenError"))
			throw new CliError(
				"unauthorized",
				"Could not open the Zuse RPC connection. Pass a connected --ws-url and --token, or target a loopback server running with local authentication.",
			);
		throw cause;
	}
	try {
		const client = session.client;
		if (group === "computer" && action === "list") {
			const [current, connected] = await Promise.all([
				rpc(client["connect.describe"]()),
				rpc(client["environments.list"]()),
			]);
			return {
				current,
				computers: connected.environments,
			};
		}
		if (group === "project" && action === "list")
			return { projects: await rpc(client["workspace.list"]({})) };
		if (group === "model" && action === "list") {
			const availability = await rpc(
				client["provider.availability"]({ refresh: bool(args, "refresh") }),
			);
			return {
				providers: Object.entries(MODELS_BY_PROVIDER).map(
					([providerId, models]) => ({
						providerId,
						availability:
							availability.find((item) => item.providerId === providerId) ??
							null,
						models,
					}),
				),
			};
		}
		const project = await resolveProject(client, args);
		if (group === "chat" && action === "list")
			return {
				chats: await rpc(
					client["chat.list"]({
						projectId: project.id,
						includeArchived: bool(args, "include-archived"),
					}),
				),
			};
		if (group === "chat" && action === "get")
			return {
				chat: await rpc(
					client["chat.get"]({
						chatId: asChatId(
							required(one(args, "chat") ?? args.positionals[2], "--chat"),
						),
					}),
				),
			};
		if (group === "chat" && action === "rename")
			return {
				chat: await rpc(
					client["chat.rename"]({
						chatId: asChatId(required(one(args, "chat"), "--chat")),
						title: required(one(args, "title"), "--title"),
					}),
				),
			};
		if (group === "chat" && action === "archive")
			return {
				result: await rpc(
					client["chat.archive"]({
						chatId: asChatId(required(one(args, "chat"), "--chat")),
					}),
				),
			};
		if (group === "chat" && action === "unarchive")
			return {
				result: await rpc(
					client["chat.unarchive"]({
						chatId: asChatId(required(one(args, "chat"), "--chat")),
					}),
				),
			};
		if (group === "chat" && action === "delete") {
			if (!bool(args, "confirm"))
				throw new CliError(
					"confirmation_required",
					"chat delete requires --confirm.",
				);
			const chatId = asChatId(required(one(args, "chat"), "--chat"));
			await rpc(client["chat.delete"]({ chatId }));
			return { chatId, deleted: true };
		}
		if (group === "chat" && action === "workspace") {
			const workspace = required(one(args, "workspace"), "--workspace");
			return {
				chat: await rpc(
					client["chat.setWorktree"]({
						chatId: asChatId(required(one(args, "chat"), "--chat")),
						worktreeId: workspace === "main" ? null : (workspace as WorktreeId),
					}),
				),
			};
		}
		if (group === "session" && action === "list")
			return {
				sessions: (
					await rpc(
						client["session.list"]({
							projectId: project.id,
							includeArchived: bool(args, "include-archived"),
						}),
					)
				).filter((s) => !one(args, "chat") || s.chatId === one(args, "chat")),
			};
		if (group === "session" && action === "get")
			return {
				session: await rpc(
					client["session.get"]({
						sessionId: asSessionId(
							required(
								one(args, "session") ?? args.positionals[2],
								"--session",
							),
						),
					}),
				),
			};
		if (group === "session" && action === "fork") {
			const sourceSessionId = asSessionId(
				required(one(args, "session") ?? args.positionals[2], "--session"),
			);
			const sourceSession = await rpc(
				client["session.get"]({ sessionId: sourceSessionId }),
			);
			if (sourceSession.projectId !== project.id)
				throw new CliError(
					"project_session_mismatch",
					"The source session does not belong to the selected project.",
				);
			const destination = one(args, "destination") ?? "tab";
			if (destination !== "tab" && destination !== "chat")
				throw new CliError(
					"invalid_input",
					"--destination must be tab or chat.",
				);
			if (one(args, "provider") && !one(args, "model"))
				throw new CliError(
					"invalid_input",
					"Forking to another provider requires --model.",
				);
			const workspace = one(args, "workspace");
			let createdWorktree: WorktreeId | null = null;
			let worktreeId: WorktreeId | null | undefined;
			if (destination === "chat") {
				if (workspace === undefined || workspace === "fresh") {
					const created = await rpc(
						client["worktree.create"]({ projectId: project.id }),
					);
					createdWorktree = created.id;
					worktreeId = created.id;
				} else {
					worktreeId = workspace === "main" ? null : (workspace as WorktreeId);
				}
			}
			try {
				return await rpc(
					client["session.fork"]({
						sourceSessionId,
						fromMessageId: asMessageId(
							required(one(args, "message"), "--message"),
						),
						destination,
						...(one(args, "provider") ? { providerId: provider(args) } : {}),
						...(one(args, "model") ? { model: one(args, "model") } : {}),
						...(destination === "chat"
							? { worktreeId: worktreeId ?? null }
							: {}),
						...(one(args, "title") ? { title: one(args, "title") } : {}),
					}),
				);
			} catch (cause) {
				if (createdWorktree !== null)
					await rpc(
						client["worktree.remove"]({ worktreeId: createdWorktree }),
					).catch(() => undefined);
				throw cause;
			}
		}
		if (group === "chat" && action === "create") {
			const p = provider(args);
			const m = model(args, p);
			const prompt = await promptFor(args);
			const initialSessionId = asSessionId(`s_${randomUUID()}`);
			const context = await contextFor(client, args, initialSessionId, project);
			const workspace = one(args, "workspace") ?? "fresh";
			const workspacePolicy =
				workspace === "main"
					? ({ _tag: "main" } as const)
					: workspace === "fresh"
						? ({ _tag: "fresh" } as const)
						: ({
								_tag: "existing",
								worktreeId: workspace as WorktreeId,
							} as const);
			const created = await rpc(
				client["chat.create"]({
					operationId: one(args, "idempotency-key") ?? randomUUID(),
					initialSessionId,
					projectId: project.id,
					providerId: p,
					model: m,
					title: one(args, "title"),
					runtimeMode: runtime(args),
					permissionMode: permission(args),
					workspacePolicy,
					...(prompt || context.attachments.length || context.fileRefs.length
						? { startupInput: composer(prompt, context) }
						: {}),
					background: true,
				}),
			);
			return { ...created, warnings: context.warnings };
		}
		if (group === "session" && action === "create") {
			const p = provider(args);
			const m = model(args, p);
			const prompt = await promptFor(args);
			const requestedSessionId =
				one(args, "idempotency-key") ?? `s_${randomUUID()}`;
			const context = await contextFor(
				client,
				args,
				requestedSessionId,
				project,
			);
			const created = await rpc(
				client["session.create"]({
					sessionId: asSessionId(requestedSessionId),
					chatId: asChatId(required(one(args, "chat"), "--chat")),
					providerId: p,
					model: m,
					title: one(args, "title"),
					runtimeMode: runtime(args),
					permissionMode: permission(args),
				}),
			);
			if (prompt || context.attachments.length || context.fileRefs.length)
				await rpc(
					client["messages.send"]({
						sessionId: created.id,
						input: composer(prompt, context),
					}),
				);
			return { session: created, warnings: context.warnings };
		}
		const selectedSessionId = asSessionId(
			required(one(args, "session") ?? args.positionals[2], "--session"),
		);
		const selectedSession = await rpc(
			client["session.get"]({ sessionId: selectedSessionId }),
		);
		if (selectedSession.projectId !== project.id)
			throw new CliError(
				"project_session_mismatch",
				"The selected session does not belong to the selected project.",
				{
					sessionProjectId: selectedSession.projectId,
					selectedProjectId: project.id,
				},
			);
		if (group === "session" && action === "read") {
			const limitRaw = one(args, "limit");
			const limit = limitRaw === undefined ? undefined : Number(limitRaw);
			if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
				throw new CliError(
					"invalid_input",
					"--limit must be a non-negative integer.",
				);
			const messages = await rpc(
				client["messages.list"]({ sessionId: selectedSessionId }),
			);
			return {
				session: selectedSession,
				messages: limit !== undefined ? messages.slice(-limit) : messages,
			};
		}
		if (group === "session" && action === "transcript")
			return await rpc(
				client["session.exportTranscript"]({
					sessionId: selectedSessionId,
					...(one(args, "through-message")
						? {
								uptoMessageId: asMessageId(
									required(one(args, "through-message"), "--through-message"),
								),
							}
						: {}),
				}),
			);
		if (group === "session" && action === "plan")
			return await rpc(
				client["session.latestPlan"]({ sessionId: selectedSessionId }),
			);
		if (group === "session" && action === "model") {
			await rpc(
				client["session.setModel"]({
					sessionId: selectedSessionId,
					model: required(one(args, "model"), "--model"),
				}),
			);
			return {
				session: await rpc(
					client["session.get"]({ sessionId: selectedSessionId }),
				),
			};
		}
		if (group === "session" && action === "provider") {
			const nextProvider = provider(args);
			await rpc(
				client["session.setProvider"]({
					sessionId: selectedSessionId,
					providerId: nextProvider,
					model: model(args, nextProvider),
				}),
			);
			return {
				session: await rpc(
					client["session.get"]({ sessionId: selectedSessionId }),
				),
			};
		}
		if (group === "session" && action === "rename")
			return {
				session: await rpc(
					client["session.rename"]({
						sessionId: selectedSessionId,
						title: required(one(args, "title"), "--title"),
					}),
				),
			};
		if (group === "session" && action === "archive") {
			await rpc(client["session.archive"]({ sessionId: selectedSessionId }));
			return { sessionId: selectedSessionId, archived: true };
		}
		if (group === "session" && action === "unarchive") {
			await rpc(client["session.unarchive"]({ sessionId: selectedSessionId }));
			return { sessionId: selectedSessionId, archived: false };
		}
		if (group === "session" && action === "delete") {
			if (!bool(args, "confirm"))
				throw new CliError(
					"confirmation_required",
					"session delete requires --confirm.",
				);
			await rpc(client["session.delete"]({ sessionId: selectedSessionId }));
			return { sessionId: selectedSessionId, deleted: true };
		}
		if (group === "session" && action === "send") {
			const context = await contextFor(
				client,
				args,
				selectedSessionId,
				project,
			);
			const text = await promptFor(args, true);
			if (one(args, "permission"))
				await rpc(
					client["session.setPermissionMode"]({
						sessionId: selectedSessionId,
						mode: permission(args),
					}),
				);
			if (one(args, "runtime"))
				await rpc(
					client["session.setRuntimeMode"]({
						sessionId: selectedSessionId,
						runtimeMode: runtime(args),
					}),
				);
			await rpc(
				client["messages.send"]({
					sessionId: selectedSessionId,
					input: composer(text, context),
				}),
			);
			return {
				session: await rpc(
					client["session.get"]({ sessionId: selectedSessionId }),
				),
				warnings: context.warnings,
			};
		}
		if (group === "session" && action === "plan-respond") {
			const outcome = required(one(args, "outcome"), "--outcome");
			if (!["approved", "cancelled", "abandoned"].includes(outcome))
				throw new CliError(
					"invalid_input",
					"--outcome must be approved, cancelled, or abandoned.",
				);
			await rpc(
				client["session.plan.respond"]({
					sessionId: selectedSessionId,
					toolCallId: required(one(args, "tool-call"), "--tool-call"),
					outcome: outcome as "approved" | "cancelled" | "abandoned",
					...(one(args, "feedback") ? { feedback: one(args, "feedback") } : {}),
				}),
			);
			return { sessionId: selectedSessionId, outcome };
		}
		if (group === "session" && action === "answer") {
			const answers = jsonObject(one(args, "answers-json"), "--answers-json");
			if (!Array.isArray(answers))
				throw new CliError(
					"invalid_input",
					"--answers-json must contain an array.",
				);
			await rpc(
				client["session.answerQuestion"]({
					sessionId: selectedSessionId,
					itemId: required(one(args, "item"), "--item"),
					answers: answers as Array<{
						questionIndex: number;
						selected: number[];
						other?: string;
					}>,
				}),
			);
			return { sessionId: selectedSessionId, answered: true };
		}
		if (group === "session" && action === "queue-list")
			return await rpc(
				client["messages.queue.list"]({ sessionId: selectedSessionId }),
			);
		if (
			group === "session" &&
			(action === "queue-add" || action === "queue-update")
		) {
			const context = await contextFor(
				client,
				args,
				selectedSessionId,
				project,
			);
			const input = composer(await promptFor(args, true), context);
			if (action === "queue-add")
				return {
					item: await rpc(
						client["messages.queue.add"]({
							sessionId: selectedSessionId,
							input,
							...(one(args, "queue") ? { queueId: one(args, "queue") } : {}),
							ready: !bool(args, "draft"),
							flush: !bool(args, "no-flush"),
						}),
					),
					warnings: context.warnings,
				};
			return {
				item: await rpc(
					client["messages.queue.update"]({
						sessionId: selectedSessionId,
						queueId: required(one(args, "queue"), "--queue"),
						input,
					}),
				),
				warnings: context.warnings,
			};
		}
		if (group === "session" && action === "queue-delete") {
			const queueId = required(one(args, "queue"), "--queue");
			await rpc(
				client["messages.queue.delete"]({
					sessionId: selectedSessionId,
					queueId,
				}),
			);
			return { sessionId: selectedSessionId, queueId, deleted: true };
		}
		if (group === "session" && action === "queue-reorder")
			return {
				items: await rpc(
					client["messages.queue.reorder"]({
						sessionId: selectedSessionId,
						queueIds: many(args, "queue"),
					}),
				),
			};
		if (group === "session" && action === "queue-run-next") {
			const queueId = required(one(args, "queue"), "--queue");
			await rpc(
				client["messages.queue.runNext"]({
					sessionId: selectedSessionId,
					queueId,
				}),
			);
			return { sessionId: selectedSessionId, queueId, started: true };
		}
		if (group === "session" && action === "queue-flush") {
			await rpc(
				client["messages.queue.flush"]({ sessionId: selectedSessionId }),
			);
			return { sessionId: selectedSessionId, flushed: true };
		}
		if (group === "session" && action === "queue-resume") {
			await rpc(
				client["messages.queue.resume"]({ sessionId: selectedSessionId }),
			);
			return { sessionId: selectedSessionId, resumed: true };
		}
		if (group === "session" && action === "mode") {
			if (!one(args, "permission") && !one(args, "runtime"))
				throw new CliError(
					"invalid_input",
					"session mode requires --permission or --runtime.",
				);
			if (one(args, "permission"))
				await rpc(
					client["session.setPermissionMode"]({
						sessionId: selectedSessionId,
						mode: permission(args),
					}),
				);
			if (one(args, "runtime"))
				await rpc(
					client["session.setRuntimeMode"]({
						sessionId: selectedSessionId,
						runtimeMode: runtime(args),
					}),
				);
			return {
				session: await rpc(
					client["session.get"]({ sessionId: selectedSessionId }),
				),
			};
		}
		if (group === "session" && action === "interrupt") {
			await rpc(client["messages.interrupt"]({ sessionId: selectedSessionId }));
			return { sessionId: selectedSessionId, interrupted: true };
		}
		if (group === "session" && action === "resume")
			return {
				session: await rpc(
					client["session.resume"]({ sessionId: selectedSessionId }),
				),
			};
		throw new CliError(
			"invalid_input",
			`Unknown command: ${args.positionals.join(" ")}.`,
		);
	} finally {
		await session.dispose();
	}
};

export const runAgentCli = async (
	argv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	try {
		success(await execute(await expandInputJson(argv), env));
	} catch (cause) {
		failure(cause);
	}
};

export const __testing = { parse, execute, commandManifest, expandInputJson };
