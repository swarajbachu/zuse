import type { EditorView } from "@codemirror/view";
import { HugeiconsIcon } from "@hugeicons/react";
import { DitherButton } from "@repo/ui/dither";
import {
	type BooleanOptionDescriptor,
	type BrowserAnnotation,
	type ComposerAnnotation,
	ComposerInput,
	type EnvironmentId,
	findModelDescriptor,
	type Message,
	type PermissionMode,
	type PermissionRequest,
	type ProviderId,
	type QueuedMessage,
	type RuntimeMode,
	type SelectOptionDescriptor,
	type Session,
	type SessionId,
	type ThreadGoal,
} from "@zuse/contracts";
import {
	AttachmentIcon,
	DashboardSpeedIcon,
	Delete02Icon,
	FlashIcon,
	InformationCircleIcon,
	MapsIcon,
	PencilIcon,
	PlayIcon,
	SentIcon,
	SquareIcon,
	Upload01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardPanel } from "~/components/ui/card";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
	Menu,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuTrigger,
} from "~/components/ui/menu";
import { Slider } from "~/components/ui/slider";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast.tsx";
import {
	Tooltip,
	TooltipPopup,
	TooltipProvider,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { makeCoalescedWriter } from "~/lib/coalesced-writer";
import {
	type ActiveTrigger,
	composerDoc,
	createComposerView,
	reconfigureComposerKeymap,
	replaceWithChip,
	restoreComposerChips,
	setComposerDoc,
} from "~/lib/codemirror/composer";
import {
	addChipEffect,
	allChips,
	type ChipMeta,
	clearChipsEffect,
	removeImageChipEffect,
	updateImageChipEffect,
} from "~/lib/codemirror/composer-chips";
import { saveContextText } from "~/lib/context-handoff.ts";
import {
	chooseComposerSubmitRoute,
	deliverNativePlanFeedback,
	findPendingNativePlanApproval,
	findPendingPlanApprovalRequest,
	hasEmulatedPlanAwaitingAction,
	providerUsesEmulatedPlanMode,
	shouldSendPlanFeedbackNow,
} from "~/lib/plan-feedback-routing";
import { attachmentUrl } from "~/lib/platform-capabilities";
import { readStorageWithLegacy } from "~/lib/storage-keys";
import { cn, formatCompactNumber } from "~/lib/utils";
import {
	type BuiltinCommand,
	matchBuiltin,
} from "../composer/builtin-commands.ts";
import type {
	PendingDraftAttachment,
	PendingDraftContextFile,
} from "../composer/draft-attachments.ts";
import { composerSnapshotFromInput } from "../composer/input-snapshot.ts";
import { parseComposerInput } from "../composer/segment-parser.ts";
import { uploadAttachment } from "../lib/attachments.ts";
import {
	cloudChatShowsWorking,
	cloudWorkspaceIsStarting,
	deriveCloudChatActivity,
} from "../lib/cloud-chat-activity.ts";
import { useCloudChatSummaryForSelection } from "../lib/cloud-workspaces.ts";
import {
	cloudComposerSubmissionBlocked,
	commitAcceptedComposerDelivery,
	shouldQueueComposerMessage,
} from "../lib/composer-delivery.ts";
import {
	decideEnvironmentPermission,
	useEnvironmentPermissions,
} from "../lib/environment-permissions-client-bus.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { subscribeKeybindings } from "../lib/keybindings-client-bus.ts";
import { usePlatformOnline } from "../lib/network-status.ts";
import {
	interruptSession,
	queueSessionMessage,
	sendSessionMessage,
	sessionModelOptionStorageKey,
	takeQueuedMessageForEdit,
} from "../lib/session-actions.ts";
import {
	clearSessionGoal,
	setSessionGoal,
	useSessionGoalResource,
} from "../lib/session-goal-client-bus.ts";
import { hasPendingTurnStart } from "../lib/session-runtime-state.ts";
import { useRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { useActiveWorkspaceRoot } from "../store/active-workspace.ts";
import {
	annotationsForSession,
	useAnnotationsStore,
} from "../store/annotations.ts";
import { useChatsStore } from "../store/chats.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import {
	currentModelCatalog,
	useModelCatalogStore,
} from "../store/model-catalog.ts";
import { usePaneFocus } from "../store/pane-focus.ts";
import { useProvidersStore } from "../store/providers.ts";
import { AnnotationTray } from "./composer/annotation-tray.tsx";
import { ComposerChipOverlay } from "./composer/composer-chip-overlay.tsx";
import { ContextTray } from "./composer/context-tray.tsx";
import { FileTagPopover } from "./composer/file-tag-popover.tsx";
import { NoConnectionTray } from "./composer/no-connection-tray.tsx";
import {
	EMULATED_PLAN_APPROVAL_PROMPT,
	PlanApprovalTray,
} from "./composer/plan-approval-tray.tsx";
import { ProjectPlanTray } from "./composer/project-plan-tray.tsx";
import { QueueTray } from "./composer/queue-tray.tsx";
import { SlashCommandPopover } from "./composer/slash-command-popover.tsx";
import {
	composerTraySurfaceClass,
	TrayPill,
	trayPillActionClass,
} from "./composer/tray-pill.tsx";

const EMPTY_PERMISSION_REQUESTS: Readonly<Record<string, PermissionRequest>> =
	{};

import { McpPopover } from "./mcp-popover.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { resetLabel, StickMeter } from "./usage/usage-meter.tsx";

const isBrowserAnnotation = (
	annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
	"_tag" in annotation && annotation._tag === "browser";

const attachmentsWithBrowserAnnotations = (
	attachments: ComposerInput["attachments"],
	annotations: ReadonlyArray<ComposerAnnotation>,
): ComposerInput["attachments"] => {
	const next = [...attachments];
	const seen = new Set(next.map((attachment) => attachment.id));
	for (const annotation of annotations) {
		if (!isBrowserAnnotation(annotation)) continue;
		const screenshot = annotation.screenshotAttachment;
		if (screenshot === null || seen.has(screenshot.id)) continue;
		next.push(screenshot);
		seen.add(screenshot.id);
	}
	return next;
};

import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { PermissionCard } from "./permission-card.tsx";
import { QuestionCard } from "./question-card.tsx";
import { MODE_META, MODES_ORDER } from "./runtime-mode-meta.ts";

const MIN_HEIGHT = 44;
const MAX_HEIGHT = 240;
const MAX_ATTACHMENTS_PER_TURN = 20;

export function ChatComposer({
	session,
	onDraftSubmit,
	composerDraftKey,
	headerSlot,
	constrain = true,
	directoryUnavailable = false,
	submitDisabled = false,
	environmentId,
}: {
	session: Session;
	environmentId: EnvironmentId;
	composerDraftKey?: string;
	constrain?: boolean;
	directoryUnavailable?: boolean;
	/** Disable sending while keeping the editor interactive and mounted. */
	submitDisabled?: boolean;
	/**
	 * Optional content rendered as a header row inside the composer frame, above
	 * the editor. Used by the new-chat landing to host the "Create from…" picker
	 * (draft mode only). Non-draft composers pass nothing.
	 */
	headerSlot?: ReactNode;
	/**
	 * When set, the composer runs in "draft" mode for the new-chat landing:
	 * `session` is a synthetic draft (see `sessions.beginDraft`) with no real
	 * server row. Submit routes here instead of send/queue so the landing can
	 * create the worktree + chat on first send; session-state trays (queue,
	 * plan, annotations, context, location, workspace) are hidden; and the
	 * permission-hydration polling is skipped (there's nothing to hydrate). The
	 * model/runtime/permission/provider toggles still work — their store setters
	 * route to the draft slot — so the user's picks carry into `create()`.
	 */
	onDraftSubmit?: (
		input: ComposerInput,
		opts: {
			readonly asGoal: boolean;
			readonly pendingAttachments: ReadonlyArray<PendingDraftAttachment>;
			readonly pendingContextFiles: ReadonlyArray<PendingDraftContextFile>;
		},
	) => void;
}) {
	const sessionId: SessionId = session.id;
	const qualifiedEnvironmentId = environmentId;
	const draftKey =
		composerDraftKey ??
		composerDraftKeyForSession({
			environmentId: qualifiedEnvironmentId,
			sessionId,
		});
	const isDraft = onDraftSubmit !== undefined;
	const creationInProgress = useChatsStore((state) =>
		session.chatId === null
			? false
			: state.pendingCreationByChat[session.chatId] !== undefined,
	);
	const [reasoningLevel, setReasoningLevel] = useState<string | null>(null);
	// Provider features the installed CLI supports (from the availability
	// probe). Codex goal mode is version-gated; Grok advertises it natively.
	const capabilities = useProvidersStore((s) =>
		s.capabilitiesFor(session.providerId, qualifiedEnvironmentId),
	);
	const composerCatalog = useModelCatalogStore((s) => s.catalog);
	const goalCapable =
		session.providerId === "grok" ||
		(session.providerId === "codex" && capabilities.includes("goalMode"));
	const timeline = useRendererSessionTimeline(
		sessionId,
		isDraft ? "cache-only" : "connect",
		qualifiedEnvironmentId,
	);
	// Catalog placeholders describe launch intent. Only the session timeline
	// knows which access mode the runtime actually applied (also across devices).
	const appliedRuntimeMode = isDraft
		? session.runtimeMode
		: (timeline.projection?.runtimeMode ?? session.runtimeMode);
	const runtimeModePending = timeline.view.pendingCommands.some(
		(command) => command.kind === "session.setRuntimeMode",
	);
	const goalRef = useMemo(
		() => ({ environmentId: qualifiedEnvironmentId, sessionId }),
		[qualifiedEnvironmentId, sessionId],
	);
	const goalView = useSessionGoalResource(
		isDraft || !goalCapable ? null : goalRef,
		isDraft ? "cache-only" : "connect",
	);
	const runtimeState = timeline.runtime;
	const cloudSummary = useCloudChatSummaryForSelection({
		chatId: session.chatId,
		sessionId,
	});
	const isCloudSession = cloudSummary !== null;
	const cloudShell = useEnvironmentShellResource(
		cloudSummary === null ? null : qualifiedEnvironmentId,
		"cache-only",
	);
	const cloudActivity =
		cloudSummary === null
			? null
			: deriveCloudChatActivity({
					summary: cloudSummary,
					connection: cloudShell.connection,
					runtime: runtimeState,
				});
	const turnStartPending = hasPendingTurnStart(timeline.view.pendingCommands);
	const durableCloudSendPending =
		isCloudSession &&
		cloudComposerSubmissionBlocked(timeline.view.pendingCommands);
	const interrupting =
		cloudActivity === null
			? runtimeState === "stopping"
			: cloudActivity === "stopping";
	const inFlight =
		cloudActivity === null
			? runtimeState === "running" ||
				runtimeState === "stopping" ||
				(isCloudSession && runtimeState === "starting") ||
				turnStartPending
			: cloudChatShowsWorking(cloudActivity) || turnStartPending;
	// Existing queued work still owns ordering. A merely sleeping cloud runtime
	// does not: its next message can go straight to the durable mailbox.
	const hasQueued = (timeline.projection?.queue.items.length ?? 0) > 0;
	const goal = goalView.data?.goal ?? null;
	const respondToPlan = useSessionsStore((s) => s.respondToPlan);
	const send = (
		input: string | ComposerInput,
		options?: { readonly asGoal?: boolean },
	) =>
		sendSessionMessage(goalRef, input, {
			...options,
			providerId: session.providerId,
		});
	const platformOnline = usePlatformOnline();
	// A message queued while offline must wait for the network. The server has
	// no connectivity signal, so its immediate flush is suppressed here and the
	// held queue drains through the shared online-edge recovery.
	const queue = (input: ComposerInput) =>
		queueSessionMessage(goalRef, input, {
			providerId: session.providerId,
			...(platformOnline ? {} : { flush: false }),
		});
	const saveComposerDraft = useComposerDraftsStore((s) => s.save);
	const clearComposerDraft = useComposerDraftsStore((s) => s.clear);

	// Pending AskUserQuestion takes over the composer slot — that's where
	// the user types anyway, and floating it inline above the chat
	// crowded the timeline. Swap to QuestionCard while one is unanswered;
	// otherwise render the normal editor.
	//
	const sessionMessages = timeline.messages;
	const pendingQuestion = useMemo(() => {
		const list = sessionMessages ?? [];
		const answered = new Set<string>();
		for (const m of list) {
			if (m.content._tag === "user_question_answer") {
				answered.add(m.content.itemId as string);
			}
		}
		for (let i = list.length - 1; i >= 0; i--) {
			const m = list[i]!;
			if (
				m.content._tag === "user_question" &&
				!answered.has(m.content.itemId as string)
			) {
				return {
					itemId: m.content.itemId,
					questions: m.content.questions,
				};
			}
		}
		return null;
	}, [sessionMessages]);

	// Pending permission requests also take over the composer slot. Same
	// motivation as AskUserQuestion: the user's eyes are already on the
	// composer, so put the decision there. Permissions outrank questions
	// because the agent is already mid-tool-call.
	const requestsById =
		useEnvironmentPermissions(qualifiedEnvironmentId).data?.requestsById ??
		EMPTY_PERMISSION_REQUESTS;
	const decidePermission = (
		requestId: string,
		decision: Parameters<typeof decideEnvironmentPermission>[1],
	) => decideEnvironmentPermission(requestId, decision, qualifiedEnvironmentId);
	const pendingPermissions = useMemo(() => {
		const out: PermissionRequest[] = [];
		for (const req of Object.values(requestsById)) {
			if (req.sessionId !== sessionId) continue;
			// ExitPlanMode is approved on the plan card itself.
			if (
				req.recoveryState !== "expired" &&
				req.kind._tag === "Other" &&
				req.kind.tool === "ExitPlanMode"
			) {
				continue;
			}
			out.push(req);
		}
		out.sort(
			(a, b) =>
				Number(a.recoveryState === "expired") -
					Number(b.recoveryState === "expired") ||
				a.requestedAt.getTime() - b.requestedAt.getTime(),
		);
		return out;
	}, [requestsById, sessionId]);
	const pendingPlanApprovalRequest = useMemo(
		() =>
			findPendingPlanApprovalRequest(Object.values(requestsById), sessionId),
		[requestsById, sessionId],
	);
	const pendingNativePlanApproval = useMemo(
		() =>
			pendingPlanApprovalRequest === null
				? findPendingNativePlanApproval(sessionMessages ?? [])
				: null,
		[pendingPlanApprovalRequest, sessionMessages],
	);
	const usesEmulatedPlanMode = providerUsesEmulatedPlanMode(session.providerId);
	const sendPlanFeedbackNow = useMemo(
		() =>
			pendingNativePlanApproval !== null ||
			shouldSendPlanFeedbackNow({
				permissionMode: session.permissionMode,
				messages: sessionMessages ?? [],
				pendingPlanApprovalRequest,
				usesEmulatedPlanMode,
				isRunning: inFlight,
			}),
		[
			pendingPlanApprovalRequest,
			pendingNativePlanApproval,
			session.permissionMode,
			sessionMessages,
			usesEmulatedPlanMode,
			inFlight,
		],
	);
	const emulatedPlanReady = useMemo(
		() =>
			hasEmulatedPlanAwaitingAction({
				permissionMode: session.permissionMode,
				messages: sessionMessages ?? [],
				pendingPlanApprovalRequest,
				usesEmulatedPlanMode,
				isRunning: inFlight,
			}),
		[
			pendingPlanApprovalRequest,
			session.permissionMode,
			sessionMessages,
			usesEmulatedPlanMode,
			inFlight,
		],
	);
	const headPermission = pendingPermissions[0];

	const [hasText, setHasText] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const hasTextRef = useRef(false);
	const [uploadingAttachmentCount, setUploadingAttachmentCount] = useState(0);
	const [goalSendMode, setGoalSendMode] = useState(false);
	const [editingQueuedItem, setEditingQueuedItem] =
		useState<QueuedMessage | null>(null);
	const editingQueuedItemRef = useRef<QueuedMessage | null>(null);
	const pickingQueuedItemRef = useRef(false);
	const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const editorHostRef = useRef<HTMLDivElement | null>(null);
	const editorViewRef = useRef<EditorView | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);
	const uploadOne = uploadAttachment;
	const hydrateDraftSkills = useSessionsStore((s) => s.loadDraftSkills);
	const pendingDraftAttachmentsRef = useRef<PendingDraftAttachment[]>([]);
	const pendingDraftContextFilesRef = useRef<PendingDraftContextFile[]>([]);
	// Submit reads through a ref so the keymap, captured at editor creation
	// time, always sees the current sessionId / send / inFlight without
	// recreating the editor on every render.
	const submitRef = useRef<() => boolean>(() => false);
	// Same indirection for file drops — the editor extension is bound once
	// and we want it to call the latest closure with the current sessionId.
	const filesDroppedRef = useRef<(files: ReadonlyArray<File>) => void>(
		() => undefined,
	);
	// Same indirection for large text pastes. Returns whether the paste was
	// consumed (diverted to a `.context/files` file chip) so CodeMirror knows
	// to skip its default insert.
	const textPastedRef = useRef<(text: string) => boolean>(() => false);
	// Same pattern for the Shift+Tab plan-mode toggle. Latest session +
	// mode without reconstructing the editor on every state change.
	const togglePlanModeRef = useRef<() => void>(() => undefined);

	const setModel = useSessionsStore((s) => s.setModel);
	const setRuntimeMode = useSessionsStore((s) => s.setRuntimeMode);
	const setPermissionMode = useSessionsStore((s) => s.setPermissionMode);
	const revealPanelForChat = useUiStore((s) => s.revealPanelForChat);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const workspaceRoot = useActiveWorkspaceRoot(session.projectId);
	const workspaceRootRef = useRef(workspaceRoot);
	workspaceRootRef.current = workspaceRoot;
	// Image chip metadata by attachment id, remembered across cut/paste so a
	// pasted `[image:<id>]` token can rehydrate into its chip (thumbnail and
	// all) even though the cut removed it from the document.
	const knownImageChipMetaRef = useRef(new Map<string, ChipMeta>());
	const annotationCount = useAnnotationsStore(
		(s) => (s.bySession[sessionId] ?? []).length,
	);

	useEffect(() => {
		if (!isDraft) return;
		void hydrateDraftSkills(session.projectId, session.providerId);
	}, [hydrateDraftSkills, isDraft, session.projectId, session.providerId]);

	// Stacked annotations are a valid message on their own, so they enable Send
	// even with an empty text box.
	const canSend =
		!directoryUnavailable &&
		!submitDisabled &&
		!submitting &&
		!durableCloudSendPending &&
		uploadingAttachmentCount === 0 &&
		(hasText || annotationCount > 0);

	// Mount the CodeMirror view once per ChatComposer instance. The parent keys
	// live chat composers by session id, and the landing keys them by project id,
	// so the initial snapshot below is the right one for the lifetime of this
	// editor view.
	useEffect(() => {
		const host = editorHostRef.current;
		if (host === null) return;
		const initialSnapshot =
			useComposerDraftsStore.getState().draftsByKey[draftKey] ?? null;
		const draftWriter = makeCoalescedWriter<EditorView["state"]>(
			(state) => {
				saveComposerDraft(draftKey, {
					doc: state.doc.toString(),
					chips: allChips(state),
				});
			},
			{
				schedule: (run) => window.setTimeout(run, 120),
				cancel: (handle) => window.clearTimeout(handle as number),
			},
		);

		const callbacks = {
			onSubmit: () => submitRef.current(),
			onChange: (doc: string) => {
				const next = doc.trim().length > 0;
				if (hasTextRef.current === next) return;
				hasTextRef.current = next;
				setHasText(next);
			},
			onSnapshotChange: (state: EditorView["state"]) => {
				// Remember image chip metadata so a later paste of the token can
				// rebuild the chip after a cut removed it from the doc.
				for (const chip of allChips(state)) {
					if (chip.meta.kind === "image") {
						knownImageChipMetaRef.current.set(chip.meta.id, chip.meta);
					}
				}
				draftWriter.schedule(state);
			},
			onTrigger: (t: ActiveTrigger | null) => setTrigger(t),
			onFilesDropped: (files: ReadonlyArray<File>) =>
				filesDroppedRef.current(files),
			onTextPaste: (text: string) => textPastedRef.current(text),
			onTogglePlanMode: () => togglePlanModeRef.current(),
		};
		const view = createComposerView({
			parent: host,
			initialDoc: initialSnapshot?.doc ?? "",
			placeholderText:
				"Ask to make changes at the @ mentioned files or run slash commands, shift enter for next line.",
			callbacks,
			resolveChipToken: (token) => {
				if (token.startsWith("@")) {
					const relPath = token.slice(1);
					if (relPath.length === 0) return null;
					const root = workspaceRootRef.current;
					return {
						kind: "file",
						relPath,
						absPath: root !== null ? `${root}/${relPath}` : relPath,
						entryKind: relPath.endsWith("/") ? "directory" : "file",
					};
				}
				if (token.startsWith("[image:") && token.endsWith("]")) {
					const id = token.slice("[image:".length, -1);
					return knownImageChipMetaRef.current.get(id) ?? null;
				}
				return null;
			},
		});
		if (initialSnapshot !== null) {
			restoreComposerChips(view, initialSnapshot.chips);
			const restoredHasText = view.state.doc.toString().trim().length > 0;
			hasTextRef.current = restoredHasText;
			setHasText(restoredHasText);
		}
		editorViewRef.current = view;
		view.focus();

		// Live-reconfigure the composer keymap when the user edits keybindings.
		// The compartment swap is a single CodeMirror transaction, so the
		// cursor / selection / pending text are preserved.
		const unsubKeybindings = subscribeKeybindings(() => {
			reconfigureComposerKeymap(view, callbacks);
		});

		// Register imperative entrypoints on the composer bridge so the file tree
		// (and the top-bar workflow buttons) can drop chips / text into this view
		// without prop-drilling the EditorView ref.
		const bridge = useComposerBridge.getState();
		bridge.setAttachFile((ref) => {
			const v = editorViewRef.current;
			if (v === null) return;
			const sel = v.state.selection.main;
			const token = `@${ref.relPath}`;
			replaceWithChip(v, sel.head, sel.head, token, {
				kind: "file",
				relPath: ref.relPath,
				absPath: ref.absPath,
				entryKind: ref.kind,
			});
		});
		bridge.setInsertText((text) => {
			const v = editorViewRef.current;
			if (v === null) return;
			const sel = v.state.selection.main;
			const insert = text + " ";
			v.dispatch({
				changes: { from: sel.head, to: sel.head, insert },
				selection: { anchor: sel.head + insert.length },
			});
			v.focus();
		});
		bridge.setFocus(() => {
			editorViewRef.current?.focus();
		});
		bridge.setEditQueuedMessage((item) => {
			const v = editorViewRef.current;
			if (v === null || pickingQueuedItemRef.current) return;
			const hasComposerDraft =
				v.state.doc.toString().trim().length > 0 ||
				allChips(v.state).length > 0 ||
				annotationsForSession(sessionId).length > 0;
			if (hasComposerDraft || editingQueuedItemRef.current !== null) {
				toastManager.add({
					type: "info",
					title: "Composer already has a draft",
					description:
						"Send or clear the current draft before editing a queued message.",
				});
				v.focus();
				return;
			}
			pickingQueuedItemRef.current = true;
			void (async () => {
				try {
					const taken = await takeQueuedMessageForEdit(
						goalRef,
						item.id,
						session.providerId,
					);
					if (taken === null) return;
					const activeView = editorViewRef.current;
					if (activeView === null) {
						queueSessionMessage(goalRef, taken.input, {
							queueId: taken.id,
							flush: false,
							providerId: session.providerId,
						});
						return;
					}
					const becameBusy =
						activeView.state.doc.toString().trim().length > 0 ||
						allChips(activeView.state).length > 0 ||
						annotationsForSession(sessionId).length > 0;
					if (becameBusy) {
						queueSessionMessage(goalRef, taken.input, {
							queueId: taken.id,
							flush: false,
							providerId: session.providerId,
						});
						toastManager.add({
							type: "info",
							title: "Composer draft changed",
							description:
								"The queued message was restored so your current draft stays untouched.",
						});
						return;
					}
					const snapshot = composerSnapshotFromInput(taken.input);
					activeView.dispatch({ effects: clearChipsEffect.of() });
					setComposerDoc(activeView, snapshot.doc);
					restoreComposerChips(activeView, snapshot.chips);
					const nextHasText = snapshot.doc.trim().length > 0;
					hasTextRef.current = nextHasText;
					setHasText(nextHasText);
					useAnnotationsStore
						.getState()
						.replace(sessionId, taken.input.annotations ?? []);
					setGoalSendMode(taken.input.asGoal === true);
					editingQueuedItemRef.current = taken;
					setEditingQueuedItem(taken);
					activeView.focus();
				} finally {
					pickingQueuedItemRef.current = false;
				}
			})();
		});
		// Join the pane Tab-walk (F6 / Ctrl+`) so focus can hop into the composer.
		usePaneFocus.getState().register("composer", () => {
			editorViewRef.current?.focus();
		});

		return () => {
			draftWriter.flush();
			unsubKeybindings();
			const b = useComposerBridge.getState();
			b.setAttachFile(null);
			b.setInsertText(null);
			b.setFocus(null);
			b.setEditQueuedMessage(null);
			usePaneFocus.getState().unregister("composer");
			for (const pending of pendingDraftAttachmentsRef.current) {
				if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
			}
			pendingDraftAttachmentsRef.current = [];
			pendingDraftContextFilesRef.current = [];
			view.destroy();
			editorViewRef.current = null;
		};
	}, [draftKey, saveComposerDraft]);

	// Picker-triggered session changes (model / provider) can shift the
	// composer's surrounding layout — chip icon swap, CliUpgradeBanner
	// appearing or disappearing for the new provider, etc. CodeMirror's
	// internal measurement occasionally lags those shifts, leaving the
	// contentDOM mis-sized so typed keystrokes land in state but aren't
	// painted until the editor is forced to re-measure. Forcing it here
	// also returns focus to the editor after the Menu closes, so the user
	// can type immediately without re-clicking into the composer.
	useEffect(() => {
		const view = editorViewRef.current;
		if (view === null) return;
		view.requestMeasure();
		view.focus();
	}, [session.providerId, session.model]);

	const clearComposer = (
		view: EditorView,
		opts?: { readonly clearPendingAttachments?: boolean },
	): void => {
		setComposerDoc(view, "");
		view.dispatch({ effects: clearChipsEffect.of() });
		setHasText(false);
		hasTextRef.current = false;
		setTrigger(null);
		if (opts?.clearPendingAttachments !== false) {
			for (const pending of pendingDraftAttachmentsRef.current) {
				if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
			}
			pendingDraftAttachmentsRef.current = [];
			pendingDraftContextFilesRef.current = [];
		}
	};

	const cancelQueuedEdit = (): void => {
		const item = editingQueuedItemRef.current;
		const view = editorViewRef.current;
		if (item === null || view === null) return;
		clearComposer(view);
		clearComposerDraft(draftKey);
		useAnnotationsStore.getState().clear(sessionId);
		setGoalSendMode(false);
		queueSessionMessage(goalRef, item.input, {
			queueId: item.id,
			flush: false,
			providerId: session.providerId,
		});
		editingQueuedItemRef.current = null;
		setEditingQueuedItem(null);
		view.focus();
	};

	const dispatchBuiltin = (parsed: {
		command: BuiltinCommand;
		args: string;
	}): void => {
		switch (parsed.command.name) {
			case "clear":
				// Editor is already cleared by the caller; nothing else to do.
				break;
			case "model":
				if (parsed.args) {
					void setModel(sessionId, parsed.args, qualifiedEnvironmentId);
				}
				break;
			case "mode":
				if (session.providerId === "cursor") {
					toastManager.add({
						type: "info",
						title: "Sandboxed with auto-review",
						description:
							"This provider uses a fixed local sandbox and does not support interactive permission modes.",
					});
					break;
				}
				if (
					parsed.args === "approval-required" ||
					parsed.args === "auto-accept-edits" ||
					parsed.args === "full-access"
				) {
					void setRuntimeMode(sessionId, parsed.args, qualifiedEnvironmentId);
				}
				break;
			case "plan":
				void setPermissionMode(sessionId, "plan", qualifiedEnvironmentId);
				break;
			case "run":
				void setPermissionMode(sessionId, "default", qualifiedEnvironmentId);
				break;
			case "goal":
				if (parsed.args.length > 0) {
					void send(parsed.args, { asGoal: true });
				} else {
					setGoalSendMode(true);
				}
				break;
			case "diff":
				revealPanelForChat(
					{ environmentId: qualifiedEnvironmentId, chatId: session.chatId },
					"changes",
				);
				break;
			case "copy": {
				const latest = [...sessionMessages]
					.reverse()
					.find(
						(m) =>
							m.content._tag === "assistant" || m.content._tag === "thinking",
					);
				const text =
					latest?.content._tag === "assistant" ||
					latest?.content._tag === "thinking"
						? latest.content.text
						: "";
				if (text.length > 0) void navigator.clipboard?.writeText(text);
				break;
			}
			case "theme":
			case "statusline":
			case "title":
				setView("settings");
				setSettingsSection({ kind: "general" });
				break;
			case "new":
			case "help":
				// `/new` and `/help` are wired in a follow-up — for 0.03 we accept
				// them silently rather than show an error toast that doesn't yet
				// have a destination.
				break;
		}
	};

	/**
	 * Insert chips for `files`. Image files render with a thumbnail; other types
	 * (PDFs, docs, archives) get a generic file-icon chip. The chip's underlying
	 * token swaps from a temp id to a `zuse://attachments/<id>` URL once the
	 * upload resolves. Files beyond the per-turn cap are dropped with a warning.
	 */
	const attachFiles = (files: readonly File[]): void => {
		if (directoryUnavailable) return;
		const view = editorViewRef.current;
		if (view === null || files.length === 0) return;

		const accepted = files.slice(0, MAX_ATTACHMENTS_PER_TURN);
		if (files.length > MAX_ATTACHMENTS_PER_TURN) {
			console.warn(
				`Maximum ${MAX_ATTACHMENTS_PER_TURN} attachments per turn — ${
					files.length - MAX_ATTACHMENTS_PER_TURN
				} file(s) dropped`,
			);
		}

		for (const file of accepted) {
			const tempId = `pending-${Math.random().toString(36).slice(2, 10)}`;
			const isImage = file.type.startsWith("image/");
			const blobUrl = isImage ? URL.createObjectURL(file) : "";
			const token = `[image:${tempId}]`;
			const sel = view.state.selection.main;
			const insertText = token + " ";
			const chipFrom = sel.from;
			const chipTo = sel.from + token.length;

			view.dispatch({
				changes: { from: sel.from, to: sel.to, insert: insertText },
				selection: { anchor: sel.from + insertText.length },
				effects: addChipEffect.of({
					from: chipFrom,
					to: chipTo,
					meta: {
						kind: "image",
						id: tempId,
						mimeType: file.type || "application/octet-stream",
						originalName: file.name,
						previewUrl: blobUrl,
					},
				}),
			});

			if (isDraft) {
				pendingDraftAttachmentsRef.current = [
					...pendingDraftAttachmentsRef.current,
					{ tempId, file, previewUrl: blobUrl },
				];
				continue;
			}

			setUploadingAttachmentCount((count) => count + 1);
			void uploadOne(sessionId, file, workspaceRoot ?? undefined)
				.then((ref) => {
					const finalUrl = isImage ? attachmentUrl(ref.id) : "";
					editorViewRef.current?.dispatch({
						effects: updateImageChipEffect.of({
							previousId: tempId,
							meta: {
								kind: "image",
								id: ref.id,
								mimeType: ref.mimeType,
								originalName: ref.originalName,
								previewUrl: finalUrl,
							},
						}),
					});
				})
				.catch((err) => {
					console.error("[chat-composer] upload failed", err);
					const activeView = editorViewRef.current;
					const chip =
						activeView === null
							? undefined
							: allChips(activeView.state).find(
									(item) =>
										item.meta.kind === "image" && item.meta.id === tempId,
								);
					if (activeView !== null && chip !== undefined) {
						activeView.dispatch({
							changes: { from: chip.from, to: chip.to },
							effects: removeImageChipEffect.of({ id: tempId }),
						});
					}
					toastManager.add({
						type: "error",
						title: "Image upload failed",
						description: "The image was removed. Try attaching it again.",
					});
				})
				.finally(() => {
					if (blobUrl) URL.revokeObjectURL(blobUrl);
					setUploadingAttachmentCount((count) => Math.max(0, count - 1));
				});
		}
	};

	/**
	 * A paste counts as "big" when it spans more than 10 lines or 2,000
	 * characters. Such pastes become a `.context/files/paste-<uuid>.md` file
	 * chip instead of flooding the composer with inline text.
	 */
	const isBigTextPaste = (text: string): boolean =>
		text.split("\n").length > 10 || text.length > 2000;

	/**
	 * Persist a large paste as a workspace file and drop a file chip for it.
	 * Reuses the `@`-file pipeline (`FileRef`), so the agent reads the file
	 * from its cwd. On failure, fall back to inserting the raw text so nothing
	 * the user pasted is ever lost.
	 */
	const attachPastedText = async (text: string): Promise<void> => {
		if (editorViewRef.current === null) return;
		if (isDraft) {
			const tempRelPath = `.context/files/paste-pending-${Math.random()
				.toString(36)
				.slice(2, 10)}.md`;
			pendingDraftContextFilesRef.current = [
				...pendingDraftContextFilesRef.current,
				{ tempRelPath, text, ext: "md" },
			];
			const view = editorViewRef.current;
			const sel = view.state.selection.main;
			replaceWithChip(view, sel.from, sel.to, `@${tempRelPath}`, {
				kind: "file",
				relPath: tempRelPath,
				absPath: tempRelPath,
				entryKind: "file",
			});
			return;
		}
		try {
			const res = await saveContextText({
				environmentId: qualifiedEnvironmentId,
				sessionId,
				text,
				ext: "md",
				...(workspaceRoot ? { rootPath: workspaceRoot } : {}),
			});
			const view = editorViewRef.current;
			if (view === null) return;
			const sel = view.state.selection.main;
			replaceWithChip(view, sel.from, sel.to, `@${res.relPath}`, {
				kind: "file",
				relPath: res.relPath,
				absPath: res.absPath,
				entryKind: "file",
			});
		} catch (err) {
			console.error("[chat-composer] saveText failed", err);
			const view = editorViewRef.current;
			if (view === null) return;
			const sel = view.state.selection.main;
			view.dispatch({
				changes: { from: sel.from, to: sel.to, insert: text },
				selection: { anchor: sel.from + text.length },
			});
		}
	};

	// Paperclip → hidden file input.
	const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files === null) return;
		attachFiles(Array.from(files));
		e.target.value = "";
	};

	// Paste handler — accepts any file type pasted into the composer (images,
	// PDFs, docs, etc.). Large *text* pastes are handled one layer down, inside
	// CodeMirror (`onTextPaste`), because CM inserts pasted text before this
	// React handler runs — see `textPastedRef` / composer.ts.
	const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const it of Array.from(items)) {
			if (it.kind === "file") {
				const f = it.getAsFile();
				if (f) files.push(f);
			}
		}
		if (files.length > 0) {
			e.preventDefault();
			attachFiles(files);
		}
	};

	const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
		if (!e.dataTransfer.types.includes("Files")) return;
		e.preventDefault();
		dragDepthRef.current += 1;
		setIsDragging(true);
	};
	const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		if (e.dataTransfer.types.includes("Files")) {
			// Both calls are required: preventDefault marks the element as a
			// valid drop target, dropEffect tells the OS what cursor to show.
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	};
	const onDragLeave = () => {
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) setIsDragging(false);
	};
	const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		dragDepthRef.current = 0;
		setIsDragging(false);
		const files = Array.from(e.dataTransfer.files);
		if (files.length > 0) attachFiles(files);
	};

	const submit = (): boolean => {
		if (directoryUnavailable || submitting || durableCloudSendPending)
			return false;
		// Don't submit while a popover is open — Enter belongs to the popover.
		if (trigger !== null || modelPickerOpen) return false;
		if (uploadingAttachmentCount > 0) return false;

		const view = editorViewRef.current;
		if (view === null) return false;
		const docText = composerDoc(view).trim();
		const annotations = annotationsForSession(sessionId);
		// Allow a pure-annotation submit (no typed text) — the stacked comments
		// are the message.
		if (docText.length === 0 && annotations.length === 0) return false;

		const builtin = matchBuiltin(docText, session.providerId);
		if (builtin !== null) {
			clearComposer(view);
			clearComposerDraft(draftKey);
			dispatchBuiltin(builtin);
			return true;
		}

		const parsed = parseComposerInput(view.state, session.providerId);
		const input =
			annotations.length > 0
				? ComposerInput.make({
						text: parsed.text,
						attachments: attachmentsWithBrowserAnnotations(
							parsed.attachments,
							annotations,
						),
						fileRefs: parsed.fileRefs,
						skillRefs: parsed.skillRefs,
						annotations,
					})
				: parsed;
		const route =
			onDraftSubmit === undefined
				? chooseComposerSubmitRoute({
						sendPlanFeedbackNow,
						goalSendMode,
						shouldQueue: shouldQueueComposerMessage({
							isCloudSession,
							turnInFlight: inFlight,
							hasQueuedMessage: hasQueued,
							runtimeStarting: !isCloudSession && runtimeState === "starting",
							timelineLive: timeline.view.sync === "live",
							platformOffline: !platformOnline,
						}),
					})
				: null;
		const commitComposerSubmission = () => {
			if (editorViewRef.current === view) {
				clearComposer(view, {
					clearPendingAttachments: onDraftSubmit === undefined,
				});
			}
			clearComposerDraft(draftKey);
			setGoalSendMode(false);
			// Drain the tray only once the input has a durable owner. Before cloud
			// acceptance, it remains the user's recoverable draft.
			useAnnotationsStore.getState().clear(sessionId);
			editingQueuedItemRef.current = null;
			setEditingQueuedItem(null);
		};
		// Draft mode (new-chat landing): hand the input back to the landing, which
		// creates the worktree + chat and queues this as the first message.
		if (onDraftSubmit !== undefined) {
			commitComposerSubmission();
			const pendingDraftAttachments = pendingDraftAttachmentsRef.current;
			const pendingDraftContextFiles = pendingDraftContextFilesRef.current;
			pendingDraftAttachmentsRef.current = [];
			pendingDraftContextFilesRef.current = [];
			onDraftSubmit(input, {
				asGoal: goalSendMode,
				pendingAttachments: pendingDraftAttachments,
				pendingContextFiles: pendingDraftContextFiles,
			});
			return true;
		}
		const sendAndCommitAfterAcceptance = (options?: {
			readonly asGoal?: boolean;
		}) => {
			setSubmitting(true);
			view.contentDOM.blur();
			void commitAcceptedComposerDelivery(
				send(input, options),
				commitComposerSubmission,
			)
				.catch(() => undefined)
				.finally(() => {
					setSubmitting(false);
					editorViewRef.current?.focus();
				});
		};
		switch (route) {
			case "planFeedback":
				commitComposerSubmission();
				void (async () => {
					if (pendingNativePlanApproval !== null) {
						await deliverNativePlanFeedback({
							respond: () =>
								respondToPlan(
									sessionId,
									pendingNativePlanApproval.toolCallId,
									"cancelled",
									docText,
									{
										silent: true,
										environmentId: qualifiedEnvironmentId,
									},
								),
							fallbackSend: () => send(input),
						});
						return;
					}
					if (pendingPlanApprovalRequest !== null) {
						await decidePermission(pendingPlanApprovalRequest.id, {
							_tag: "Deny",
						});
					}
					await send(input);
				})();
				break;
			case "goal":
				sendAndCommitAfterAcceptance({ asGoal: true });
				break;
			case "queue":
				// Mid-turn submit — or a submit while the provider is still coming up
				// — becomes a queue chip; auto-flushed when the turn ends or steered
				// manually.
				commitComposerSubmission();
				queue(
					goalSendMode ? ComposerInput.make({ ...input, asGoal: true }) : input,
				);
				break;
			case "send":
				sendAndCommitAfterAcceptance();
				break;
		}
		return true;
	};

	// Keep the keymap-bound submit pointing at the latest closure so it sees
	// the current sessionId after a session switch / re-render.
	submitRef.current = submit;
	togglePlanModeRef.current = () => {
		void setPermissionMode(
			sessionId,
			session.permissionMode === "plan" ? "default" : "plan",
			qualifiedEnvironmentId,
		);
	};
	filesDroppedRef.current = (files) => {
		// CM's drop handler stops propagation so our React onDrop never fires —
		// clear the drag overlay state here instead.
		dragDepthRef.current = 0;
		setIsDragging(false);
		attachFiles(files);
	};

	textPastedRef.current = (text) => {
		if (!isBigTextPaste(text)) return false;
		void attachPastedText(text);
		return true;
	};

	const inPlanMode = session.permissionMode === "plan";
	const approveEmulatedPlan = () => {
		void (async () => {
			await setPermissionMode(sessionId, "default", qualifiedEnvironmentId);
			await send(EMULATED_PLAN_APPROVAL_PROMPT);
		})();
	};
	const cancelEmulatedPlan = () => {
		void setPermissionMode(sessionId, "default", qualifiedEnvironmentId);
	};
	const inUltracodeMode = reasoningLevel === "ultracode";
	const requestInterrupt = async () => {
		if (interrupting) return;
		await interruptSession(goalRef, session.providerId);
	};
	// Keep the editor mounted at all times. Permissions / questions render as
	// a sibling above it, and we hide the editor block with `display: none`
	// while a card is up. Unmounting the editor branch detaches the CodeMirror
	// view from the DOM, and the view-creation `useEffect` (empty deps) never
	// re-runs to re-attach it — so the host reappears blank: no placeholder,
	// cursor won't land. Staying mounted also preserves any in-progress draft
	// when a permission prompt interrupts mid-typing.
	const showCard = headPermission !== undefined || pendingQuestion !== null;

	return (
		<TooltipProvider delay={0}>
			{showCard ? (
				<div
					className={cn("shrink-0 pb-3 pt-2", constrain ? "px-3" : undefined)}
				>
					<div className={constrain ? "mx-auto w-full max-w-4xl" : "w-full"}>
						{headPermission !== undefined ? (
							<PermissionCard
								key={`${qualifiedEnvironmentId}:${headPermission.id}:${headPermission.recoveryState ?? "live"}`}
								head={headPermission}
								queueSize={pendingPermissions.length}
								environmentId={qualifiedEnvironmentId}
							/>
						) : pendingQuestion !== null ? (
							<QuestionCard
								environmentId={qualifiedEnvironmentId}
								sessionId={sessionId}
								itemId={pendingQuestion.itemId}
								questions={pendingQuestion.questions}
							/>
						) : null}
					</div>
				</div>
			) : null}
			<div
				data-pane="composer"
				className={cn("shrink-0 pb-3 pt-2", constrain ? "px-3" : undefined)}
				style={showCard ? { display: "none" } : undefined}
				aria-hidden={showCard || undefined}
				aria-disabled={directoryUnavailable || undefined}
				inert={directoryUnavailable || undefined}
			>
				<div className={constrain ? "mx-auto w-full max-w-4xl" : "w-full"}>
					{!isDraft ? (
						<AnnotationTray
							sessionId={sessionId}
							folderId={session.projectId}
							worktreeId={session.worktreeId}
						/>
					) : null}
					<div className="relative">
						<div
							className={cn(
								composerTraySurfaceClass,
								"relative z-10 rounded-b-none rounded-t-[1.2rem] empty:hidden",
							)}
						>
							<NoConnectionTray />
							{!isDraft ? (
								<>
									<PlanApprovalTray
										environmentId={qualifiedEnvironmentId}
										sessionId={sessionId}
										emulatedPlanReady={emulatedPlanReady}
										onApproveEmulatedPlan={approveEmulatedPlan}
										onCancelEmulatedPlan={cancelEmulatedPlan}
									/>
									{goalCapable && goal !== null ? (
										<GoalBanner
											goal={goal}
											inPlanMode={inPlanMode}
											onPause={() =>
												void setSessionGoal({
													ref: goalRef,
													goal: {
														status:
															goal.status === "active" ? "paused" : "active",
													},
												}).catch(() => undefined)
											}
											onSave={(objective, tokenBudget) =>
												void setSessionGoal({
													ref: goalRef,
													goal: {
														objective,
														status: "active",
														tokenBudget,
													},
												}).catch(() => undefined)
											}
											onClear={() =>
												void clearSessionGoal({ ref: goalRef }).catch(
													() => undefined,
												)
											}
										/>
									) : null}
									<ContextTray
										environmentId={qualifiedEnvironmentId}
										sessionId={sessionId}
									/>
									{!inPlanMode ? (
										<ProjectPlanTray
											environmentId={qualifiedEnvironmentId}
											key={sessionId}
											sessionId={sessionId}
										/>
									) : null}
									<QueueTray
										environmentId={qualifiedEnvironmentId}
										sessionId={sessionId}
										creationInProgress={creationInProgress}
										waitingForSandbox={
											cloudSummary !== null &&
											cloudWorkspaceIsStarting(cloudSummary)
										}
									/>
								</>
							) : null}
						</div>
						{editingQueuedItem !== null ? (
							<div className="mb-1 flex h-7 items-center justify-between rounded-md bg-muted/35 px-2.5 text-xs text-muted-foreground">
								<span>Editing queued message</span>
								<button
									type="button"
									onClick={cancelQueuedEdit}
									className="rounded px-1.5 py-0.5 text-foreground hover:bg-muted/70"
								>
									Cancel
								</button>
							</div>
						) : null}
						{headerSlot !== undefined ? (
							<div className="composer-attached-toolbar relative z-10 mx-auto flex min-h-8 w-14/15 items-center overflow-x-auto rounded-b-none rounded-t-[1.2rem] px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
								{headerSlot}
							</div>
						) : null}
						<Card
							className={cn(
								"composer-glass rounded-[1.2rem] border-border/70 bg-transparent shadow-overlay-sm transition-colors before:rounded-[calc(1.2rem-1px)] dark:border-white/8",
								goalSendMode
									? "border border-amber-300/55 dark:border-amber-300/40"
									: inPlanMode
										? "border border-rose-300/55 dark:border-rose-300/35"
										: inUltracodeMode
											? "border-2 border-transparent [background:linear-gradient(var(--color-card),var(--color-card))_padding-box,linear-gradient(90deg,#fb7185,#f97316,#facc15,#22c55e,#06b6d4,#8b5cf6,#d946ef)_border-box]"
											: "border-border/50",
							)}
							onDragEnter={onDragEnter}
							onDragOver={onDragOver}
							onDragLeave={onDragLeave}
							onDrop={onDrop}
							onPaste={onPaste}
						>
							{isDragging && (
								<div className="pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-lg border border-dashed border-accent-foreground/40 bg-popover">
									<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
										<HugeiconsIcon icon={Upload01Icon} className="size-3.5" />
										<span>Drop files to attach</span>
									</div>
								</div>
							)}
							<input
								ref={fileInputRef}
								type="file"
								multiple
								hidden
								onChange={onPickFiles}
							/>
							<CardPanel className="relative flex items-stretch gap-2 px-3 pb-2 pt-3">
								{trigger !== null && editorViewRef.current !== null ? (
									trigger.kind === "slash" || trigger.kind === "dollar" ? (
										<SlashCommandPopover
											trigger={trigger}
											view={editorViewRef.current}
											sessionId={sessionId}
											providerId={session.providerId}
											onClose={() => setTrigger(null)}
										/>
									) : (
										<FileTagPopover
											environmentId={qualifiedEnvironmentId}
											trigger={trigger}
											view={editorViewRef.current}
											projectId={session.projectId}
											worktreeId={session.worktreeId}
											workspaceRoot={workspaceRoot}
											onClose={() => setTrigger(null)}
										/>
									)
								) : null}
								{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: CodeMirror owns keyboard semantics; clicking host padding forwards focus to its editor. */}
								<div
									ref={editorHostRef}
									className={cn(
										"flex-1 overflow-y-auto bg-transparent text-sm leading-relaxed outline-none",
										submitting && "pointer-events-none opacity-80",
									)}
									aria-busy={submitting}
									style={{
										minHeight: MIN_HEIGHT,
										maxHeight: MAX_HEIGHT,
									}}
									onClick={() => editorViewRef.current?.focus()}
								/>
								<ComposerChipOverlay
									hostRef={editorHostRef}
									projectId={session.projectId}
									worktreeId={session.worktreeId}
								/>
							</CardPanel>
							{/* One bottom action row. Access and tools lead; the combined
							    model/reasoning control stays beside the send action. */}
							<div className="relative z-10 flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
								<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
									<Tooltip>
										<TooltipTrigger
											render={
												<button
													type="button"
													onClick={() => fileInputRef.current?.click()}
													aria-label="Attach files"
													className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
												>
													<HugeiconsIcon
														icon={AttachmentIcon}
														className="size-3.5"
													/>
												</button>
											}
										/>
										<TooltipPopup>
											Attach files (paste / drop also work)
										</TooltipPopup>
									</Tooltip>
									<RuntimeAccessPicker
										sessionId={sessionId}
										environmentId={qualifiedEnvironmentId}
										providerId={session.providerId}
										current={appliedRuntimeMode}
										pending={runtimeModePending}
										confirmed={isDraft || timeline.projection !== null}
									/>
									{goalCapable ? (
										<GoalModeToggle
											active={goalSendMode}
											hasGoal={goal !== null}
											onClick={() => setGoalSendMode((v) => !v)}
										/>
									) : null}
									{(findModelDescriptor(
										composerCatalog,
										session.providerId,
										session.model,
									)?.supportsPlanMode ??
										true) && (
										<PlanModeToggle
											sessionId={sessionId}
											environmentId={qualifiedEnvironmentId}
											current={session.permissionMode}
										/>
									)}
									<McpPopover
										projectId={session.projectId}
										providerId={session.providerId}
									/>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<ComposerModelPicker
										environmentId={qualifiedEnvironmentId}
										session={session}
										fastModeAvailable={
											findModelDescriptor(
												composerCatalog,
												session.providerId,
												session.model,
											)?.optionDescriptors?.some(
												(d): d is BooleanOptionDescriptor =>
													d.kind === "boolean" && d.id === "fastMode",
											) === true &&
											(session.providerId !== "codex" ||
												capabilities.includes("fastMode"))
										}
										onLevelChange={setReasoningLevel}
										onOpenChange={setModelPickerOpen}
									/>
									{!isDraft ? (
										<ContextStatusPopover
											environmentId={qualifiedEnvironmentId}
											session={session}
										/>
									) : null}
									{sendPlanFeedbackNow && hasText ? (
										<Button
											variant="default"
											size="sm"
											onClick={() => void submit()}
											disabled={!canSend}
											aria-label="Request changes to plan"
										>
											Request changes
										</Button>
									) : inFlight ? (
										<div className="flex items-center gap-1.5">
											{canSend ? (
												<Button
													variant="default"
													size="sm"
													onClick={() => void submit()}
													disabled={!canSend}
													loading={uploadingAttachmentCount > 0}
													aria-label="Add message to queue"
												>
													Queue
												</Button>
											) : null}
											<Tooltip>
												<TooltipTrigger
													render={
														<Button
															variant="outline"
															size="icon-sm"
															onClick={() => void requestInterrupt()}
															disabled={interrupting}
															loading={interrupting}
															aria-label={
																interrupting
																	? "Stopping current turn"
																	: "Stop current turn"
															}
														>
															<HugeiconsIcon
																icon={SquareIcon}
																className="size-3.5"
															/>
														</Button>
													}
												/>
												<TooltipPopup>
													{interrupting ? "Stopping…" : "Stop current turn"}
												</TooltipPopup>
											</Tooltip>
										</div>
									) : (
										<Tooltip>
											<TooltipTrigger
												render={
													<DitherButton
														variant="gradient"
														className="size-6 border border-primary/40 text-white"
														onClick={() => void submit()}
														disabled={!canSend || uploadingAttachmentCount > 0}
														aria-disabled={
															uploadingAttachmentCount > 0 || undefined
														}
														aria-label={
															uploadingAttachmentCount > 0
																? "Uploading image"
																: "Send"
														}
													>
														{uploadingAttachmentCount > 0 ? (
															<Spinner className="size-3.5" />
														) : (
															<HugeiconsIcon
																icon={SentIcon}
																className="size-3.5"
															/>
														)}
													</DitherButton>
												}
											/>
											<TooltipPopup>
												{uploadingAttachmentCount > 0
													? "Uploading image…"
													: "Send (Enter)"}
											</TooltipPopup>
										</Tooltip>
									)}
								</div>
							</div>
						</Card>
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}

function RuntimeAccessPicker({
	sessionId,
	environmentId,
	providerId,
	current,
	pending,
	confirmed,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	providerId: ProviderId;
	current: RuntimeMode;
	pending: boolean;
	confirmed: boolean;
}) {
	const setRuntimeMode = useSessionsStore((state) => state.setRuntimeMode);
	const meta = MODE_META[current];
	const fixedSandbox = providerId === "cursor";
	const highlighted = confirmed && current === "full-access";

	return (
		<Menu>
			<MenuTrigger
				disabled={fixedSandbox || pending}
				aria-label={
					fixedSandbox ? "Cursor uses fixed sandbox access" : "Agent access"
				}
				className={cn(
					"flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors hover:bg-muted/60 data-[popup-open]:bg-muted/70 disabled:cursor-default disabled:opacity-60",
					highlighted
						? "text-warning"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				<HugeiconsIcon icon={meta.Icon} className="size-3.5" />
				<span>
					{fixedSandbox
						? "Sandboxed"
						: confirmed
							? meta.label
							: "Checking access…"}
				</span>
				{pending ? (
					<span role="status" aria-live="polite">
						Updating…
					</span>
				) : null}
				{fixedSandbox ? null : <ChevronDown className="size-3 opacity-60" />}
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-64 p-1">
				<div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Agent access
				</div>
				<MenuRadioGroup
					value={current}
					onValueChange={(value) =>
						void setRuntimeMode(sessionId, value as RuntimeMode, environmentId)
					}
				>
					{MODES_ORDER.map((mode) => {
						const option = MODE_META[mode];
						return (
							<MenuRadioItem
								key={mode}
								value={mode}
								className="h-7 px-2 text-xs"
							>
								<span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
									<HugeiconsIcon icon={option.Icon} className="size-3.5" />
									{option.label}
								</span>
							</MenuRadioItem>
						);
					})}
				</MenuRadioGroup>
			</MenuPopup>
		</Menu>
	);
}

/**
 * Claude Fast Mode is a boolean model option, persisted in the same
 * per-session sessionStorage namespace the send path already reads.
 */
function FastModeToggle({
	sessionId,
	environmentId,
	compact = false,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	compact?: boolean;
}) {
	const storageKey = sessionModelOptionStorageKey(
		{ environmentId, sessionId },
		"fastMode",
	);
	const legacyStorageKey = `memoize.modelOptions.${sessionId}.fastMode`;
	const [enabled, setEnabled] = useState(() => {
		if (typeof window === "undefined") return false;
		return (
			readStorageWithLegacy(window.sessionStorage, storageKey, [
				legacyStorageKey,
			]) === "true"
		);
	});
	useEffect(() => {
		if (typeof window === "undefined") {
			setEnabled(false);
			return;
		}
		setEnabled(
			readStorageWithLegacy(window.sessionStorage, storageKey, [
				legacyStorageKey,
			]) === "true",
		);
	}, [legacyStorageKey, storageKey]);

	const onClick = () => {
		const next = !enabled;
		setEnabled(next);
		if (typeof window !== "undefined") {
			if (next) {
				window.sessionStorage.setItem(storageKey, "true");
			} else {
				window.sessionStorage.removeItem(storageKey);
				window.sessionStorage.removeItem(legacyStorageKey);
			}
		}
	};

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={enabled ? "Disable fast mode" : "Enable fast mode"}
						aria-pressed={enabled}
						className={cn(
							compact
								? "flex size-7 items-center justify-center rounded-md transition-colors"
								: "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
							enabled
								? "bg-amber-400/20 text-amber-700 hover:bg-amber-400/30 dark:bg-amber-300/15 dark:text-amber-200 dark:hover:bg-amber-300/25"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={FlashIcon} className="size-3.5" />
						{enabled && !compact ? <span>Fast</span> : null}
					</button>
				}
			/>
			<TooltipPopup className={compact ? "space-y-0.5" : undefined}>
				{compact ? (
					<>
						<div>1.5× speed</div>
						<div className="text-muted-foreground">More usage</div>
					</>
				) : enabled ? (
					"Disable Claude fast mode"
				) : (
					"Enable Claude fast mode"
				)}
			</TooltipPopup>
		</Tooltip>
	);
}

/**
 * Binary plan-mode toggle. Off → just the map icon (tooltip explains).
 * On → map icon + "Plan" label with a peach accent so it pops next to
 * the other small chips. `Shift+Tab` from the composer flips the same
 * toggle. The runtime-mode (Supervised / Auto-accept / Full access)
 * chip on the right cluster is independent — plan mode is its own axis.
 */
function PlanModeToggle({
	sessionId,
	environmentId,
	current,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	current: PermissionMode;
}) {
	const setPermissionMode = useSessionsStore((s) => s.setPermissionMode);
	const isPlan = current === "plan";

	// Toggle is binary: pressing flips between `default` and `plan`. The
	// wider mode space (`acceptEdits`) lives on the runtime-mode chip — a
	// user wanting auto-accept-edits goes there, not here.
	const onClick = () => {
		void setPermissionMode(
			sessionId,
			isPlan ? "default" : "plan",
			environmentId,
		);
	};

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={isPlan ? "Exit plan mode" : "Enter plan mode"}
						aria-pressed={isPlan}
						className={cn(
							"flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
							isPlan
								? "bg-rose-400/20 text-rose-700 hover:bg-rose-400/30 dark:bg-rose-300/15 dark:text-rose-200 dark:hover:bg-rose-300/25"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={MapsIcon} className="size-3.5" />
						{isPlan ? <span>Plan</span> : null}
					</button>
				}
			/>
			<TooltipPopup>
				{isPlan ? "Exit plan mode" : "Enter plan mode"}
				<span className="ml-2 opacity-60">⇧Tab</span>
			</TooltipPopup>
		</Tooltip>
	);
}

function GoalModeToggle({
	active,
	hasGoal,
	onClick,
}: {
	active: boolean;
	hasGoal: boolean;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={active ? "Send next message as goal" : "Set goal"}
						aria-pressed={active}
						className={cn(
							"flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
							active
								? "bg-amber-400/20 text-amber-700 hover:bg-amber-400/30 dark:bg-amber-300/15 dark:text-amber-200 dark:hover:bg-amber-300/25"
								: hasGoal
									? "text-amber-700 hover:bg-muted/60 dark:text-amber-200"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />
						{active ? <span>Goal</span> : null}
					</button>
				}
			/>
			<TooltipPopup>
				{active ? "Next send sets a goal" : "Send next message as goal"}
			</TooltipPopup>
		</Tooltip>
	);
}

const GOAL_LABEL: Record<ThreadGoal["status"], string> = {
	active: "Pursuing goal",
	paused: "Goal paused",
	budgetLimited: "Goal budget reached",
	usageLimited: "Goal usage limited",
	blocked: "Goal blocked",
	complete: "Goal complete",
};

function GoalBanner({
	goal,
	inPlanMode,
	onPause,
	onSave,
	onClear,
}: {
	goal: ThreadGoal;
	inPlanMode: boolean;
	onPause: () => void;
	onSave: (objective: string, tokenBudget: number | null) => void;
	onClear: () => void;
}) {
	const [open, setOpen] = useState(false);
	const objective = goal.objective.trim();
	const elapsed =
		goal.timeUsedSeconds > 0
			? `${Math.floor(goal.timeUsedSeconds / 60)}m ${Math.floor(
					goal.timeUsedSeconds % 60,
				)}s`
			: "0s";
	return (
		<>
			<TrayPill
				flush
				icon={<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />}
				title={GOAL_LABEL[goal.status]}
				subtitle={objective}
				actions={
					<>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={onPause}
										className={trayPillActionClass}
										aria-label={
											goal.status === "active" ? "Pause goal" : "Resume goal"
										}
									>
										<HugeiconsIcon
											icon={goal.status === "active" ? SquareIcon : PlayIcon}
											className="size-3.5"
										/>
									</button>
								}
							/>
							<TooltipPopup>
								{goal.status === "active" ? "Pause goal" : "Resume goal"}
							</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={() => setOpen(true)}
										className={trayPillActionClass}
										aria-label="Edit goal"
									>
										<HugeiconsIcon icon={PencilIcon} className="size-3.5" />
									</button>
								}
							/>
							<TooltipPopup>Edit goal</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={onClear}
										className={cn(
											trayPillActionClass,
											"hover:bg-destructive/10 hover:text-destructive",
										)}
										aria-label="Delete goal"
									>
										<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
									</button>
								}
							/>
							<TooltipPopup>Delete goal</TooltipPopup>
						</Tooltip>
					</>
				}
			/>
			{inPlanMode && goal.status === "active" ? (
				<TrayPill
					flush
					tone="warning"
					icon={
						<HugeiconsIcon icon={InformationCircleIcon} className="size-3.5" />
					}
					title="Plan mode active"
					subtitle="Codex won't continue this goal until plan mode exits."
				/>
			) : null}
			<GoalEditorDialog
				open={open}
				onOpenChange={setOpen}
				goal={goal}
				elapsed={elapsed}
				onSave={onSave}
			/>
		</>
	);
}

function GoalEditorDialog({
	open,
	onOpenChange,
	goal,
	elapsed,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	goal: ThreadGoal;
	elapsed: string;
	onSave: (objective: string, tokenBudget: number | null) => void;
}) {
	const [objective, setObjective] = useState(goal.objective);
	const [budget, setBudget] = useState(
		goal.tokenBudget === null ? "" : String(goal.tokenBudget),
	);
	useEffect(() => {
		if (!open) return;
		setObjective(goal.objective);
		setBudget(goal.tokenBudget === null ? "" : String(goal.tokenBudget));
	}, [goal, open]);
	const trimmed = objective.trim();
	const validBudget =
		budget.trim().length === 0 || Number.isFinite(Number(budget));
	const canSave = trimmed.length > 0 && trimmed.length <= 4000 && validBudget;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Edit Goal</DialogTitle>
					<DialogDescription>
						Changing the objective replaces the Codex goal and resets goal
						usage.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-3">
					<Textarea
						value={objective}
						onChange={(event) => setObjective(event.currentTarget.value)}
						maxLength={4000}
						aria-label="Goal objective"
					/>
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>{objective.length}/4000</span>
						<span>
							{goal.tokensUsed.toLocaleString()} tokens · {elapsed}
						</span>
					</div>
					<Input
						nativeInput
						type="number"
						min={1}
						value={budget}
						onChange={(event) => setBudget(event.currentTarget.value)}
						placeholder="Token budget"
						aria-label="Token budget"
					/>
				</DialogPanel>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={!canSave}
						onClick={() => {
							onSave(
								trimmed,
								budget.trim().length === 0 ? null : Number(budget),
							);
							onOpenChange(false);
						}}
					>
						Save Goal
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

/**
 * Reasoning / variant selector. Reads the model's `reasoning` / `effort`
 * SelectOptionDescriptor from the resolved model catalog. For opencode the
 * server folds each model's live variant list into that descriptor, so
 * models like `anthropic/claude-sonnet-4-5` show their actual variants and
 * models without variants render nothing.
 *
 * Selection persists per-session; the messages store reads it back at
 * send time and forwards it as `modelOptions.reasoning` — which the
 * opencode driver in turn translates into the prompt body's `model.variant`.
 */
function ComposerModelPicker({
	environmentId,
	session,
	fastModeAvailable,
	onLevelChange,
	onOpenChange,
}: {
	environmentId: EnvironmentId;
	session: Session;
	fastModeAvailable: boolean;
	onLevelChange?: (level: string | null) => void;
	onOpenChange?: (open: boolean) => void;
}) {
	const sessionId = session.id;
	const providerId = session.providerId;
	const model = session.model;
	const catalog = useModelCatalogStore((s) => s.catalog);

	// Claude's descriptor is keyed `effort` (with tiers up through
	// ultracode); everything else uses `reasoning`.
	const resolved = useMemo((): {
		label: string;
		options: ReadonlyArray<{ id: string; label: string }>;
		defaultId: string;
		descriptorId: string;
	} | null => {
		const descriptor = findModelDescriptor(catalog, providerId, model);
		const selectDescriptor = descriptor?.optionDescriptors?.find(
			(d): d is SelectOptionDescriptor =>
				d.kind === "select" && (d.id === "reasoning" || d.id === "effort"),
		);
		if (selectDescriptor === undefined) return null;
		return {
			label: selectDescriptor.label,
			options: selectDescriptor.options,
			defaultId: selectDescriptor.defaultId ?? "medium",
			descriptorId: selectDescriptor.id,
		};
	}, [catalog, providerId, model]);

	const defaultId = resolved?.defaultId ?? "medium";
	const descriptorId = resolved?.descriptorId ?? "reasoning";
	const storageKey = sessionModelOptionStorageKey(
		{ environmentId, sessionId },
		descriptorId,
	);
	const legacyStorageKey = `memoize.modelOptions.${sessionId}.${descriptorId}`;
	const [level, setLevel] = useState<string>(() => {
		if (typeof window === "undefined") return defaultId;
		const stored = readStorageWithLegacy(window.sessionStorage, storageKey, [
			legacyStorageKey,
		]);
		if (stored !== null) return stored;
		// One-shot legacy migration so users mid-session keep their pick.
		const legacy = readStorageWithLegacy(
			window.sessionStorage,
			`zuse.reasoning.${sessionId}`,
			[`memoize.reasoning.${sessionId}`],
		);
		if (legacy !== null && legacy.length > 0) return legacy;
		return defaultId;
	});

	useEffect(() => {
		if (resolved === null) {
			onLevelChange?.(null);
			return;
		}
		if (!resolved.options.some((o) => o.id === level)) {
			setLevel(defaultId);
			if (typeof window !== "undefined") {
				window.sessionStorage.setItem(storageKey, defaultId);
			}
			onLevelChange?.(defaultId);
			return;
		}
		onLevelChange?.(level);
	}, [defaultId, level, onLevelChange, resolved, storageKey]);

	const modelPickerProps = {
		composer: true,
		environmentId,
		mode: "session" as const,
		sessionId,
		chatId: session.chatId,
		runtimeMode: session.runtimeMode,
		providerId,
		currentModel: model,
		onOpenChange,
	};
	if (resolved === null) return <ModelPicker {...modelPickerProps} />;

	const options = resolved.options;

	const onChange = (next: string) => {
		if (!options.some((o) => o.id === next)) return;
		setLevel(next);
		if (typeof window !== "undefined") {
			window.sessionStorage.setItem(storageKey, next);
		}
	};

	const activeLabel = options.find((o) => o.id === level)?.label ?? level;
	const activeIndex = Math.max(
		0,
		options.findIndex((option) => option.id === level),
	);

	return (
		<ModelPicker
			{...modelPickerProps}
			triggerDetail={activeLabel}
			onOpenChange={onOpenChange}
			optionsPanel={
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs font-medium text-muted-foreground">
							Advanced
						</span>
						{fastModeAvailable ? (
							<FastModeToggle
								compact
								environmentId={environmentId}
								sessionId={sessionId}
							/>
						) : null}
					</div>
					<ReasoningSlider
						label={resolved.label}
						options={options}
						activeIndex={activeIndex}
						onChange={(index) => {
							const option = options[index];
							if (option !== undefined) onChange(option.id);
						}}
					/>
				</div>
			}
		/>
	);
}

function ReasoningSlider({
	label,
	options,
	activeIndex,
	onChange,
}: {
	readonly label: string;
	readonly options: ReadonlyArray<{ id: string; label: string }>;
	readonly activeIndex: number;
	readonly onChange: (index: number) => void;
}) {
	const lastIndex = Math.max(0, options.length - 1);
	const activeLabel = options[activeIndex]?.label ?? "";

	return (
		<div className="relative py-1">
			<Slider
				min={0}
				max={lastIndex}
				step={1}
				value={activeIndex}
				onValueChange={(value) =>
					onChange(Array.isArray(value) ? (value[0] ?? 0) : value)
				}
				aria-label={label}
				aria-valuetext={activeLabel}
				className="relative z-10 [&_[data-slot=slider-control]]:min-w-0 [&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-indicator]]:bg-[hsl(83_100%_50%)] [&_[data-slot=slider-thumb]]:!size-6 [&_[data-slot=slider-thumb]]:border-[hsl(83_100%_50%)] [&_[data-slot=slider-thumb]]:shadow-[0_0_0_3px_hsl(83_100%_50%/0.12)]"
			/>
			<div className="pointer-events-none absolute inset-x-2 top-1/2 z-20 -translate-y-1/2">
				{options.slice(1, -1).map((option, index) => (
					<span
						key={option.id}
						className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/65"
						style={{ left: `${((index + 1) / lastIndex) * 100}%` }}
					/>
				))}
			</div>
		</div>
	);
}

const contextWindowTokensFromId = (id: string | undefined): number | null => {
	switch (id?.toLowerCase()) {
		case "200k":
			return 200_000;
		case "1m":
			return 1_000_000;
		default:
			return null;
	}
};

const descriptorContextWindowTokens = (
	providerId: ProviderId,
	model: string,
): number | null => {
	const descriptor = findModelDescriptor(
		currentModelCatalog(),
		providerId,
		model,
	);
	const contextDescriptor = descriptor?.optionDescriptors?.find(
		(d): d is SelectOptionDescriptor =>
			d.kind === "select" && d.id === "contextWindow",
	);
	return contextWindowTokensFromId(contextDescriptor?.defaultId);
};

/**
 * Best-known context window for a session before Claude/Codex report the
 * exact number — the user's selected window if any, else the model's
 * default. This is a real capacity (not a fabricated usage figure), so the
 * control can stay visible from the first message.
 */
const selectedContextWindowTokens = (
	environmentId: EnvironmentId,
	sessionId: SessionId,
	providerId: ProviderId,
	model: string,
): number | null => {
	if (typeof window === "undefined") {
		return descriptorContextWindowTokens(providerId, model);
	}
	const stored = readStorageWithLegacy(
		window.sessionStorage,
		sessionModelOptionStorageKey({ environmentId, sessionId }, "contextWindow"),
		[
			`zuse.modelOptions.${sessionId}.contextWindow`,
			`memoize.modelOptions.${sessionId}.contextWindow`,
		],
	);
	return (
		contextWindowTokensFromId(stored ?? undefined) ??
		descriptorContextWindowTokens(providerId, model)
	);
};

const formatTokens = (value: number): string => {
	const formatted = formatCompactNumber(value);
	return formatted.endsWith("m") || formatted.endsWith("k")
		? formatted
		: `${formatted}`;
};

/**
 * Mini donut gauge for the composer status trigger. The faint track is the
 * full window; the bright arc fills clockwise from the top with the percent
 * of context used. `percent === null` (no usage reported yet) shows just the
 * track. Inherits `currentColor`, so it turns amber when the button does.
 */
function ContextRing({ percent }: { percent: number | null }) {
	const r = 6;
	const circumference = 2 * Math.PI * r;
	const clamped = Math.min(Math.max(percent ?? 0, 0), 100);
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			className="size-3.5 -rotate-90"
			aria-hidden="true"
		>
			<circle
				cx="8"
				cy="8"
				r={r}
				stroke="currentColor"
				strokeWidth="2"
				className="opacity-25"
			/>
			{percent !== null ? (
				<circle
					cx="8"
					cy="8"
					r={r}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - clamped / 100)}
					className="transition-[stroke-dashoffset]"
				/>
			) : null}
		</svg>
	);
}

function ContextStatusPopover({
	session,
	environmentId,
}: {
	session: Session;
	environmentId: EnvironmentId;
}) {
	const { messages } = useRendererSessionTimeline(
		session.id,
		"connect",
		environmentId,
	);

	const latestContext = useMemo(() => {
		let latestUsage: Extract<
			Message["content"],
			{ _tag: "context_usage" }
		> | null = null;
		let latestUsageIndex = -1;
		let latestCompact: Extract<
			Message["content"],
			{ _tag: "context_compaction" }
		> | null = null;
		let latestCompactIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i]!.content;
			if (
				content._tag === "context_usage" &&
				content.providerId === session.providerId
			) {
				latestUsage = content;
				latestUsageIndex = i;
				break;
			}
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i]!.content;
			if (
				content._tag === "context_compaction" &&
				content.providerId === session.providerId &&
				(content.status ?? "completed") === "completed" &&
				content.afterTokens !== null
			) {
				latestCompact = content;
				latestCompactIndex = i;
				break;
			}
		}
		if (latestCompact !== null && latestCompactIndex > latestUsageIndex) {
			return {
				_tag: "context_usage" as const,
				providerId: latestCompact.providerId,
				usedTokens: latestCompact.afterTokens,
				windowTokens: latestUsage?.windowTokens ?? null,
				precision: "exact" as const,
				source: "Context compaction",
			};
		}
		return latestUsage;
	}, [messages, session.providerId]);

	const usageLimits = useMemo(() => {
		const latestByKey = new Map<
			string,
			Extract<Message["content"], { _tag: "usage_limit" }>
		>();
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i]!.content;
			if (
				content._tag === "usage_limit" &&
				content.providerId === session.providerId
			) {
				const key =
					content.windowMinutes !== null
						? `window:${content.windowMinutes}`
						: `label:${content.label}`;
				if (!latestByKey.has(key)) {
					latestByKey.set(key, content);
				}
			}
		}
		return [...latestByKey.values()].reverse();
	}, [messages, session.providerId]);

	const usedTokens = latestContext?.usedTokens ?? null;
	const reportedWindowTokens = latestContext?.windowTokens ?? null;
	const fallbackWindowTokens = selectedContextWindowTokens(
		environmentId,
		session.id,
		session.providerId,
		session.model,
	);
	const windowTokens =
		usedTokens !== null
			? (reportedWindowTokens ?? fallbackWindowTokens)
			: reportedWindowTokens;

	const percent =
		usedTokens !== null && windowTokens !== null && windowTokens > 0
			? Math.min(100, (usedTokens / windowTokens) * 100)
			: null;
	const freeTokens =
		usedTokens !== null && windowTokens !== null
			? Math.max(0, windowTokens - usedTokens)
			: null;

	const hasContext = usedTokens !== null && windowTokens !== null;
	const hasLimits = usageLimits.length > 0;
	if (!hasContext && !hasLimits) return null;

	const high = percent !== null && percent >= 90;
	const headerValue =
		usedTokens !== null && windowTokens !== null
			? `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`
			: windowTokens !== null
				? formatTokens(windowTokens)
				: formatTokens(usedTokens!);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						className={cn(
							"flex h-6 items-center justify-center rounded-md px-2 transition-colors hover:bg-muted/60",
							high
								? "text-amber-400 hover:text-amber-300"
								: "text-muted-foreground hover:text-foreground",
						)}
						aria-label="Context and usage status"
					>
						<ContextRing percent={percent} />
					</button>
				}
			/>
			<TooltipPopup
				side="top"
				align="end"
				sideOffset={8}
				className="w-[300px] overflow-hidden rounded-xl border-border bg-popover p-0 text-[13px] shadow-lg"
			>
				{hasContext ? (
					<div className="flex flex-col gap-3 p-3.5">
						<div className="flex items-baseline justify-between gap-3">
							<span className="font-medium text-foreground">Context</span>
							<span className="tabular-nums text-muted-foreground">
								{headerValue}
							</span>
						</div>
						{percent !== null ? (
							<>
								<StickMeter
									percent={percent}
									tone={high ? "warning" : "default"}
								/>
								<div className="flex items-center justify-between text-muted-foreground">
									<span>Window used</span>
									<span className="tabular-nums">{percent.toFixed(1)}%</span>
								</div>
								<div className="flex items-center justify-between text-muted-foreground/70">
									<span>Available</span>
									{freeTokens !== null ? (
										<span className="tabular-nums">
											{formatTokens(freeTokens)}
										</span>
									) : null}
								</div>
							</>
						) : (
							<div className="text-muted-foreground/70">
								Usage appears after the first response
							</div>
						)}
					</div>
				) : null}
				{hasLimits ? (
					<div
						className={cn(
							"flex flex-col gap-3 p-3.5",
							hasContext && "border-t border-border",
						)}
					>
						{usageLimits.map((limit) => {
							const reset = resetLabel(limit.resetsAt);
							const used = limit.usedPercent;
							const remaining =
								used !== null
									? `${Math.max(0, 100 - used).toFixed(0)}% left`
									: "Active";
							const limitHigh = used !== null && used >= 80;
							return (
								<div
									key={
										limit.windowMinutes !== null
											? `window:${limit.windowMinutes}`
											: `label:${limit.label}`
									}
									className="flex flex-col gap-3"
								>
									<div className="flex items-baseline justify-between gap-3">
										<span className="font-medium text-foreground">
											{limit.label}
										</span>
										<span className="shrink-0 tabular-nums text-muted-foreground">
											{remaining}
										</span>
									</div>
									{used !== null ? (
										<StickMeter
											percent={used}
											tone={limitHigh ? "warning" : "default"}
										/>
									) : null}
									<div className="flex items-center justify-between text-muted-foreground/70">
										<span>Reset</span>
										<span className="tabular-nums">
											{reset !== null ? reset : "unknown"}
										</span>
									</div>
								</div>
							);
						})}
					</div>
				) : null}
			</TooltipPopup>
		</Tooltip>
	);
}
