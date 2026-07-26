import {
	type AgentAvailability,
	type AttachmentRef,
	type Chat,
	type ChatId,
	CommandId,
	ComposerInput,
	type ComposerInput as ComposerInputType,
	type FileRef,
	type Folder,
	type FolderId,
	type FsFileContent,
	type GitBranchInfo,
	type GitChange,
	type GitPrInfo,
	type GitPrSummary,
	type GitResetRemotePreview,
	type GitReviewFileContents,
	type GitReviewPatch,
	type GitReviewScope,
	type GitReviewSummary,
	type GitStatusSummary,
	type MessageId,
	type PermissionDecision,
	type PermissionMode,
	type PlanApprovalOutcome,
	type ProviderId,
	type PtyId,
	type RuntimeMode,
	type Session,
	type SessionId,
	type Skill,
	type SkillRef,
	type Worktree,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";

import { reviewScopeRequestValue } from "~/lib/review-scope";
import {
	dispatchMobileSessionCommand,
	sessionCommandContext,
} from "~/store/mobile-client-bus";
import { getConnectionClient, reportConnectionFailure } from "./connection";
import type { WsProtocolOptions } from "./ws-protocol";

let commandCounter = 0;
const nextCommandId = (kind: string): CommandId =>
	CommandId.make(
		`${kind}:${Date.now().toString(36)}:${(commandCounter++).toString(36)}`,
	);

const dispatchSessionCommand = <Result>(
	options: { connection: WsProtocolOptions; sessionId: SessionId },
	kind: string,
	payload: unknown,
	commandId: CommandId,
) => {
	const connKey =
		options.connection.key ??
		options.connection.environmentId ??
		options.connection.wsBaseUrl ??
		`${options.connection.host}:${options.connection.port}`;
	const { environmentId, resource } = sessionCommandContext(
		connKey,
		options.connection,
		options.sessionId,
	);
	return Effect.tryPromise({
		try: () =>
			dispatchMobileSessionCommand<Result>({
				kind,
				commandId,
				environmentId,
				resource,
				payload,
				retry: "safe",
				createdAt: Date.now(),
			}).then((receipt) => receipt.result),
		catch: (cause) => cause,
	});
};

export const makeTextInput = (
	text: string,
	attachments: readonly AttachmentRef[] = [],
	asGoal?: boolean,
	fileRefs: readonly FileRef[] = [],
	skillRefs: readonly SkillRef[] = [],
): ComposerInputType =>
	ComposerInput.make({
		text,
		attachments: [...attachments],
		fileRefs: [...fileRefs],
		skillRefs: [...skillRefs],
		annotations: [],
		...(asGoal === undefined ? {} : { asGoal }),
	});

export const uploadAttachment = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	bytes: Uint8Array;
	mimeType: string;
	originalName: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		const result = yield* client["attachments.upload"]({
			sessionId: options.sessionId,
			bytes: options.bytes,
			mimeType: options.mimeType,
			originalName: options.originalName,
		});
		return {
			id: result.id,
			mimeType: result.mimeType,
			originalName: options.originalName,
		} satisfies AttachmentRef;
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const searchWorkspaceFiles = (options: {
	connection: WsProtocolOptions;
	projectId: FolderId;
	query: string;
	worktreeId?: WorktreeId | null;
	limit?: number;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["workspace.searchFiles"]({
			projectId: options.projectId,
			query: options.query,
			worktreeId: options.worktreeId,
			limit: options.limit ?? 20,
		});
	});

export const listSessionSkills = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}): Effect.Effect<readonly Skill[], unknown> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["skill.list"]({ sessionId: options.sessionId });
	});

export const readAttachment = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	id: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["attachments.read"]({
			sessionId: options.sessionId,
			id: options.id,
		});
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const listArchivedChats = (options: {
	connection: WsProtocolOptions;
	projectId: FolderId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		const chats = yield* client["chat.list"]({
			projectId: options.projectId,
			includeArchived: true,
		});
		return chats.filter((chat) => chat.archivedAt !== null);
	});

export const previewArchivedChat = (options: {
	connection: WsProtocolOptions;
	chatId: ChatId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["chat.archivePreview"]({ chatId: options.chatId });
	});

export const unarchiveChat = (options: {
	connection: WsProtocolOptions;
	chatId: ChatId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["chat.unarchive"]({ chatId: options.chatId });
	});

export const deleteArchivedChat = (options: {
	connection: WsProtocolOptions;
	chatId: ChatId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["chat.delete"]({ chatId: options.chatId });
	});

export const forkSessionFromMessage = (options: {
	connection: WsProtocolOptions;
	sourceSessionId: SessionId;
	fromMessageId: MessageId;
	destination: "tab" | "chat";
	worktreeId?: WorktreeId | null;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["session.fork"]({
			sourceSessionId: options.sourceSessionId,
			fromMessageId: options.fromMessageId,
			destination: options.destination,
			worktreeId: options.worktreeId,
		});
	});

export const loadUsageOverview = (options: {
	connection: WsProtocolOptions;
	forceRefresh?: boolean;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["usage.overview"]({
			forceRefresh: options.forceRefresh,
		});
	});

export const loadUsageLimits = (options: {
	connection: WsProtocolOptions;
	forceRefresh?: boolean;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["usage.limits"]({
			forceRefresh: options.forceRefresh,
		});
	});

export const openSessionOnHost = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["host.openSession"]({ sessionId: options.sessionId });
	});

export const listOwnedTerminals = (options: {
	connection: WsProtocolOptions;
	ownerId: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["pty.list"]({ ownerId: options.ownerId });
	});

export const openMobileTerminal = (options: {
	connection: WsProtocolOptions;
	ownerId: string;
	cwd: string;
	label: string;
	cols: number;
	rows: number;
	sessionScoped?: boolean;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["pty.open"]({
			cwd: options.cwd,
			cols: options.cols,
			rows: options.rows,
			mobileOwnership: {
				ownerId: options.ownerId,
				label: options.label,
				scope: options.sessionScoped === false ? "environment" : "session",
			},
		});
	});

export const writeTerminal = (options: {
	connection: WsProtocolOptions;
	ptyId: PtyId;
	ownerId: string;
	data: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["pty.write"]({
			ptyId: options.ptyId,
			data: options.data,
			ownerId: options.ownerId,
		});
	});

export const resizeTerminal = (options: {
	connection: WsProtocolOptions;
	ptyId: PtyId;
	ownerId: string;
	cols: number;
	rows: number;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["pty.resize"]({
			ptyId: options.ptyId,
			cols: Math.max(1, options.cols),
			rows: Math.max(1, options.rows),
			ownerId: options.ownerId,
		});
	});

export const closeTerminal = (options: {
	connection: WsProtocolOptions;
	ptyId: PtyId;
	ownerId: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["pty.close"]({
			ptyId: options.ptyId,
			ownerId: options.ownerId,
		});
	});

export const streamTerminalOutput = (options: {
	connection: WsProtocolOptions;
	ptyId: PtyId;
	ownerId: string;
	afterSequence: number;
}) =>
	Stream.unwrap(
		Effect.map(getConnectionClient(options.connection), (client) =>
			client["pty.output"]({
				ptyId: options.ptyId,
				afterSequence: options.afterSequence,
				ownerId: options.ownerId,
			}),
		),
	);

export const prewarmVoice = (options: { connection: WsProtocolOptions }) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["voice.prewarm"]({});
	});

export const getVoiceCapabilities = (options: {
	connection: WsProtocolOptions;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["voice.capabilities"]({});
	});

export const transcribeVoice = (options: {
	connection: WsProtocolOptions;
	bytes: Uint8Array;
	mimeType: string;
	durationMs: number;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["voice.transcribe"]({
			bytes: options.bytes,
			mimeType: options.mimeType,
			durationMs: options.durationMs,
		});
	});

/** Keep this secret-bearing result in a single-use in-memory scope. */
export const resolveVoiceAuth = (options: {
	connection: WsProtocolOptions;
	ticket: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["voice.resolveAuth"]({ ticket: options.ticket });
	});

export const sendMessage = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	input: ComposerInputType;
	asGoal?: boolean;
	clientMessageId?: MessageId;
}) => {
	if (options.clientMessageId !== undefined) {
		const commandId = CommandId.make(options.clientMessageId);
		const payload = {
			sessionId: options.sessionId,
			commandId,
			input: options.input,
			...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
			clientMessageId: options.clientMessageId,
		};
		return dispatchSessionCommand(options, "messages.send", payload, commandId);
	}
	const commandId = nextCommandId("message-send");
	const payload = {
		sessionId: options.sessionId,
		commandId,
		input: options.input,
		...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
		...(options.clientMessageId === undefined
			? {}
			: { clientMessageId: options.clientMessageId }),
	};
	return dispatchSessionCommand(options, "messages.send", payload, commandId);
};

export const queueMessage = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	input: ComposerInputType;
	queueId?: string;
}) => {
	const commandId = CommandId.make(
		options.queueId ?? nextCommandId("queue-add"),
	);
	return dispatchSessionCommand(
		options,
		"messages.queue.add",
		{
			sessionId: options.sessionId,
			commandId,
			input: options.input,
			queueId: options.queueId,
		},
		commandId,
	);
};

export const flushServerQueue = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}) => {
	const commandId = nextCommandId("queue-flush");
	return dispatchSessionCommand(
		options,
		"messages.queue.flush",
		{
			sessionId: options.sessionId,
			commandId,
		},
		commandId,
	);
};

export const interruptSession = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}) => {
	const commandId = nextCommandId("message-interrupt");
	return dispatchSessionCommand(
		options,
		"messages.interrupt",
		{
			sessionId: options.sessionId,
			commandId,
		},
		commandId,
	);
};

export const renameSession = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	title: string;
}): Effect.Effect<Session, unknown> => {
	const commandId = nextCommandId("session-rename");
	return dispatchSessionCommand<Session>(
		options,
		"session.rename",
		{
			commandId,
			sessionId: options.sessionId,
			title: options.title,
		},
		commandId,
	);
};

export const decidePermission = (options: {
	connection: WsProtocolOptions;
	requestId: string;
	decision: PermissionDecision;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["permission.decide"]({
			requestId: options.requestId,
			decision: options.decision,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const respondToPlan = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	toolCallId: string;
	outcome: PlanApprovalOutcome;
	feedback?: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.plan.respond"]({
			sessionId: options.sessionId,
			toolCallId: options.toolCallId,
			outcome: options.outcome,
			feedback: options.feedback,
		});
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const answerQuestion = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	itemId: string;
	answers: readonly {
		questionIndex: number;
		selected: readonly number[];
		other?: string;
	}[];
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.answerQuestion"]({
			sessionId: options.sessionId,
			itemId: options.itemId,
			answers: [...options.answers].map((answer) => ({
				questionIndex: answer.questionIndex,
				selected: [...answer.selected],
				other: answer.other,
			})),
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const createChat = (options: {
	connection: WsProtocolOptions;
	projectId: Folder["id"];
	providerId: ProviderId;
	model: string;
	initialPrompt: string;
	runtimeMode?: RuntimeMode;
	permissionMode?: PermissionMode;
	modelOptions?: Record<string, string>;
	worktreeId?: WorktreeId | null;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["chat.create"]({
			projectId: options.projectId,
			providerId: options.providerId,
			model: options.model,
			initialPrompt: options.initialPrompt,
			runtimeMode: options.runtimeMode,
			permissionMode: options.permissionMode,
			modelOptions: options.modelOptions,
			worktreeId: options.worktreeId ?? null,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const setSessionProvider = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	providerId: ProviderId;
	model: string;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.setProvider"]({
			sessionId: options.sessionId,
			providerId: options.providerId,
			model: options.model,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const setSessionModel = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	model: string;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.setModel"]({
			sessionId: options.sessionId,
			model: options.model,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

/**
 * Fetch the per-provider availability report so the model menu can hide
 * providers/models whose CLI isn't installed. Resolves to `null` on any
 * failure (old server without the RPC, transport error) so callers fall back
 * to the full static catalog rather than showing an empty menu.
 */
export const fetchAgentAvailability = (options: {
	connection: WsProtocolOptions;
}): Effect.Effect<readonly AgentAvailability[] | null, never, never> => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["provider.availability"]({});
	});
	return program.pipe(
		Effect.catch((cause) =>
			Effect.sync(() => {
				reportConnectionFailure(options.connection, cause);
				return null;
			}),
		),
	);
};

export const setSessionRuntimeMode = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	runtimeMode: RuntimeMode;
}) => {
	const commandId = nextCommandId("session-runtime-mode");
	const program = dispatchSessionCommand(
		options,
		"session.setRuntimeMode",
		{
			commandId,
			sessionId: options.sessionId,
			runtimeMode: options.runtimeMode,
		},
		commandId,
	);
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const setSessionPermissionMode = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	mode: PermissionMode;
}) => {
	const commandId = nextCommandId("session-permission-mode");
	const program = dispatchSessionCommand(
		options,
		"session.setPermissionMode",
		{
			commandId,
			sessionId: options.sessionId,
			mode: options.mode,
		},
		commandId,
	);
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const renameChat = (options: {
	connection: WsProtocolOptions;
	chatId: Chat["id"];
	title: string;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["chat.rename"]({
			chatId: options.chatId,
			title: options.title,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const getWorktree = (options: {
	connection: WsProtocolOptions;
	worktreeId: WorktreeId;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["worktree.get"]({ worktreeId: options.worktreeId });
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const renameWorktreeBranch = (options: {
	connection: WsProtocolOptions;
	worktreeId: WorktreeId;
	name: string;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["worktree.renameBranch"]({
			worktreeId: options.worktreeId,
			name: options.name,
		});
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const markChatRead = (options: {
	connection: WsProtocolOptions;
	chatId: Chat["id"];
}): Effect.Effect<Chat, unknown, never> => {
	const program: Effect.Effect<Chat, unknown, never> = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["chat.markRead"]({ chatId: options.chatId });
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const listWorktrees = (options: {
	connection: WsProtocolOptions;
	projectId: Folder["id"];
}) => {
	const program: Effect.Effect<readonly Worktree[], unknown, never> =
		Effect.gen(function* () {
			const client = yield* getConnectionClient(options.connection);
			return yield* client["worktree.list"]({ projectId: options.projectId });
		});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const createWorktree = (options: {
	connection: WsProtocolOptions;
	projectId: Folder["id"];
	source?: WorktreeCreateSource;
}) => {
	const program: Effect.Effect<Worktree, unknown, never> = Effect.gen(
		function* () {
			const client = yield* getConnectionClient(options.connection);
			return yield* client["worktree.create"]({
				projectId: options.projectId,
				source: options.source,
			});
		},
	);
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const listBranches = (options: {
	connection: WsProtocolOptions;
	projectId: Folder["id"];
}) => {
	const program: Effect.Effect<readonly GitBranchInfo[], unknown, never> =
		Effect.gen(function* () {
			const client = yield* getConnectionClient(options.connection);
			return yield* client["git.branches"]({ folderId: options.projectId });
		});
	return program.pipe(Effect.catch(() => Effect.succeed([])));
};

type GitTarget = {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
};

export const loadGitStatus = (
	options: GitTarget,
): Effect.Effect<GitStatusSummary, unknown> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.status"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const loadGitBranches = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.branches"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const loadGitPrState = (
	options: GitTarget,
): Effect.Effect<GitPrInfo, unknown> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.prState"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const markGitPrReady = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.markReady"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const mergeGitPr = (
	options: GitTarget & {
		action: "merge" | "enable-auto" | "disable-auto";
		method?: "merge" | "squash" | "rebase";
	},
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.mergePr"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			action: options.action,
			method: options.method ?? "squash",
			deleteBranch: false,
		});
	});

export const switchGitBranch = (
	options: GitTarget & { branch: string; remote?: string | null },
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.switchBranch"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			branch: options.branch,
			remote: options.remote ?? null,
		});
	});

export const commitGitChanges = (
	options: GitTarget & { message: string; paths?: readonly string[] },
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.commit"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			message: options.message,
			paths: options.paths === undefined ? undefined : [...options.paths],
		});
	});

export const pushGitChanges = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.push"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const pullGitChanges = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.pull"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const stashGitChanges = (options: GitTarget & { message?: string }) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.stash"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			message: options.message,
		});
	});

export const popGitStash = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.stashPop"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const previewGitResetRemote = (
	options: GitTarget,
): Effect.Effect<GitResetRemotePreview, unknown> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.resetRemotePreview"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const applyGitResetRemote = (
	options: GitTarget & {
		preview: GitResetRemotePreview;
		confirmationBranch: string;
	},
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.resetRemoteApply"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			expectedHead: options.preview.currentHead,
			expectedRemoteHead: options.preview.remoteHead,
			expectedWorktreeFingerprint: options.preview.worktreeFingerprint,
			confirmationBranch: options.confirmationBranch,
		});
	});

export const revertGitFile = (
	options: GitTarget & {
		change: Pick<GitChange, "path" | "oldPath" | "kind">;
	},
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.revertFile"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			...options.change,
		});
	});

export const revertAllGitChanges = (options: GitTarget) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.revertAll"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const readGitReviewFileContents = (
	options: GitTarget & { path: string; oldPath?: string | null },
): Effect.Effect<GitReviewFileContents, unknown> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.reviewFileContents"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			path: options.path,
			oldPath: options.oldPath ?? null,
		});
	});

export const resolveGitConflict = (
	options: GitTarget & { path: string; contents: string },
) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.resolveConflict"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			path: options.path,
			contents: options.contents,
		});
	});

export const listPullRequests = (options: {
	connection: WsProtocolOptions;
	projectId: Folder["id"];
}) => {
	const program: Effect.Effect<readonly GitPrSummary[], unknown, never> =
		Effect.gen(function* () {
			const client = yield* getConnectionClient(options.connection);
			return yield* client["git.listPrs"]({ folderId: options.projectId });
		});
	return program.pipe(Effect.catch(() => Effect.succeed([])));
};

export const listWorkspacePaths = (options: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
}) =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["fs.listPaths"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);

export const loadWorkspaceReview = (options: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
	scope?: GitReviewScope;
}): Effect.Effect<GitReviewSummary, unknown, never> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.reviewSummary"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
			scope: reviewScopeRequestValue(options.scope),
		});
	});

export const streamWorkspaceReviewPatches = (options: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
	scope?: GitReviewScope;
}): Stream.Stream<GitReviewPatch, unknown, never> =>
	Stream.unwrap(
		Effect.map(getConnectionClient(options.connection), (client) =>
			client["git.reviewPatches"]({
				folderId: options.folderId,
				worktreeId: options.worktreeId ?? null,
				scope: reviewScopeRequestValue(options.scope),
			}),
		),
	);

export const readWorkspaceFile = (options: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	path: string;
	worktreeId?: WorktreeId | null;
}): Effect.Effect<typeof FsFileContent.Type, unknown, never> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["fs.readFile"]({
			folderId: options.folderId,
			path: options.path,
			worktreeId: options.worktreeId ?? null,
		});
	}).pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
