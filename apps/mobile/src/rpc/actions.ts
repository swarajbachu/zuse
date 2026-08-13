import {
	type AgentAvailability,
	type AttachmentRef,
	type Chat,
	CommandId,
	ComposerInput,
	type ComposerInput as ComposerInputType,
	type Folder,
	type FolderId,
	type FsFileContent,
	type GitBranchInfo,
	type GitPrSummary,
	type GitReviewPatch,
	type GitReviewScope,
	type GitReviewSummary,
	type MessageId,
	type PermissionDecision,
	type PermissionMode,
	type PlanApprovalOutcome,
	type ProviderId,
	type RuntimeMode,
	type Session,
	type SessionId,
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
): ComposerInputType =>
	ComposerInput.make({
		text,
		attachments: [...attachments],
		fileRefs: [],
		skillRefs: [],
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
