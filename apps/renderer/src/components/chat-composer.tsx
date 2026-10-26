import { composerFeedbackText } from "@zuse/client-runtime/composer-feedback";
import { composerSendBlocked } from "@zuse/client-runtime/plan-interactions";
import { useCloudMessageQueue } from "../lib/cloud-message-queue.ts";
import { isCloudWorkspaceReady } from "../lib/cloud-workspace-lifecycle.ts";
import { isHostedProduct } from "../lib/hosted-session.ts";
import { GOAL_STATUS_MESSAGE } from "../lib/session-goal-presentation.ts";
import { CloudDeviceSelector } from "./cloud-device-selector.tsx";
import { ComposerAttachmentTray } from "./composer/composer-attachment-tray.tsx";
import { ComposerVoiceButton } from "./composer/composer-voice-button.tsx";
import { SessionSecretRequests } from "./session-secret-requests.tsx";
import "@zuse/i18n/english/common";
import { formatNumber as formatUiNumber } from "@zuse/i18n";
import "@zuse/i18n/english/chat";
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
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	AttachmentIcon,
	DashboardSpeedIcon,
	Delete02Icon,
	FlashIcon,
	InformationCircleIcon,
	MapsIcon,
	PencilEdit01Icon,
	PlayIcon,
	PlusSignIcon,
	SentIcon,
	SquareIcon,
	Tick02Icon,
	Upload01Icon,
} from "@zuse/icons/solid-rounded";
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
	compactMenuItemClass,
	Menu,
	MenuItem,
	MenuPopup,
	MenuShortcut,
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
	setComposerPlaceholder,
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
import { formatError } from "~/lib/format-error.ts";
import {
	chooseComposerSubmitRoute,
	deliverNativePlanFeedback,
	findPendingNativePlanApproval,
	findPendingPlanApprovalRequest,
	hasEmulatedPlanAwaitingAction,
	providerUsesEmulatedPlanMode,
	shouldSendPlanFeedbackNow,
} from "~/lib/plan-feedback-routing";
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
import {
	cachedAttachmentUrl,
	resolveAttachmentUrl,
	uploadAttachment,
} from "../lib/attachments.ts";
import {
	cloudChatShowsWorking,
	deriveCloudChatActivity,
} from "../lib/cloud-chat-activity.ts";
import { useCloudRuntimeUpdating } from "../lib/cloud-runtime-catch-up.ts";
import { useCloudChatSummaryForSelection } from "../lib/cloud-workspaces.ts";
import {
	cloudComposerSubmissionBlocked,
	commitAcceptedComposerDelivery,
	handoffComposerDraft,
	shouldQueueComposerMessage,
	submitComposerDelivery,
	withComposerContext,
} from "../lib/composer-delivery.ts";
import {
	decideEnvironmentPermission,
	useEnvironmentPermissions,
} from "../lib/environment-permissions-client-bus.ts";
import { useEnvironmentQuestionAttachments } from "../lib/environment-question-attachments-client-bus.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { subscribeKeybindings } from "../lib/keybindings-client-bus.ts";
import { usePlatformOnline } from "../lib/network-status.ts";
import {
	findPresentedPermissions,
	type QuestionAttachmentsByKey,
	selectPresentedQuestion,
} from "../lib/question-actionability.ts";
import {
	interruptSession,
	persistQueuedMessage,
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
	EMPTY_COMPOSER_CONTEXTS,
	recoverComposerDraft,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import {
	currentModelCatalog,
	useModelCatalogStore,
} from "../store/model-catalog.ts";
import { usePaneFocus } from "../store/pane-focus.ts";
import { useProvidersStore } from "../store/providers.ts";
import { CloudConnectionNotice } from "./cloud-connection-notice.tsx";
import { ComposerChipOverlay } from "./composer/composer-chip-overlay.tsx";
import { ContextTray } from "./composer/context-tray.tsx";
import { FileTagPopover } from "./composer/file-tag-popover.tsx";
import { NoConnectionTray } from "./composer/no-connection-tray.tsx";
import {
	EMULATED_PLAN_APPROVAL_PROMPT,
	PlanApprovalTray,
} from "./composer/plan-approval-tray.tsx";
import { ProjectPlanTray } from "./composer/project-plan-tray.tsx";
import { ProviderErrorTray } from "./composer/provider-error-tray.tsx";
import { ProviderSignInTray } from "./composer/provider-sign-in-tray.tsx";
import { QuestionTray, useQuestionAnswer } from "./composer/question-tray.tsx";
import { QueueTray } from "./composer/queue-tray.tsx";
import { SlashCommandPopover } from "./composer/slash-command-popover.tsx";
import {
	composerTraySurfaceClass,
	TrayPill,
	trayPillActionClass,
} from "./composer/tray-pill.tsx";

const EMPTY_PERMISSION_REQUESTS: Readonly<Record<string, PermissionRequest>> =
	{};

import { ModelPicker } from "./model-picker.tsx";
import { PluginsPopover } from "./plugins/plugins-popover.tsx";
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

import { useChatDeviceApproval } from "../lib/chat-device-approval.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { DevicePermissionCard } from "./device-permission-card.tsx";
import { PermissionCard } from "./permission-card.tsx";
import { RuntimeAccessPicker } from "./runtime-access-picker.tsx";

const EMPTY_QUESTION_ATTACHMENTS: QuestionAttachmentsByKey = {};

const DEFAULT_COMPOSER_PLACEHOLDER =
	"Ask to make changes at the @ mentioned files or run slash commands, shift enter for next line.";
const MIN_HEIGHT = 44;
/** Built-in commands that change modes the minimal composer doesn't expose. */
const MINIMAL_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
	"mode",
	"plan",
	"run",
	"goal",
]);
const MAX_HEIGHT = 240;
const MAX_ATTACHMENTS_PER_TURN = 20;

export function ChatComposer({
	workspaceRootOverride,
	session,
	onDraftSubmit,
	composerDraftKey,
	headerSlot,
	draftTray,
	projectlessDraft = false,
	constrain = true,
	directoryUnavailable = false,
	submitDisabled = false,
	cloudProviderIds,
	environmentId,
	variant = "full",
	placeholder,
}: {
	workspaceRootOverride?: string;
	/**
	 * `minimal` keeps only attachments, the model picker and send — for
	 * conversations (like a Master's) where access, plan, goal and plugin controls
	 * don't apply.
	 */
	variant?: "full" | "minimal";
	/** Editor placeholder; updates in place without remounting the editor. */
	placeholder?: string;
	session: Session;
	environmentId: EnvironmentId;
	composerDraftKey?: string;
	constrain?: boolean;
	directoryUnavailable?: boolean;

	submitDisabled?: boolean;
	cloudProviderIds?: ReadonlyArray<ProviderId>;

	headerSlot?: ReactNode;

	draftTray?: ReactNode;
	projectlessDraft?: boolean;

	onDraftSubmit?: (
		input: ComposerInput,
		opts: {
			readonly asGoal: boolean;

			readonly accept: () => void;
			readonly pendingAttachments: ReadonlyArray<PendingDraftAttachment>;
			readonly pendingContextFiles: ReadonlyArray<PendingDraftContextFile>;
		},
	) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

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

	const appliedRuntimeMode = isDraft
		? session.runtimeMode
		: (timeline.projection?.runtimeMode ?? session.runtimeMode);
	const runtimeModePending = timeline.view.pendingCommands.some(
		(command) => command.kind === "session.setRuntimeMode",
	);
	const goalRef = useMemo(
		() => ({ environmentId: qualifiedEnvironmentId, sessionId }),
		[qualifiedEnvironmentId, sessionId, uiMessage],
	);

	const tracksGoals =
		session.providerId === "codex" || session.providerId === "grok";
	const goalView = useSessionGoalResource(
		isDraft || !tracksGoals ? null : goalRef,
		isDraft ? "cache-only" : "connect",
	);
	const runtimeState = timeline.runtime;
	const cloudSummary = useCloudChatSummaryForSelection({
		chatId: session.chatId,
		sessionId,
	});
	const isCloudSession = cloudSummary !== null;
	const deviceApproval = useChatDeviceApproval(
		cloudSummary?.workspaceId,
		session.chatId,
	);
	const headDeviceCommand = deviceApproval.commands[0];
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
					timeline: timeline.view,
				});
	const cloudMessageQueue = useCloudMessageQueue(timeline);
	const cloudRuntimeUpdating = useCloudRuntimeUpdating(
		cloudSummary?.workspaceId ?? null,
	);
	const durableCloudSendPending =
		isCloudSession &&
		(cloudRuntimeUpdating ||
			cloudComposerSubmissionBlocked(
				timeline.view.pendingCommands,
				cloudMessageQueue.waiting,
			));
	const interrupting =
		cloudActivity === null
			? runtimeState === "stopping"
			: cloudActivity === "stopping";
	const inFlight =
		cloudActivity === null
			? timeline.presentation.turnInFlight
			: cloudChatShowsWorking(cloudActivity, timeline.view.pendingCommands);

	const hasQueued = (timeline.projection?.queue.items.length ?? 0) > 0;
	const goal = goalView.data?.goal ?? null;
	const pendingGoalCommand = goalView.pendingCommands.find(
		(command) =>
			command.kind === "session.goal.set" ||
			command.kind === "session.goal.clear",
	);
	const pendingGoalAction =
		pendingGoalCommand === undefined
			? null
			: pendingGoalCommand.kind === "session.goal.clear"
				? "clear"
				: "set";
	const reportGoalError = (cause: unknown) => {
		toastManager.add({ type: "error", title: formatError(cause) });
	};
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

	const queue = async (input: ComposerInput) => {
		const options = {
			providerId: session.providerId,
			rejectIfBlocked: true,
			...(platformOnline ? {} : { flush: false }),
		};
		const queueId = queueSessionMessage(goalRef, input, {
			...options,
			persist: false,
			ready: false,
		});
		return persistQueuedMessage(goalRef, queueId, input, options);
	};

	const saveComposerDraft = useComposerDraftsStore((s) => s.save);
	const clearComposerDraft = useComposerDraftsStore((s) => s.clear);

	const sessionMessages = timeline.messages;
	const questionAttachmentsByKey =
		useEnvironmentQuestionAttachments(qualifiedEnvironmentId).data
			?.attachmentsByKey ?? EMPTY_QUESTION_ATTACHMENTS;
	const presentedQuestion = useMemo(
		() =>
			selectPresentedQuestion(
				sessionId,
				timeline.presentation.interactions,
				questionAttachmentsByKey,
			),
		[questionAttachmentsByKey, sessionId, timeline.presentation.interactions],
	);
	const pendingQuestion = presentedQuestion?.question ?? null;
	const questionAnswer = useQuestionAnswer(
		pendingQuestion === null
			? null
			: {
					environmentId: qualifiedEnvironmentId,
					sessionId,
					itemId: pendingQuestion.interaction.id,
					questions: pendingQuestion.interaction.questions,
					disabled: presentedQuestion?.actionable !== true,
					expired: pendingQuestion.interaction.recoveryState === "expired",
					submission: pendingQuestion.submission,
					submissionError: pendingQuestion.error,
				},
	);
	/** An expired question can only be dismissed, so it releases the composer. */
	const answerableQuestion =
		questionAnswer === null || questionAnswer.expired ? null : questionAnswer;
	const answeringQuestion = answerableQuestion !== null;

	const requestsById =
		useEnvironmentPermissions(qualifiedEnvironmentId).data?.requestsById ??
		EMPTY_PERMISSION_REQUESTS;
	const decidePermission = (
		request: Pick<PermissionRequest, "id" | "sessionId">,
		decision: Parameters<typeof decideEnvironmentPermission>[1],
	) => decideEnvironmentPermission(request, decision, qualifiedEnvironmentId);
	const pendingPermissions = useMemo(() => {
		return findPresentedPermissions(
			timeline.presentation.interactions,
			requestsById,
		).filter((item) => {
			const req = item.interaction.request;

			return !(
				req.recoveryState !== "expired" &&
				req.kind._tag === "Other" &&
				req.kind.tool === "ExitPlanMode"
			);
		});
	}, [requestsById, timeline.presentation.interactions]);
	const pendingPlanApprovalRequest = useMemo(
		() =>
			findPendingPlanApprovalRequest(
				timeline.presentation.interactions.flatMap((item) =>
					item.interaction._tag === "Permission" &&
					requestsById[item.interaction.id] !== undefined
						? [item.interaction.request]
						: [],
				),
				sessionId,
			),
		[requestsById, sessionId, timeline.presentation.interactions],
	);
	const pendingNativePlanApproval = useMemo(
		() =>
			pendingPlanApprovalRequest === null
				? findPendingNativePlanApproval(
						sessionMessages ?? [],
						timeline.presentation.interactions.map((i) => i.interaction),
					)
				: null,
		[
			pendingPlanApprovalRequest,
			sessionMessages,
			timeline.presentation.interactions,
			uiMessage,
		],
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
			uiMessage,
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
			uiMessage,
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

	const submitRef = useRef<() => boolean>(() => false);
	const sendTextRef = useRef<(text: string) => Promise<boolean>>(
		async () => false,
	);

	const filesDroppedRef = useRef<(files: ReadonlyArray<File>) => void>(
		() => undefined,
	);

	const textPastedRef = useRef<(text: string) => boolean>(() => false);

	const togglePlanModeRef = useRef<() => void>(() => undefined);

	const setModel = useSessionsStore((s) => s.setModel);
	const setRuntimeMode = useSessionsStore((s) => s.setRuntimeMode);
	const setPermissionMode = useSessionsStore((s) => s.setPermissionMode);
	const revealPanelForChat = useUiStore((s) => s.revealPanelForChat);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const activeWorkspaceRoot = useActiveWorkspaceRoot(session.projectId);
	const workspaceRoot = workspaceRootOverride ?? activeWorkspaceRoot;
	const workspaceRootRef = useRef(workspaceRoot);
	workspaceRootRef.current = workspaceRoot;

	const knownImageChipMetaRef = useRef(new Map<string, ChipMeta>());
	const composerContexts = useComposerDraftsStore(
		(s) => s.contextsByKey[draftKey] ?? EMPTY_COMPOSER_CONTEXTS,
	);
	const annotationCount = useAnnotationsStore(
		(s) => (s.bySession[sessionId] ?? []).length,
	);

	const questionPlaceholder = uiMessage("chat:question_composer_placeholder");
	useEffect(() => {
		const view = editorViewRef.current;
		if (view !== null)
			setComposerPlaceholder(
				view,
				answeringQuestion
					? questionPlaceholder
					: (placeholder ?? DEFAULT_COMPOSER_PLACEHOLDER),
			);
	}, [answeringQuestion, placeholder, questionPlaceholder]);

	useEffect(() => {
		if (
			projectlessDraft ||
			!isDraft ||
			(isHostedProduct() && qualifiedEnvironmentId === "local")
		)
			return;
		void hydrateDraftSkills(session.projectId, session.providerId);
	}, [
		hydrateDraftSkills,
		projectlessDraft,
		isDraft,
		qualifiedEnvironmentId,
		session.projectId,
		session.providerId,
	]);

	const canSend =
		!directoryUnavailable &&
		!submitDisabled &&
		!submitting &&
		!durableCloudSendPending &&
		uploadingAttachmentCount === 0 &&
		(hasText || annotationCount > 0 || composerContexts.length > 0);

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
			placeholderText: placeholder ?? DEFAULT_COMPOSER_PLACEHOLDER,
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

		const unsubKeybindings = subscribeKeybindings(() => {
			reconfigureComposerKeymap(view, callbacks);
		});

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
		}, draftKey);
		bridge.setInsertText((text) => {
			const v = editorViewRef.current;
			if (v === null) return;
			const sel = v.state.selection.main;
			const insert = `${text} `;
			v.dispatch({
				changes: { from: sel.head, to: sel.head, insert },
				selection: { anchor: sel.head + insert.length },
			});
			v.focus();
		});
		bridge.setFocus(() => {
			editorViewRef.current?.focus();
		});
		bridge.setSendText((text) => sendTextRef.current(text));
		bridge.setEditQueuedMessage((item) => {
			const v = editorViewRef.current;
			if (v === null || pickingQueuedItemRef.current) return;
			const hasComposerDraft =
				v.state.doc.toString().trim().length > 0 ||
				allChips(v.state).length > 0 ||
				annotationsForSession(sessionId).length > 0 ||
				(useComposerDraftsStore.getState().contextsByKey[draftKey]?.length ??
					0) > 0;
			if (hasComposerDraft || editingQueuedItemRef.current !== null) {
				toastManager.add({
					type: "info",
					title: uiMessage("chat:chat_composer_composer_already_has_a_draft"),
					description: uiMessage(
						"chat:chat_composer_send_or_clear_the_current_draft_before_editing_a_queued_message",
					),
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
						annotationsForSession(sessionId).length > 0 ||
						(useComposerDraftsStore.getState().contextsByKey[draftKey]
							?.length ?? 0) > 0;
					if (becameBusy) {
						queueSessionMessage(goalRef, taken.input, {
							queueId: taken.id,
							flush: false,
							providerId: session.providerId,
						});
						toastManager.add({
							type: "info",
							title: uiMessage("chat:chat_composer_composer_draft_changed"),
							description: uiMessage(
								"chat:chat_composer_the_queued_message_was_restored_so_your_current_draft_stays_untou",
							),
						});
						return;
					}
					const snapshot = composerSnapshotFromInput(
						taken.input,
						(id) => cachedAttachmentUrl(goalRef, id) ?? "",
					);
					activeView.dispatch({ effects: clearChipsEffect.of() });
					setComposerDoc(activeView, snapshot.doc);
					restoreComposerChips(activeView, snapshot.chips);
					for (const attachment of taken.input.attachments) {
						if (!attachment.mimeType.startsWith("image/")) continue;
						void resolveAttachmentUrl(goalRef, attachment.id)
							.then((src) => {
								if (editorViewRef.current !== activeView) return;
								activeView.dispatch({
									effects: updateImageChipEffect.of({
										previousId: attachment.id,
										meta: { kind: "image", ...attachment, previewUrl: src },
									}),
								});
							})
							.catch(() => undefined);
					}
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

		usePaneFocus.getState().register("composer", () => {
			editorViewRef.current?.focus();
		});

		return () => {
			draftWriter.flush();
			unsubKeybindings();
			const b = useComposerBridge.getState();
			b.setAttachFile(null);
			b.setInsertText(null);
			b.setSendText(null);
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
	}, [draftKey, saveComposerDraft, uiMessage]);

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
		// The minimal composer has no access, plan or goal controls, so it must
		// not enter those modes where the user couldn't see or leave them.
		if (
			variant === "minimal" &&
			MINIMAL_HIDDEN_COMMANDS.has(parsed.command.name)
		)
			return;
		switch (parsed.command.name) {
			case "clear":
				break;
			case "model":
				if (!parsed.args) setModelPickerOpen(true);
				if (parsed.args) {
					void setModel(sessionId, parsed.args, qualifiedEnvironmentId);
				}
				break;
			case "mode":
				if (session.providerId === "pi") break;
				if (session.providerId === "cursor") {
					toastManager.add({
						type: "info",
						title: uiMessage("chat:chat_composer_sandboxed_with_auto_review"),
						description: uiMessage(
							"chat:chat_composer_this_provider_uses_a_fixed_local_sandbox_and_does_not_support_int",
						),
					});
					break;
				}
				if (
					parsed.args === "approval-required" ||
					parsed.args === "auto" ||
					parsed.args === "auto-accept-edits" ||
					parsed.args === "auto-accept-edits-and-bash" ||
					parsed.args === "full-access"
				) {
					void setRuntimeMode(sessionId, parsed.args, qualifiedEnvironmentId);
				}
				break;
			case "plan":
				if (session.providerId === "pi") break;
				void setPermissionMode(sessionId, "plan", qualifiedEnvironmentId);
				break;
			case "run":
				if (session.providerId === "pi") break;
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
				break;
		}
	};

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
			const insertText = `${token} `;
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
			void uploadOne(
				{ environmentId: qualifiedEnvironmentId, sessionId },
				file,
				workspaceRoot ?? undefined,
			)
				.then((ref) => {
					const finalUrl = isImage
						? (cachedAttachmentUrl(
								{ environmentId: qualifiedEnvironmentId, sessionId },
								ref.id,
							) ?? "")
						: "";
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
						title: uiMessage("chat:chat_composer_image_upload_failed"),
						description: uiMessage(
							"chat:chat_composer_the_image_was_removed_try_attaching_it_again",
						),
					});
				})
				.finally(() => {
					if (blobUrl) URL.revokeObjectURL(blobUrl);
					setUploadingAttachmentCount((count) => Math.max(0, count - 1));
				});
		}
	};

	const isBigTextPaste = (text: string): boolean =>
		text.split("\n").length > 10 || text.length > 2000;

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

	const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files === null) return;
		attachFiles(Array.from(files));
		e.target.value = "";
	};

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

	const shouldQueueNow = () =>
		shouldQueueComposerMessage({
			isCloudSession,
			turnInFlight: inFlight,
			hasQueuedMessage: hasQueued,
			runtimeStarting: !isCloudSession && runtimeState === "starting",
			timelineLive: timeline.view.sync === "live",
			platformOffline: !platformOnline,
		});

	/** While a question is pending, the composer text is its free-text answer. */
	const submitQuestionAnswer = (
		answer: NonNullable<typeof answerableQuestion>,
	): boolean => {
		const view = editorViewRef.current;
		if (view === null || trigger !== null || modelPickerOpen) return false;
		const text = composerDoc(view).trim();
		if (!answer.canAnswer(text.length > 0)) return false;
		const submittedDoc = view.state.doc;
		void answer.answer(text).then((consumed) => {
			if (!consumed || text.length === 0) return;
			if (editorViewRef.current !== view || view.state.doc !== submittedDoc)
				return;
			clearComposer(view, { clearPendingAttachments: false });
			clearComposerDraft(draftKey);
		});
		return true;
	};

	const submit = (): boolean => {
		if (answerableQuestion !== null)
			return submitQuestionAnswer(answerableQuestion);
		if (
			composerSendBlocked(timeline.presentation.health, sendPlanFeedbackNow)
		) {
			toastManager.add({
				type: "error",
				title: uiMessage("chat:send_blocked"),
			});
			return false;
		}

		if (
			submitDisabled ||
			directoryUnavailable ||
			submitting ||
			durableCloudSendPending
		)
			return false;

		if (trigger !== null || modelPickerOpen) return false;
		if (uploadingAttachmentCount > 0) return false;

		const view = editorViewRef.current;
		if (view === null) return false;
		const docText = composerDoc(view).trim();
		const annotations = annotationsForSession(sessionId);
		const contexts =
			useComposerDraftsStore.getState().contextsByKey[draftKey] ??
			EMPTY_COMPOSER_CONTEXTS;

		if (
			docText.length === 0 &&
			annotations.length === 0 &&
			contexts.length === 0
		)
			return false;

		const builtin = matchBuiltin(docText, session.providerId);
		if (builtin !== null) {
			clearComposer(view);
			clearComposerDraft(draftKey);
			dispatchBuiltin(builtin);
			return true;
		}

		const submittedDoc = view.state.doc;
		const parsedDraft = parseComposerInput(view.state, session.providerId);
		const parsed = withComposerContext(parsedDraft, contexts);
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
						annotations: [...annotations, ...parsed.annotations],
					})
				: parsed;
		const route =
			onDraftSubmit === undefined
				? chooseComposerSubmitRoute({
						sendPlanFeedbackNow,
						goalSendMode,
						shouldQueue: shouldQueueNow(),
					})
				: null;
		const commitComposerSubmission = (keepPendingAttachments = false) => {
			if (editorViewRef.current === view && view.state.doc === submittedDoc) {
				clearComposer(view, {
					clearPendingAttachments:
						!keepPendingAttachments && onDraftSubmit === undefined,
				});
				clearComposerDraft(draftKey);
			}
			useComposerDraftsStore.getState().removeContexts(
				draftKey,
				contexts.map((item) => item.id),
			);
			setGoalSendMode(false);

			useAnnotationsStore.getState().clear(sessionId);
			editingQueuedItemRef.current = null;
			setEditingQueuedItem(null);
			// Sending a new message moves past an expired question.
			if (questionAnswer?.expired === true) questionAnswer.dismiss();
		};

		if (onDraftSubmit !== undefined) {
			const pendingDraftAttachments = pendingDraftAttachmentsRef.current;
			const pendingDraftContextFiles = pendingDraftContextFilesRef.current;
			return handoffComposerDraft(
				(accept) =>
					onDraftSubmit(input, {
						accept,
						asGoal: goalSendMode,
						pendingAttachments: pendingDraftAttachments,
						pendingContextFiles: pendingDraftContextFiles,
					}),
				() => {
					commitComposerSubmission();
					pendingDraftAttachmentsRef.current = [];
					pendingDraftContextFilesRef.current = [];
				},
			);
		}
		const sendAndClear = (options?: { readonly asGoal?: boolean }) => {
			const snapshot = {
				doc: view.state.doc.toString(),
				chips: allChips(view.state),
			};
			const pendingAttachments = pendingDraftAttachmentsRef.current;
			setSubmitting(true);
			view.contentDOM.blur();
			void submitComposerDelivery(
				() => send(input, options),
				() => commitComposerSubmission(true),
				() => {
					const currentView = editorViewRef.current === view ? view : null;
					const current = currentView
						? {
								doc: currentView.state.doc.toString(),
								chips: allChips(currentView.state),
							}
						: useComposerDraftsStore.getState().draftsByKey[draftKey];
					const recovered = recoverComposerDraft(snapshot, current);
					saveComposerDraft(draftKey, recovered);
					if (currentView) {
						currentView.dispatch({ effects: clearChipsEffect.of() });
						setComposerDoc(currentView, recovered.doc);
						restoreComposerChips(currentView, recovered.chips);
						setHasText(recovered.doc.trim().length > 0);
						hasTextRef.current = recovered.doc.trim().length > 0;
						setGoalSendMode(options?.asGoal === true);
					}
					const drafts = useComposerDraftsStore.getState();
					const currentContexts =
						drafts.contextsByKey[draftKey] ?? EMPTY_COMPOSER_CONTEXTS;
					useComposerDraftsStore.setState({
						contextsByKey: {
							...drafts.contextsByKey,
							[draftKey]: [
								...contexts.filter(
									(item) =>
										!currentContexts.some(
											(current) => current.sourceKey === item.sourceKey,
										),
								),
								...currentContexts,
							],
						},
					});
					const currentAnnotations = annotationsForSession(sessionId);
					useAnnotationsStore
						.getState()
						.replace(sessionId, [
							...annotations.filter(
								(annotation) =>
									!currentAnnotations.some(
										(current) => current.id === annotation.id,
									),
							),
							...currentAnnotations,
						]);
				},
			)
				.then((accepted) => {
					if (!accepted) return;
					for (const pending of pendingAttachments) {
						if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
					}
					if (pendingDraftAttachmentsRef.current === pendingAttachments) {
						pendingDraftAttachmentsRef.current = [];
						pendingDraftContextFilesRef.current = [];
					}
				})
				.catch(() => undefined)
				.finally(() => {
					setSubmitting(false);
					editorViewRef.current?.focus();
				});
		};

		switch (route) {
			case "planFeedback":
				setSubmitting(true);
				view.contentDOM.blur();
				void commitAcceptedComposerDelivery(
					(async () => {
						if (pendingNativePlanApproval !== null) {
							const result = await deliverNativePlanFeedback({
								respond: () =>
									respondToPlan(
										sessionId,
										pendingNativePlanApproval.toolCallId,
										"cancelled",
										composerFeedbackText(input),
										{
											silent: true,
											environmentId: qualifiedEnvironmentId,
										},
									),
								fallbackSend: () => send(input),
							});
							return result !== "failed";
						}
						if (pendingPlanApprovalRequest !== null) {
							await decidePermission(pendingPlanApprovalRequest, {
								_tag: "Deny",
							});
						}
						return send(input);
					})(),
					commitComposerSubmission,
				)
					.catch(() => undefined)
					.finally(() => {
						setSubmitting(false);
						editorViewRef.current?.focus();
					});
				break;
			case "goal":
				sendAndClear({ asGoal: true });
				break;
			case "queue":
				setSubmitting(true);
				void commitAcceptedComposerDelivery(
					queue(
						goalSendMode
							? ComposerInput.make({ ...input, asGoal: true })
							: input,
					),
					commitComposerSubmission,
				)
					.catch(() => undefined)
					.finally(() => setSubmitting(false));
				break;
			case "send":
				sendAndClear();
				break;
		}
		return true;
	};

	submitRef.current = submit;

	sendTextRef.current = async (text) => {
		if (
			onDraftSubmit !== undefined ||
			submitDisabled ||
			directoryUnavailable ||
			durableCloudSendPending ||
			text.trim().length === 0
		)
			return false;

		const annotations = annotationsForSession(sessionId);
		const input = ComposerInput.make({
			text,
			attachments: attachmentsWithBrowserAnnotations([], annotations),
			fileRefs: [],
			skillRefs: [],
			annotations,
		});

		const drainSent = () => {
			const store = useAnnotationsStore.getState();
			for (const annotation of annotations)
				store.remove(sessionId, annotation.id);
		};

		if (shouldQueueNow()) {
			queue(input);
			drainSent();
			return true;
		}
		const accepted = await send(input).catch(() => false);
		if (accepted) drainSent();
		return accepted;
	};
	const planModeAvailable =
		session.providerId !== "pi" &&
		(findModelDescriptor(composerCatalog, session.providerId, session.model)
			?.supportsPlanMode ??
			true);
	togglePlanModeRef.current = () => {
		if (session.providerId === "pi" || variant === "minimal") return;
		void setPermissionMode(
			sessionId,
			session.permissionMode === "plan" ? "default" : "plan",
			qualifiedEnvironmentId,
		);
	};
	filesDroppedRef.current = (files) => {
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

	const showCard =
		headPermission !== undefined || headDeviceCommand !== undefined;

	const composerTrays = (
		<>
			<NoConnectionTray />
			{!isDraft ? <SessionSecretRequests sessionRef={timeline.ref} /> : null}
			{isDraft ? draftTray : null}
			<ComposerAttachmentTray
				draftKey={draftKey}
				sessionId={isDraft ? null : sessionId}
				folderId={session.projectId}
				worktreeId={session.worktreeId}
			/>
			{!isDraft && isCloudSession ? <CloudConnectionNotice /> : null}
			{!isDraft ? (
				<ProviderSignInTray
					environmentId={qualifiedEnvironmentId}
					sessionId={sessionId}
					providerId={session.providerId}
				/>
			) : null}
			{!isDraft ? (
				<>
					<ProviderErrorTray
						environmentId={qualifiedEnvironmentId}
						sessionId={sessionId}
						providerId={session.providerId}
					/>
					<PlanApprovalTray
						environmentId={qualifiedEnvironmentId}
						sessionId={sessionId}
						emulatedPlanReady={emulatedPlanReady}
						onApproveEmulatedPlan={approveEmulatedPlan}
						onCancelEmulatedPlan={cancelEmulatedPlan}
					/>
					{goal !== null ? (
						<GoalBanner
							goal={goal}
							pendingAction={pendingGoalAction}
							inPlanMode={inPlanMode}
							onPause={() =>
								void setSessionGoal({
									ref: goalRef,
									goal: {
										status: goal.status === "active" ? "paused" : "active",
									},
								}).catch(reportGoalError)
							}
							onSave={(objective, tokenBudget) =>
								void setSessionGoal({
									ref: goalRef,
									goal: {
										objective,
										status: "active",
										tokenBudget,
									},
								}).catch(reportGoalError)
							}
							onClear={() =>
								void clearSessionGoal({ ref: goalRef }).catch(reportGoalError)
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
						cloudSummary={cloudSummary}
						waitingForSandbox={
							cloudSummary !== null && !isCloudWorkspaceReady(cloudSummary)
						}
					/>
				</>
			) : null}
			{questionAnswer !== null ? (
				<QuestionTray answer={questionAnswer} />
			) : null}
		</>
	);

	return (
		<TooltipProvider delay={0}>
			{cloudSummary && (
				<div className="px-3 py-1">
					<CloudDeviceSelector workspaceId={cloudSummary.workspaceId} />
				</div>
			)}
			{timeline.presentation.health === "stalled" ||
			timeline.presentation.health === "unavailable" ? (
				<div role="status" className="px-3 py-2 text-xs text-muted-foreground">
					{uiMessage(
						timeline.presentation.health === "stalled"
							? "chat:provider_quiet"
							: "chat:execution_unavailable",
					)}
				</div>
			) : null}
			{showCard ? (
				<div
					className={cn("shrink-0 pb-3 pt-2", constrain ? "px-3" : undefined)}
				>
					<div className={constrain ? "mx-auto w-full max-w-4xl" : "w-full"}>
						{headPermission !== undefined ? (
							<PermissionCard
								key={`${qualifiedEnvironmentId}:${headPermission.interaction.id}:${headPermission.interaction.request.recoveryState ?? "live"}`}
								head={headPermission.interaction.request}
								queueSize={pendingPermissions.length}
								environmentId={qualifiedEnvironmentId}
								submission={headPermission.submission}
								submissionError={headPermission.error}
							/>
						) : headDeviceCommand !== undefined ? (
							<DevicePermissionCard
								key={headDeviceCommand.id}
								command={headDeviceCommand}
								queueSize={deviceApproval.commands.length}
								onDecision={deviceApproval.decide}
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
					<div className="relative">
						{headerSlot !== undefined ? (
							<div className="composer-attached-toolbar relative z-10 mx-auto w-14/15 overflow-hidden rounded-b-none rounded-t-[1.2rem]">
								{composerTrays}
								<div className="flex min-h-8 items-center overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
									{headerSlot}
								</div>
							</div>
						) : (
							<div
								className={cn(
									composerTraySurfaceClass,
									"relative z-10 rounded-b-none rounded-t-[1.2rem] empty:hidden",
								)}
							>
								{composerTrays}
							</div>
						)}
						{editingQueuedItem !== null ? (
							<div className="mb-1 flex h-7 items-center justify-between rounded-md bg-muted/35 px-2.5 text-xs text-muted-foreground">
								<span>
									{uiMessage("chat:chat_composer_editing_queued_message")}
								</span>
								<button
									type="button"
									onClick={cancelQueuedEdit}
									className="rounded px-1.5 py-0.5 text-foreground hover:bg-muted/70"
								>
									{uiMessage("common:cancel")}
								</button>
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
										<span>
											{uiMessage("chat:chat_composer_drop_files_to_attach")}
										</span>
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

							<div className="relative z-10 flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
								<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
									<ComposerAddMenu
										onAttach={() => fileInputRef.current?.click()}
										plan={
											planModeAvailable && variant === "full"
												? {
														active: session.permissionMode === "plan",
														toggle: () => togglePlanModeRef.current(),
													}
												: null
										}
										goal={
											goalCapable && variant === "full"
												? {
														active: goalSendMode,
														toggle: () => setGoalSendMode((v) => !v),
													}
												: null
										}
									/>
									{variant === "full" ? (
										<>
											{session.permissionMode === "plan" &&
											planModeAvailable ? (
												<PlanModeToggle
													sessionId={sessionId}
													environmentId={qualifiedEnvironmentId}
													current={session.permissionMode}
												/>
											) : null}
											{goalSendMode && goalCapable ? (
												<GoalModeToggle
													active={goalSendMode}
													hasGoal={goal !== null}
													onClick={() => setGoalSendMode((v) => !v)}
												/>
											) : null}
											<RuntimeAccessPicker
												onChange={(mode) =>
													void setRuntimeMode(
														sessionId,
														mode,
														qualifiedEnvironmentId,
													)
												}
												providerId={session.providerId}
												current={appliedRuntimeMode}
												pending={runtimeModePending}
												confirmed={isDraft || timeline.projection !== null}
											/>
											<PluginsPopover />
										</>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<ComposerVoiceButton
										key={`${qualifiedEnvironmentId}:${sessionId}`}
										environmentId={qualifiedEnvironmentId}
										disabled={
											submitDisabled || directoryUnavailable || submitting
										}
										onTranscript={(text) => {
											const view = editorViewRef.current;
											if (!view) return;
											// Dictation lands at the caret, padded so it never
											// fuses with the words around it.
											const { doc, selection } = view.state;
											const { from, to } = selection.main;
											const before = doc.sliceString(from - 1, from);
											const after = doc.sliceString(to, to + 1);
											const insert = `${before && !/\s/.test(before) ? " " : ""}${text}${after && !/\s/.test(after) ? " " : ""}`;
											view.dispatch({
												changes: { from, to, insert },
												selection: { anchor: from + insert.length },
												scrollIntoView: true,
											});
											view.focus();
										}}
									/>
									<ComposerModelPicker
										cloudProviderIds={cloudProviderIds}
										environmentId={qualifiedEnvironmentId}
										session={session}
										runtimeMode={appliedRuntimeMode}
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
									{!isDraft && variant === "full" ? (
										<ContextStatusPopover
											environmentId={qualifiedEnvironmentId}
											session={session}
										/>
									) : null}
									{answerableQuestion !== null ? (
										<DitherButton
											variant="gradient"
											className="size-6 border border-primary/40 text-white"
											onClick={() => void submit()}
											disabled={
												answerableQuestion.busy ||
												!answerableQuestion.canAnswer(hasText)
											}
											aria-label={uiMessage(
												answerableQuestion.last
													? "chat:question_card_submit_answer"
													: "chat:question_card_continue",
											)}
										>
											{answerableQuestion.busy ? (
												<Spinner className="size-3.5" />
											) : (
												<HugeiconsIcon icon={SentIcon} className="size-3.5" />
											)}
										</DitherButton>
									) : sendPlanFeedbackNow && hasText ? (
										<Button
											variant="default"
											size="sm"
											onClick={() => void submit()}
											disabled={!canSend}
											aria-label={uiMessage(
												"chat:chat_composer_request_changes_to_plan",
											)}
										>
											{uiMessage("chat:chat_composer_request_changes")}
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
													aria-label={uiMessage(
														"chat:chat_composer_add_message_to_queue",
													)}
												>
													{uiMessage("chat:chat_composer_queue")}
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
																	? uiMessage(
																			"chat:chat_composer_stopping_current_turn",
																		)
																	: uiMessage(
																			"chat:chat_composer_stop_current_turn",
																		)
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
													{interrupting
														? uiMessage("chat:chat_composer_stopping")
														: uiMessage("chat:chat_composer_stop_current_turn")}
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
																? uiMessage(
																		"chat:chat_composer_uploading_image",
																	)
																: uiMessage("chat:chat_composer_send")
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
													? uiMessage("chat:chat_composer_uploading_image_2")
													: uiMessage("chat:chat_composer_send_enter")}
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

function useFastMode(environmentId: EnvironmentId, sessionId: SessionId) {
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

	const toggle = () => {
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

	return { enabled, toggle };
}

function FastModeToggle({
	enabled,
	onClick,
	compact = false,
}: {
	enabled: boolean;
	onClick: () => void;
	compact?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={
							enabled
								? uiMessage("chat:chat_composer_disable_fast_mode")
								: uiMessage("chat:chat_composer_enable_fast_mode")
						}
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
						{enabled && !compact ? (
							<span>{uiMessage("chat:chat_composer_fast")}</span>
						) : null}
					</button>
				}
			/>
			<TooltipPopup className={compact ? "space-y-0.5" : undefined}>
				{compact ? (
					<>
						<div>{uiMessage("chat:chat_composer_1_5_speed")}</div>
						<div className="text-muted-foreground">
							{uiMessage("chat:chat_composer_more_usage")}
						</div>
					</>
				) : enabled ? (
					uiMessage("chat:chat_composer_disable_claude_fast_mode")
				) : (
					uiMessage("chat:chat_composer_enable_claude_fast_mode")
				)}
			</TooltipPopup>
		</Tooltip>
	);
}

type ComposerModeToggle = {
	readonly active: boolean;
	readonly toggle: () => void;
};

/**
 * The composer's "+" menu: attachments and the per-message modes (plan,
 * goal) live here so the toolbar stays a row of icons. An active mode also
 * shows as an icon chip beside it.
 */
function ComposerAddMenu({
	onAttach,
	plan,
	goal,
}: {
	onAttach: () => void;
	plan: ComposerModeToggle | null;
	goal: ComposerModeToggle | null;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	const check = (
		<HugeiconsIcon
			icon={Tick02Icon}
			className="ms-auto size-3.5 text-foreground"
		/>
	);
	return (
		<Menu modal={false}>
			<MenuTrigger
				aria-label={uiMessage("chat:chat_composer_add_menu")}
				className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-muted/60 data-[popup-open]:text-foreground"
			>
				<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
			</MenuTrigger>
			<MenuPopup side="top" align="start" sideOffset={6} className="w-56">
				<MenuItem className={compactMenuItemClass} onClick={onAttach}>
					<HugeiconsIcon icon={AttachmentIcon} className="size-[15px]" />
					{uiMessage("chat:chat_composer_attach_files")}
				</MenuItem>
				{plan !== null ? (
					<MenuItem className={compactMenuItemClass} onClick={plan.toggle}>
						<HugeiconsIcon icon={MapsIcon} className="size-[15px]" />
						{uiMessage("chat:chat_composer_plan_mode")}
						{plan.active ? (
							check
						) : (
							<MenuShortcut>{uiMessage("chat:chat_composer_tab")}</MenuShortcut>
						)}
					</MenuItem>
				) : null}
				{goal !== null ? (
					<MenuItem className={compactMenuItemClass} onClick={goal.toggle}>
						<HugeiconsIcon icon={DashboardSpeedIcon} className="size-[15px]" />
						{uiMessage("chat:chat_composer_set_goal")}
						{goal.active ? check : null}
					</MenuItem>
				) : null}
			</MenuPopup>
		</Menu>
	);
}

function PlanModeToggle({
	sessionId,
	environmentId,
	current,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	current: PermissionMode;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const setPermissionMode = useSessionsStore((s) => s.setPermissionMode);
	const isPlan = current === "plan";

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
						aria-label={
							isPlan
								? uiMessage("chat:chat_composer_exit_plan_mode")
								: uiMessage("chat:chat_composer_enter_plan_mode")
						}
						aria-pressed={isPlan}
						className={cn(
							"flex size-7 items-center justify-center rounded-md text-xs transition-colors",
							isPlan
								? "bg-rose-400/20 text-rose-700 hover:bg-rose-400/30 dark:bg-rose-300/15 dark:text-rose-200 dark:hover:bg-rose-300/25"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={MapsIcon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				{isPlan
					? uiMessage("chat:chat_composer_exit_plan_mode")
					: uiMessage("chat:chat_composer_enter_plan_mode")}
				<span className="ml-2 opacity-60">
					{uiMessage("chat:chat_composer_tab")}
				</span>
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
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={
							active
								? uiMessage("chat:chat_composer_send_next_message_as_goal")
								: uiMessage("chat:chat_composer_set_goal")
						}
						aria-pressed={active}
						className={cn(
							"flex size-7 items-center justify-center rounded-md text-xs transition-colors",
							active
								? "bg-amber-400/20 text-amber-700 hover:bg-amber-400/30 dark:bg-amber-300/15 dark:text-amber-200 dark:hover:bg-amber-300/25"
								: hasGoal
									? "text-amber-700 hover:bg-muted/60 dark:text-amber-200"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				{active
					? uiMessage("chat:chat_composer_next_send_sets_a_goal")
					: uiMessage("chat:chat_composer_send_next_message_as_goal")}
			</TooltipPopup>
		</Tooltip>
	);
}

function GoalBanner({
	goal,
	pendingAction,
	inPlanMode,
	onPause,
	onSave,
	onClear,
}: {
	goal: ThreadGoal;
	pendingAction: "set" | "clear" | null;
	inPlanMode: boolean;
	onPause: () => void;
	onSave: (objective: string, tokenBudget: number | null) => void;
	onClear: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

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
				title={uiMessage(GOAL_STATUS_MESSAGE[goal.status])}
				subtitle={objective}
				actions={
					<>
						<span
							className="shrink-0 text-muted-foreground tabular-nums"
							title={uiMessage("chat:chat_composer_goal_time_used")}
						>
							{elapsed}
						</span>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={onPause}
										disabled={pendingAction !== null}
										aria-busy={pendingAction === "set"}
										className={trayPillActionClass}
										aria-label={
											goal.status === "active"
												? uiMessage("chat:chat_composer_pause_goal")
												: uiMessage("chat:chat_composer_resume_goal")
										}
									>
										{pendingAction === "set" ? (
											<Spinner className="size-3.5" />
										) : (
											<HugeiconsIcon
												icon={goal.status === "active" ? SquareIcon : PlayIcon}
												className="size-3.5"
											/>
										)}
									</button>
								}
							/>
							<TooltipPopup>
								{goal.status === "active"
									? uiMessage("chat:chat_composer_pause_goal")
									: uiMessage("chat:chat_composer_resume_goal")}
							</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={() => setOpen(true)}
										disabled={pendingAction !== null}
										className={trayPillActionClass}
										aria-label={uiMessage("chat:chat_composer_edit_goal")}
									>
										<HugeiconsIcon
											icon={PencilEdit01Icon}
											className="size-3.5"
										/>
									</button>
								}
							/>
							<TooltipPopup>
								{uiMessage("chat:chat_composer_edit_goal")}
							</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={onClear}
										disabled={pendingAction !== null}
										aria-busy={pendingAction === "clear"}
										className={cn(
											trayPillActionClass,
											"hover:bg-destructive/10 hover:text-destructive",
										)}
										aria-label={uiMessage("chat:chat_composer_delete_goal")}
									>
										{pendingAction === "clear" ? (
											<Spinner className="size-3.5" />
										) : (
											<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
										)}
									</button>
								}
							/>
							<TooltipPopup>
								{uiMessage("chat:chat_composer_delete_goal")}
							</TooltipPopup>
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
					title={uiMessage("chat:chat_composer_plan_mode_active")}
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
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

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
					<DialogTitle>
						{uiMessage("chat:chat_composer_edit_goal_2")}
					</DialogTitle>
					<DialogDescription>
						{uiMessage(
							"chat:chat_composer_changing_the_objective_replaces_the_codex_goal_and_resets_goal_usage",
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-3">
					<Textarea
						value={objective}
						onChange={(event) => setObjective(event.currentTarget.value)}
						maxLength={4000}
						aria-label={uiMessage("chat:chat_composer_goal_objective")}
					/>
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<RichMessage
							id="chat:chat_composer_4000_tokens_sentence"
							values={{
								value: objective.length,
								value2: formatUiNumber(goal.tokensUsed),
								elapsed: elapsed,
							}}
							components={{ part0: <span />, part1: <span /> }}
						/>
					</div>
					<Input
						nativeInput
						type="number"
						min={1}
						value={budget}
						onChange={(event) => setBudget(event.currentTarget.value)}
						placeholder={uiMessage("chat:chat_composer_token_budget")}
						aria-label={uiMessage("chat:chat_composer_token_budget")}
					/>
				</DialogPanel>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{uiMessage("common:cancel")}
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
						{uiMessage("chat:chat_composer_save_goal")}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function ComposerModelPicker({
	cloudProviderIds,
	environmentId,
	session,
	runtimeMode,
	fastModeAvailable,
	onLevelChange,
	onOpenChange,
}: {
	cloudProviderIds?: ReadonlyArray<ProviderId>;
	environmentId: EnvironmentId;
	session: Session;
	runtimeMode: RuntimeMode;
	fastModeAvailable: boolean;
	onLevelChange?: (level: string | null) => void;
	onOpenChange?: (open: boolean) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const fastMode = useFastMode(environmentId, session.id);
	const sessionId = session.id;
	const providerId = session.providerId;
	const model = session.model;
	const catalog = useModelCatalogStore((s) => s.catalog);

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
	}, [catalog, providerId, model, uiMessage]);

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
		cloudProviderIds,
		composer: true,
		fastMode: fastModeAvailable && fastMode.enabled,
		environmentId,
		mode: "session" as const,
		sessionId,
		chatId: session.chatId,
		runtimeMode,
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
							{uiMessage("chat:chat_composer_advanced")}
						</span>
						{fastModeAvailable ? (
							<FastModeToggle
								compact
								enabled={fastMode.enabled}
								onClick={fastMode.toggle}
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
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

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
			const content = messages[i]?.content;
			if (!content) continue;
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
			const content = messages[i]?.content;
			if (!content) continue;
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
				precision:
					latestCompact.providerId === "zuse"
						? ("estimated" as const)
						: ("exact" as const),
				source: "Context compaction",
			};
		}
		return latestUsage;
	}, [messages, session.providerId, uiMessage]);

	const usageLimits = useMemo(() => {
		const latestByKey = new Map<
			string,
			Extract<Message["content"], { _tag: "usage_limit" }>
		>();
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i]?.content;
			if (!content) continue;
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
	}, [messages, session.providerId, uiMessage]);

	const latestCompaction = useMemo(
		() =>
			messages.findLast(
				(message) =>
					message.content._tag === "context_compaction" &&
					message.content.providerId === session.providerId,
			)?.content,
		[messages, session.providerId],
	);
	if (
		latestCompaction?._tag === "context_compaction" &&
		latestCompaction.status === "in_progress"
	) {
		return (
			<span
				role="status"
				className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
			>
				<Spinner className="size-3" />
				{uiMessage("chat:message_row_compacting")}
			</span>
		);
	}

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
				: formatTokens(usedTokens ?? 0);

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
						aria-label={uiMessage(
							"chat:chat_composer_context_and_usage_status",
						)}
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
							<RichMessage
								id="chat:chat_composer_context_sentence"
								values={{ headerValue: headerValue }}
								components={{
									part0: <span className="font-medium text-foreground" />,
									part1: (
										<span className="tabular-nums text-muted-foreground" />
									),
								}}
							/>
						</div>
						{percent !== null ? (
							<>
								<StickMeter
									percent={percent}
									tone={high ? "warning" : "default"}
								/>
								<div className="flex items-center justify-between text-muted-foreground">
									<RichMessage
										id="chat:chat_composer_window_used_sentence"
										values={{ value: percent.toFixed(1) }}
										components={{
											part0: <span />,
											part1: <span className="tabular-nums" />,
										}}
									/>
								</div>
								<div className="flex items-center justify-between text-muted-foreground/70">
									<span>{uiMessage("chat:chat_composer_available")}</span>
									{freeTokens !== null ? (
										<span className="tabular-nums">
											{formatTokens(freeTokens)}
										</span>
									) : null}
								</div>
							</>
						) : (
							<div className="text-muted-foreground/70">
								{uiMessage(
									"chat:chat_composer_usage_appears_after_the_first_response",
								)}
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
										<span>{uiMessage("chat:chat_composer_reset")}</span>
										<span className="tabular-nums">
											{reset !== null
												? reset
												: uiMessage("chat:chat_composer_unknown")}
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
