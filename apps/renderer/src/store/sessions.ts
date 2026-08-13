import type {
	AgentItemId,
	ChatId,
	FolderId,
	ForkDestination,
	ForkMode,
	MessageId,
	PermissionMode,
	PlanApprovalOutcome,
	ProviderId,
	RuntimeMode,
	UserQuestionAnswer,
	WorktreeId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId, Session, SessionId } from "@zuse/contracts";
import { cloudSummaryForChat } from "../lib/cloud-workspace-catalog.ts";
import {
	activeSessionsByProject,
	overlayActiveEnvironmentShell,
} from "../lib/environment-entities.ts";
import { formatError } from "../lib/format-error.ts";
import { upsertLatestEntity } from "../lib/latest-entity.ts";
import { markRendererInteraction } from "../lib/performance-marks.ts";
import { getActiveEnvironment } from "../lib/rpc-client.ts";
import { dispatchSessionCommand } from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { selectChatSession, upsertForkedChat } from "./chat-commands.ts";
import { useWorkspaceStore } from "./workspace.ts";

/**
 * Ephemeral session UI state and commands. Durable session entities and live
 * timelines are owned by qualified ClientBus resources.
 */
type SessionsState = {
	/**
	 * Mirror of `selectedSessionByProject[selectedFolderId]`. Kept as live state
	 * (not a derived selector) so existing call sites can subscribe to it
	 * directly without a per-render workspace lookup. Synced from
	 * `selectedSessionByProject` by a workspace subscription at module init.
	 */
	readonly selectedSessionId: SessionId | null;
	/**
	 * Per-project last-selected session. Switching projects restores the
	 * previously-active session for the new project so file tree, changes,
	 * PR badge, terminal cwd, and the chat all swap together.
	 */
	readonly selectedSessionByProject: Record<string, SessionId | null>;
	readonly loadingByProject: Record<string, boolean>;
	/**
	 * Per-chat in-flight flag for `create()`. Drives the tab-strip "+"
	 * button's icon + disabled state and the loading panel that takes over
	 * the chat surface while a new tab is booting. Cleared when the RPC
	 * resolves (success or failure) — note the server-side boot continues
	 * after the RPC returns; the chat surface keeps showing the panel via
	 * `Session.status === "booting"` until the provider handshake completes.
	 */
	readonly creatingByChat: Record<string, boolean>;
	/**
	 * Ephemeral, client-only session used to drive the real `ChatComposer` on
	 * the new-chat landing before any chat/session/worktree exists. It is NOT
	 * is never inserted into the environment shell, so it cannot appear in the
	 * sidebar or tab strip —
	 * the composer's model/runtime/permission/provider setters route here (see
	 * the setters below) so the picks carry into `create()` on first send. The
	 * `ChatComposer` for it runs with `onDraftSubmit`; nothing else touches it.
	 */
	readonly draftSession: Session | null;
	readonly error: string | null;
	readonly draftSkills: ReadonlyArray<import("@zuse/contracts").Skill>;
	readonly loadDraftSkills: (
		projectId: FolderId,
		providerId: ProviderId,
	) => Promise<void>;
	/** Spin up a fresh draft session for `ChatLanding`. Returns the row. */
	readonly beginDraft: (params: {
		projectId: FolderId;
		providerId: ProviderId;
		model: string;
		runtimeMode: RuntimeMode;
	}) => Session;
	/** Tear down the draft session (on submit handoff or landing unmount). */
	readonly clearDraft: () => void;
	readonly hydrate: (projectId: FolderId) => Promise<void>;
	readonly create: (
		chatId: ChatId,
		providerId: ProviderId,
		model: string,
		opts?: {
			runtimeMode?: RuntimeMode;
			permissionMode?: PermissionMode;
			toolSearch?: boolean;
		},
	) => Promise<SessionId | null>;
	/**
	 * Branch a conversation from `fromMessageId` into a new tab (same chat) or
	 * a new sidebar chat. Inserts + selects the resulting chat/session and
	 * returns identifiers plus the fork mode the server chose
	 * (`resume` = real agent memory, `copy` = replayed transcript).
	 */
	readonly fork: (input: {
		sourceSessionId: SessionId;
		fromMessageId: MessageId;
		destination: ForkDestination;
		providerId?: ProviderId;
		model?: string;
		worktreeId?: WorktreeId | null;
		title?: string;
	}) => Promise<{
		chatId: ChatId;
		sessionId: SessionId;
		forkMode: ForkMode;
	} | null>;
	/**
	 * Patch the cached `Session.status` for a session. Called by the
	 * durable `session.events` subscription so the renderer's view of
	 * `Session.status` reflects post-boot transitions
	 * (`booting` → `idle` / `running` / `error`).
	 */
	readonly setSessionStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => void;
	readonly rename: (sessionId: SessionId, title: string) => Promise<void>;
	readonly setModel: (sessionId: SessionId, model: string) => Promise<void>;
	readonly setRuntimeMode: (
		sessionId: SessionId,
		runtimeMode: RuntimeMode,
	) => Promise<void>;
	/**
	 * Switch the SDK lifecycle mode (plan / default / acceptEdits) on a
	 * live session. Optimistic — patches the local row before the RPC
	 * settles so the chat-header chip flips instantly.
	 */
	readonly setPermissionMode: (
		sessionId: SessionId,
		mode: PermissionMode,
	) => Promise<void>;
	/**
	 * Resolve a pending in-process AskUserQuestion call. Routes the
	 * answers to the driver, which returns them as the tool result.
	 */
	readonly answerQuestion: (
		sessionId: SessionId,
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Promise<void>;
	readonly respondToPlan: (
		sessionId: SessionId,
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
		options?: { readonly silent?: boolean },
	) => Promise<"accepted" | "session-not-found" | "failed">;
	/**
	 * Switch the session's provider and model. Allowed only before the first
	 * user message — server returns `SessionAlreadyStartedError` otherwise,
	 * surfaced here as `{ ok: false, reason }`. Worktree changes go through
	 * `chats.setWorktree` instead — the chat owns the workspace binding.
	 */
	readonly setProvider: (
		sessionId: SessionId,
		providerId: ProviderId,
		model: string,
	) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
	readonly refreshOne: (sessionId: SessionId) => Promise<void>;
	readonly archive: (sessionId: SessionId) => Promise<void>;
	readonly unarchive: (sessionId: SessionId) => Promise<void>;
	readonly remove: (sessionId: SessionId) => Promise<void>;
	readonly resume: (sessionId: SessionId) => Promise<boolean>;
	readonly select: (sessionId: SessionId | null) => void;
};

/**
 * Sentinel ids for the landing's draft session. Fixed (not random) so the
 * composer's `key` stays stable across re-renders and the setter routing can
 * recognise the draft by id without threading a flag through every toggle.
 */
export const DRAFT_SESSION_ID = "draft-session" as SessionId;
export const DRAFT_CHAT_ID = "draft-chat" as ChatId;

let commandCounter = 0;
const nextCommandId = (kind: string): CommandId =>
	CommandId.make(
		`${kind}:${Date.now().toString(36)}:${(commandCounter++).toString(36)}`,
	);

const dispatchTimelineCommand = <Payload, Result>(
	sessionId: SessionId,
	kind: string,
	commandId: CommandId,
	payload: Payload,
	retry: "safe" | "never" = "safe",
	environmentId = EnvironmentId.make(getActiveEnvironment()),
) =>
	dispatchSessionCommand<Payload, Result>({
		ref: {
			environmentId,
			sessionId,
		},
		kind,
		commandId,
		payload,
		retry,
	});

const findSessionProject = (
	sessionsByProject: Readonly<Record<string, ReadonlyArray<Session>>>,
	sessionId: SessionId,
): FolderId | null => {
	for (const [pid, sessions] of Object.entries(sessionsByProject)) {
		if (sessions.some((s) => s.id === sessionId)) return pid as FolderId;
	}
	return null;
};

const patchActiveSession = (
	sessionId: SessionId,
	update: (session: Session) => Session,
): void => {
	overlayActiveEnvironmentShell((shell) => {
		const projectId = findSessionProject(shell.sessionsByProject, sessionId);
		if (projectId === null) return undefined;
		return {
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
					(session) => (session.id === sessionId ? update(session) : session),
				),
			},
		};
	});
};

const removeActiveSession = (sessionId: SessionId): FolderId | null => {
	let owningProject: FolderId | null = null;
	overlayActiveEnvironmentShell((shell) => {
		owningProject = findSessionProject(shell.sessionsByProject, sessionId);
		if (owningProject === null) return undefined;
		return {
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[owningProject]: (shell.sessionsByProject[owningProject] ?? []).filter(
					(session) => session.id !== sessionId,
				),
			},
		};
	});
	return owningProject;
};

export const useSessionsStore = create<SessionsState>((set, get) => ({
	selectedSessionId: null,
	selectedSessionByProject: {},
	loadingByProject: {},
	creatingByChat: {},
	draftSession: null,
	draftSkills: [],
	error: null,
	beginDraft: ({ projectId, providerId, model, runtimeMode }) => {
		const now = new Date();
		const draft = Session.make({
			id: DRAFT_SESSION_ID,
			projectId,
			title: "New chat",
			providerId,
			model,
			status: "idle",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode,
			worktreeId: null,
			chatId: DRAFT_CHAT_ID,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: "default",
			toolSearch: false,
			createdAt: now,
			updatedAt: now,
		});
		set({ draftSession: draft });
		return draft;
	},
	clearDraft: () => set({ draftSession: null, draftSkills: [] }),
	loadDraftSkills: async (projectId, providerId) => {
		try {
			const { result } = await dispatchTimelineCommand<
				{ readonly projectId: FolderId; readonly providerId: ProviderId },
				ReadonlyArray<import("@zuse/contracts").Skill>
			>(
				DRAFT_SESSION_ID,
				"skill.listForProject",
				nextCommandId("draft-skills"),
				{ projectId, providerId },
				"never",
			);
			set({ draftSkills: result });
		} catch {
			set({ draftSkills: [] });
		}
	},
	hydrate: async (projectId) => {
		// EnvironmentShellResource owns subscribe-before-snapshot hydration.
		set((s) => ({
			loadingByProject: { ...s.loadingByProject, [projectId]: false },
			error: null,
		}));
	},
	create: async (chatId, providerId, model, opts) => {
		const sessionId = SessionId.make(`s_${crypto.randomUUID()}`);
		const source = Object.values(activeSessionsByProject())
			.flat()
			.find((session) => session.chatId === chatId);
		const projectId =
			source?.projectId ?? useWorkspaceStore.getState().selectedFolderId;
		if (projectId === null) return null;
		const now = new Date();
		const optimistic = Session.make({
			id: sessionId,
			projectId,
			title: "New chat",
			titleProvenance: "pending",
			providerId,
			model,
			status: "booting",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: opts?.runtimeMode ?? "approval-required",
			worktreeId: source?.worktreeId ?? null,
			chatId,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: opts?.permissionMode ?? "default",
			toolSearch: opts?.toolSearch ?? false,
			createdAt: now,
			updatedAt: now,
		});
		markRendererInteraction(sessionId, "click");
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: [
					optimistic,
					...(shell.sessionsByProject[projectId] ?? []),
				],
			},
		}));
		set((s) => ({
			error: null,
			creatingByChat: { ...s.creatingByChat, [chatId]: true },
			selectedSessionId: sessionId,
			selectedSessionByProject: {
				...s.selectedSessionByProject,
				[projectId]: sessionId,
			},
		}));
		markRendererInteraction(sessionId, "first-atom-commit");
		try {
			const cloudSummary = cloudSummaryForChat(chatId);
			if (cloudSummary !== null) {
				const { ensureCloudWorkspaceAttached } = await import(
					"../lib/cloud-workspaces.ts"
				);
				await ensureCloudWorkspaceAttached(cloudSummary);
			}
			const commandId = nextCommandId("session-create");
			const { result: session } = await dispatchTimelineCommand<
				{
					readonly sessionId: SessionId;
					readonly chatId: ChatId;
					readonly providerId: ProviderId;
					readonly model: string;
					readonly runtimeMode?: RuntimeMode;
					readonly permissionMode?: PermissionMode;
					readonly toolSearch?: boolean;
				},
				Session
			>(
				sessionId,
				"session.create",
				commandId,
				{
					sessionId,
					chatId,
					providerId,
					model,
					runtimeMode: opts?.runtimeMode,
					permissionMode: opts?.permissionMode,
					toolSearch: opts?.toolSearch,
				},
				"never",
				EnvironmentId.make(cloudSummary?.workspaceId ?? getActiveEnvironment()),
			);
			markRendererInteraction(sessionId, "entity-acknowledged");
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						session,
					),
				},
			}));
			set((s) => {
				return {
					selectedSessionId: session.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: session.id,
					},
					creatingByChat: { ...s.creatingByChat, [chatId]: false },
				};
			});
			return session.id;
		} catch (err) {
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === sessionId
							? Session.make({ ...row, status: "error" })
							: row,
					),
				},
			}));
			set((s) => ({
				error: formatError(err),
				creatingByChat: { ...s.creatingByChat, [chatId]: false },
			}));
			return null;
		}
	},
	fork: async (input) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-fork");
			const { result } = await dispatchTimelineCommand<
				{
					readonly sourceSessionId: SessionId;
					readonly fromMessageId: MessageId;
					readonly destination: ForkDestination;
					readonly providerId?: ProviderId;
					readonly model?: string;
					readonly worktreeId?: WorktreeId | null;
					readonly title?: string;
				},
				{
					readonly chat: import("@zuse/contracts").Chat;
					readonly session: Session;
					readonly forkMode: ForkMode;
				}
			>(
				input.sourceSessionId,
				"session.fork",
				commandId,
				{
					sourceSessionId: input.sourceSessionId,
					fromMessageId: input.fromMessageId,
					destination: input.destination,
					providerId: input.providerId,
					model: input.model,
					worktreeId: input.worktreeId,
					title: input.title,
				},
				"never",
			);
			const { chat, session, forkMode } = result;
			const projectId = session.projectId;
			// Insert + select the forked session.
			overlayActiveEnvironmentShell((shell) => {
				const existing = shell.sessionsByProject[projectId] ?? [];
				return {
					...shell,
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: [
							session,
							...existing.filter((row) => row.id !== session.id),
						],
					},
				};
			});
			set((s) => {
				return {
					selectedSessionId: session.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: session.id,
					},
				};
			});
			// The chat domain owns its projection and active-session persistence.
			upsertForkedChat(chat, session);
			return { chatId: chat.id, sessionId: session.id, forkMode };
		} catch (err) {
			set({ error: formatError(err) });
			return null;
		}
	},
	setSessionStatus: (sessionId, status) => {
		overlayActiveEnvironmentShell((shell) => {
			const projectId = findSessionProject(shell.sessionsByProject, sessionId);
			if (projectId === null) return undefined;
			return {
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === sessionId ? ({ ...row, status } as Session) : row,
					),
				},
			};
		});
	},
	rename: async (sessionId, title) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-rename");
			const { result: renamed } = await dispatchTimelineCommand<
				{
					readonly commandId: CommandId;
					readonly sessionId: SessionId;
					readonly title: string;
				},
				Session
			>(sessionId, "session.rename", commandId, {
				commandId,
				sessionId,
				title,
			});
			overlayActiveEnvironmentShell((shell) => {
				const projectId = findSessionProject(
					shell.sessionsByProject,
					sessionId,
				);
				if (projectId === null) return undefined;
				return {
					...shell,
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
							(session) => (session.id === sessionId ? renamed : session),
						),
					},
				};
			});
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	setModel: async (sessionId, model) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, model }) });
			return;
		}
		set({ error: null });
		try {
			const commandId = nextCommandId("session-model");
			await dispatchTimelineCommand(
				sessionId,
				"session.setModel",
				commandId,
				{ sessionId, model },
				"never",
			);
			patchActiveSession(sessionId, (session) =>
				Session.make({ ...session, model }),
			);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	setRuntimeMode: async (sessionId, runtimeMode) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, runtimeMode }) });
			return;
		}
		// Optimistic — patch the local row before the RPC settles so the toggle
		// feels instant. Server-side update is also fast (single SQL UPDATE +
		// in-memory cache poke), so the round-trip is invisible in practice.
		set({ error: null });
		patchActiveSession(sessionId, (session) =>
			Session.make({ ...session, runtimeMode }),
		);
		try {
			const commandId = nextCommandId("session-runtime-mode");
			await dispatchTimelineCommand(
				sessionId,
				"session.setRuntimeMode",
				commandId,
				{
					commandId,
					sessionId,
					runtimeMode,
				},
			);
		} catch (err) {
			set({ error: formatError(err) });
			// Best-effort revert via re-hydrate of the affected project.
			const projectId = findSessionProject(
				activeSessionsByProject(),
				sessionId,
			);
			if (projectId !== null) await get().hydrate(projectId);
		}
	},
	setPermissionMode: async (sessionId, mode) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, permissionMode: mode }) });
			return;
		}
		set({ error: null });
		patchActiveSession(sessionId, (session) =>
			Session.make({ ...session, permissionMode: mode }),
		);
		try {
			const commandId = nextCommandId("session-permission-mode");
			await dispatchTimelineCommand(
				sessionId,
				"session.setPermissionMode",
				commandId,
				{ commandId, sessionId, mode },
			);
		} catch (err) {
			set({ error: formatError(err) });
			const projectId = findSessionProject(
				activeSessionsByProject(),
				sessionId,
			);
			if (projectId !== null) await get().hydrate(projectId);
		}
	},
	answerQuestion: async (sessionId, itemId, answers) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-answer-question");
			await dispatchTimelineCommand(
				sessionId,
				"session.answerQuestion",
				commandId,
				{ sessionId, itemId, answers },
				"never",
			);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	respondToPlan: async (sessionId, toolCallId, outcome, feedback, options) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-plan-response");
			await dispatchTimelineCommand(
				sessionId,
				"session.plan.respond",
				commandId,
				{
					sessionId,
					toolCallId,
					outcome,
					...(feedback === undefined ? {} : { feedback }),
				},
				"never",
			);
			return "accepted";
		} catch (error) {
			const message = formatError(error);
			if (message.includes("SessionNotFoundError")) {
				if (options?.silent !== true) set({ error: message });
				return "session-not-found";
			}
			set({ error: message });
			return "failed";
		}
	},
	setProvider: async (sessionId, providerId, model) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, providerId, model }) });
			return { ok: true } as const;
		}
		set({ error: null });
		try {
			const commandId = nextCommandId("session-provider");
			await dispatchTimelineCommand(
				sessionId,
				"session.setProvider",
				commandId,
				{ sessionId, providerId, model },
				"never",
			);
			patchActiveSession(sessionId, (session) =>
				Session.make({ ...session, providerId, model }),
			);
			return { ok: true } as const;
		} catch (err) {
			const raw = formatError(err);
			const reason =
				raw === "SessionAlreadyStartedError"
					? "Start a new chat to switch provider."
					: raw;
			set({ error: reason });
			return { ok: false, reason } as const;
		}
	},
	archive: async (sessionId) => {
		set({ error: null });
		const projectId = findSessionProject(activeSessionsByProject(), sessionId);
		try {
			const commandId = nextCommandId("session-archive");
			await dispatchTimelineCommand(
				sessionId,
				"session.archive",
				commandId,
				{ sessionId },
				"never",
			);
			removeActiveSession(sessionId);
			set((s) => {
				const wasSelected = s.selectedSessionId === sessionId;
				const selectedSessionByProject =
					projectId !== null &&
					s.selectedSessionByProject[projectId] === sessionId
						? { ...s.selectedSessionByProject, [projectId]: null }
						: s.selectedSessionByProject;
				const clearPerProject =
					selectedSessionByProject !== s.selectedSessionByProject;
				if (!wasSelected && !clearPerProject) return s;
				return {
					selectedSessionId: wasSelected ? null : s.selectedSessionId,
					selectedSessionByProject,
				};
			});
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	unarchive: async (sessionId) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-unarchive");
			await dispatchTimelineCommand(
				sessionId,
				"session.unarchive",
				commandId,
				{ sessionId },
				"never",
			);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	remove: async (sessionId) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-delete");
			await dispatchTimelineCommand(
				sessionId,
				"session.delete",
				commandId,
				{ sessionId },
				"never",
			);
			const projectId = removeActiveSession(sessionId);
			set((s) => {
				if (projectId === null) return {};
				const perProject =
					s.selectedSessionByProject[projectId] === sessionId
						? { ...s.selectedSessionByProject, [projectId]: null }
						: s.selectedSessionByProject;
				return {
					selectedSessionId:
						s.selectedSessionId === sessionId ? null : s.selectedSessionId,
					selectedSessionByProject: perProject,
				};
			});
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	resume: async (sessionId) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-resume");
			const { result: session } = await dispatchTimelineCommand<
				{ readonly sessionId: SessionId },
				Session
			>(sessionId, "session.resume", commandId, { sessionId }, "never");
			const projectId = session.projectId;
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						session,
					),
				},
			}));
			set((s) => ({
				selectedSessionId: session.id,
				selectedSessionByProject: {
					...s.selectedSessionByProject,
					[projectId]: session.id,
				},
			}));
			return true;
		} catch (err) {
			set({ error: formatError(err) });
			return false;
		}
	},
	refreshOne: async (sessionId) => {
		try {
			const commandId = nextCommandId("session-get");
			const { result: session } = await dispatchTimelineCommand<
				{ readonly sessionId: SessionId },
				Session
			>(sessionId, "session.get", commandId, { sessionId }, "never");
			patchActiveSession(sessionId, () => session);
		} catch {
			// Silent — refreshOne is a best-effort follow-up after send().
		}
	},
	select: (sessionId) => {
		if (sessionId === null) {
			set((s) => {
				const activeProjectId = useWorkspaceStore.getState().selectedFolderId;
				return {
					selectedSessionId: null,
					selectedSessionByProject:
						activeProjectId !== null
							? { ...s.selectedSessionByProject, [activeProjectId]: null }
							: s.selectedSessionByProject,
				};
			});
			return;
		}
		const sessionsByProject = activeSessionsByProject();
		const projectId = findSessionProject(sessionsByProject, sessionId);
		// Write the per-project slot FIRST so the workspace.select below sees
		// the freshly-set slot when its subscriber fires — otherwise the
		// subscriber would briefly mirror the stale slot value.
		set((s) => ({
			selectedSessionId: sessionId,
			selectedSessionByProject:
				projectId !== null
					? { ...s.selectedSessionByProject, [projectId]: sessionId }
					: s.selectedSessionByProject,
		}));
		// Mirror the active tab into the owning chat row so a later sidebar
		// click restores this tab. Lookup is best-effort — we skip when the
		// session row hasn't hit the renderer cache yet (e.g. just-created
		// session whose hydrate is still in flight).
		const sessionRow =
			projectId !== null
				? sessionsByProject[projectId]?.find((row) => row.id === sessionId)
				: undefined;
		if (sessionRow !== undefined) {
			selectChatSession(sessionRow.chatId, sessionId);
		}
		// If the session lives in a different project than the currently-active
		// one, switch projects too. Without this the chat would jump to the new
		// session but the right pane, top bar, terminal cwd, etc. would stay on
		// the old project — the "click does nothing visible" symptom.
		if (
			projectId !== null &&
			useWorkspaceStore.getState().selectedFolderId !== projectId
		) {
			void useWorkspaceStore.getState().select(projectId);
		}
	},
}));

// Mirror `selectedSessionId` from the active project's per-project slot.
// Switching projects automatically restores whichever session was last
// selected for the new project; if none, the chat clears (no stale session
// from the previous project leaks across).
useWorkspaceStore.subscribe((ws, prev) => {
	if (ws.selectedFolderId === prev.selectedFolderId) return;
	const slot =
		ws.selectedFolderId !== null
			? (useSessionsStore.getState().selectedSessionByProject[
					ws.selectedFolderId
				] ?? null)
			: null;
	if (useSessionsStore.getState().selectedSessionId !== slot) {
		useSessionsStore.setState({ selectedSessionId: slot });
	}
});
