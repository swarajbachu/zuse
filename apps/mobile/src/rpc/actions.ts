import {
	type AgentAvailability,
	type AttachmentRef,
	type Chat,
	ComposerInput,
	type ComposerInput as ComposerInputType,
	type Folder,
	type FolderId,
	type FsFileContent,
	type GitBranchInfo,
	type GitPrSummary,
	type GitReviewPatch,
	type GitReviewSummary,
	type MessageId,
	type PermissionDecision,
	type PermissionMode,
	type ProviderId,
	type RuntimeMode,
	type SessionId,
	type Worktree,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";

import {
	dispatchRetryableConnectionCommand,
	getConnectionClient,
	reportConnectionFailure,
} from "./connection";
import type { WsProtocolOptions } from "./ws-protocol";

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
		const payload = {
			sessionId: options.sessionId,
			input: options.input,
			...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
			clientMessageId: options.clientMessageId,
		};
		return dispatchRetryableConnectionCommand(
			options.connection,
			options.clientMessageId,
			(client) => client["messages.send"](payload),
		);
	}
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		const payload = {
			sessionId: options.sessionId,
			input: options.input,
			...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
			...(options.clientMessageId === undefined
				? {}
				: { clientMessageId: options.clientMessageId }),
		};
		yield* client["messages.send"](payload);
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const queueMessage = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
	input: ComposerInputType;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["messages.queue.add"]({
			sessionId: options.sessionId,
			input: options.input,
		});
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const flushServerQueue = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["messages.queue.flush"]({ sessionId: options.sessionId });
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
	);
};

export const interruptSession = (options: {
	connection: WsProtocolOptions;
	sessionId: SessionId;
}) => {
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["messages.interrupt"]({ sessionId: options.sessionId });
	});
	return program.pipe(
		Effect.tapError((cause) =>
			Effect.sync(() => reportConnectionFailure(options.connection, cause)),
		),
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
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.setRuntimeMode"]({
			sessionId: options.sessionId,
			runtimeMode: options.runtimeMode,
		});
	});
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
	const program = Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		yield* client["session.setPermissionMode"]({
			sessionId: options.sessionId,
			mode: options.mode,
		});
	});
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
		yield* client["chat.rename"]({
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
}): Effect.Effect<GitReviewSummary, unknown, never> =>
	Effect.gen(function* () {
		const client = yield* getConnectionClient(options.connection);
		return yield* client["git.reviewSummary"]({
			folderId: options.folderId,
			worktreeId: options.worktreeId ?? null,
		});
	});

export const streamWorkspaceReviewPatches = (options: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
}): Stream.Stream<GitReviewPatch, unknown, never> =>
	Stream.unwrap(
		Effect.map(getConnectionClient(options.connection), (client) =>
			client["git.reviewPatches"]({
				folderId: options.folderId,
				worktreeId: options.worktreeId ?? null,
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
