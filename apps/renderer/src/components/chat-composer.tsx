import type { EditorView } from "@codemirror/view";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
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
	Tick01Icon,
	Upload01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import {
	type BooleanOptionDescriptor,
	type BrowserAnnotation,
	type ComposerAnnotation,
	ComposerInput,
	findModelDescriptor,
	type Message,
	type PermissionMode,
	type PermissionRequest,
	type ProviderId,
	type RuntimeMode,
	type SelectOptionDescriptor,
	type Session,
	type SessionId,
	type ThreadGoal,
} from "@zuse/contracts";
import { Effect } from "effect";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CostChip } from "~/components/cost-footer";
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
import { Frame, FrameFooter } from "~/components/ui/frame";
import { Input } from "~/components/ui/input";
import {
	Menu,
	MenuGroup,
	MenuGroupLabel,
	MenuItem,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
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
import { makeComposerMessageSignalSelector } from "~/lib/composer-message-signal";
import {
	chooseComposerSubmitRoute,
	deliverNativePlanFeedback,
	findPendingNativePlanApproval,
	findPendingPlanApprovalRequest,
	hasEmulatedPlanAwaitingAction,
	providerUsesEmulatedPlanMode,
	shouldSendPlanFeedbackNow,
} from "~/lib/plan-feedback-routing";
import { getRpcClient } from "~/lib/rpc-client";
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
import { parseComposerInput } from "../composer/segment-parser.ts";
import { useActiveWorkspaceRoot } from "../store/active-workspace.ts";
import {
	annotationsForSession,
	useAnnotationsStore,
} from "../store/annotations.ts";
import { useAttachmentsStore } from "../store/attachments.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import { useKeybindingsStore } from "../store/keybindings";
import { useMessagesStore } from "../store/messages.ts";
import { useOpencodeInventory } from "../store/opencode-inventory.ts";
import { usePaneFocus } from "../store/pane-focus.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useSkillsStore } from "../store/skills.ts";
import { AnnotationTray } from "./composer/annotation-tray.tsx";
import { ComposerChipOverlay } from "./composer/composer-chip-overlay.tsx";
import { ContextTray } from "./composer/context-tray.tsx";
import { FileTagPopover } from "./composer/file-tag-popover.tsx";
import {
	EMULATED_PLAN_APPROVAL_PROMPT,
	PlanApprovalTray,
} from "./composer/plan-approval-tray.tsx";
import { ProjectPlanTray } from "./composer/project-plan-tray.tsx";
import { QueueTray } from "./composer/queue-tray.tsx";
import { SlashCommandPopover } from "./composer/slash-command-popover.tsx";
import { TrayPill, trayPillActionClass } from "./composer/tray-pill.tsx";
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
import { ProviderIcon } from "./provider-icons.tsx";
import { QuestionCard } from "./question-card.tsx";

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 240;
const MAX_ATTACHMENTS_PER_TURN = 20;

export function ChatComposer({
	session,
	onDraftSubmit,
	composerDraftKey,
	headerSlot,
	constrain = true,
	directoryUnavailable = false,
}: {
	session: Session;
	composerDraftKey?: string;
	constrain?: boolean;
	directoryUnavailable?: boolean;
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
	const draftKey = composerDraftKey ?? composerDraftKeyForSession(sessionId);
	const isDraft = onDraftSubmit !== undefined;
	const [reasoningLevel, setReasoningLevel] = useState<string | null>(null);
	const inFlight = useMessagesStore(
		(s) => s.runningBySession[sessionId] === true,
	);
	// Hold messages only while the provider is unavailable or an earlier message
	// is already queued. Worktree setup is independent background work and must
	// not delay an agent that has finished booting.
	const hasQueued = useMessagesStore(
		(s) => (s.queueBySession[sessionId]?.length ?? 0) > 0,
	);
	const holdForAgent = hasQueued || session.status === "booting";
	const goal = useMessagesStore((s) => s.goalBySession[sessionId] ?? null);
	const send = useMessagesStore((s) => s.send);
	const respondToPlan = useSessionsStore((s) => s.respondToPlan);
	const interrupt = useMessagesStore((s) => s.interrupt);
	const queue = useMessagesStore((s) => s.queue);
	const setGoal = useMessagesStore((s) => s.setGoal);
	const clearGoal = useMessagesStore((s) => s.clearGoal);
	const saveComposerDraft = useComposerDraftsStore((s) => s.save);
	const clearComposerDraft = useComposerDraftsStore((s) => s.clear);

	// Pending AskUserQuestion takes over the composer slot — that's where
	// the user types anyway, and floating it inline above the chat
	// crowded the timeline. Swap to QuestionCard while one is unanswered;
	// otherwise render the normal editor.
	//
	// Select the stable message-list reference (the atom store interns the array
	// — same identity until a new message arrives) and derive the
	// pending-question shape with `useMemo`. Returning a freshly-built
	// object directly from an external-store selector breaks
	// `useSyncExternalStore`'s snapshot-equality check and infinite-loops
	// the renderer.
	const selectComposerMessageSignal = useMemo(
		() => makeComposerMessageSignalSelector(sessionId),
		[sessionId],
	);
	const composerMessageSignal = useMessagesStore((s) =>
		selectComposerMessageSignal(s.messagesBySession),
	);
	// Read the full transcript only when a composer-relevant interaction lands
	// or the running edge changes. Regular stream rows still render in the
	// timeline, but they no longer re-run this large controller while the user
	// is typing.
	const sessionMessages = useMemo(
		() => useMessagesStore.getState().messagesBySession[sessionId],
		[composerMessageSignal, inFlight, sessionId],
	);
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
	const requestsById = usePermissionsStore((s) => s.requestsById);
	const hydratePermissions = usePermissionsStore((s) => s.hydrate);
	const decidePermission = usePermissionsStore((s) => s.decide);
	const pendingPermissions = useMemo(() => {
		const out: PermissionRequest[] = [];
		for (const req of Object.values(requestsById)) {
			if (req.sessionId !== sessionId) continue;
			// ExitPlanMode is approved on the plan card itself.
			if (req.kind._tag === "Other" && req.kind.tool === "ExitPlanMode") {
				continue;
			}
			out.push(req);
		}
		out.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
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
	useEffect(() => {
		if (isDraft) return;
		void hydratePermissions(sessionId);
	}, [isDraft, sessionId, hydratePermissions]);
	// Reconcile permission requests whenever the running flag transitions
	// true → false. A turn that ended (or aborted) sometimes leaves a stale
	// pending-permission row in the client cache — the row's UI then takes
	// over the composer slot and looks like the input is disabled. Re-asking
	// the server clears anything it already resolved.
	useEffect(() => {
		if (isDraft || inFlight) return;
		void hydratePermissions(sessionId);
	}, [isDraft, inFlight, sessionId, hydratePermissions]);
	// Deterministic fallback delivery. The reconcile hydrate above is gated off
	// while a turn is in flight, yet that's exactly when the agent blocks on a
	// permission request. If the live `permission.requests` stream ever drops
	// the request (subscribe race / stream death), the card would never appear
	// and the agent hangs invisibly. Poll `listPending` (the server's durable
	// truth) while running so the card always surfaces within ~2s. Idempotent —
	// `requestsById` is keyed by id, so it's a no-op merge when the stream is
	// healthy. The interval is cleared the instant the turn ends or the session
	// changes.
	useEffect(() => {
		if (isDraft || !inFlight) return;
		const id = window.setInterval(() => {
			void hydratePermissions(sessionId);
		}, 2000);
		return () => window.clearInterval(id);
	}, [isDraft, inFlight, sessionId, hydratePermissions]);
	const headPermission = pendingPermissions[0];
	useEffect(() => {
		if (isDraft || !inFlight || headPermission !== undefined) return;
		void hydratePermissions(sessionId);
		const id = window.setInterval(() => {
			void hydratePermissions(sessionId);
		}, 1_000);
		return () => window.clearInterval(id);
	}, [isDraft, inFlight, headPermission, sessionId, hydratePermissions]);

	const [hasText, setHasText] = useState(false);
	const hasTextRef = useRef(false);
	const [uploadingAttachmentCount, setUploadingAttachmentCount] = useState(0);
	const [goalSendMode, setGoalSendMode] = useState(false);
	// Provider features the installed CLI supports (from the availability
	// probe). Drives whether goal/fast controls render at all. Codex resolves
	// these from its CLI version; Grok advertises `goalMode` unconditionally.
	const capabilities = useProvidersStore((s) =>
		s.capabilitiesFor(session.providerId),
	);
	// Goal mode is supported by Codex (native `thread/goal/*`, version-gated via
	// the `goalMode` capability) and Grok (native `/goal`, forwarded by the
	// driver). Grok has no version floor, so it's always goal-capable and
	// doesn't depend on the availability probe.
	const goalCapable =
		session.providerId === "grok" ||
		(session.providerId === "codex" && capabilities.includes("goalMode"));
	const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const editorHostRef = useRef<HTMLDivElement | null>(null);
	const editorViewRef = useRef<EditorView | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);
	const uploadOne = useAttachmentsStore((s) => s.uploadOne);
	const hydrateDraftSkills = useSkillsStore((s) => s.hydrateForDraft);
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
	const revealPanel = useUiStore((s) => s.revealPanel);
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
		void hydrateDraftSkills(sessionId, session.projectId, session.providerId);
	}, [
		hydrateDraftSkills,
		isDraft,
		sessionId,
		session.projectId,
		session.providerId,
	]);

	// Stacked annotations are a valid message on their own, so they enable Send
	// even with an empty text box.
	const canSend =
		!directoryUnavailable &&
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
		const unsubKeybindings = useKeybindingsStore.subscribe(() => {
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

	const dispatchBuiltin = (parsed: {
		command: BuiltinCommand;
		args: string;
	}): void => {
		switch (parsed.command.name) {
			case "clear":
				// Editor is already cleared by the caller; nothing else to do.
				break;
			case "model":
				if (parsed.args) void setModel(sessionId, parsed.args);
				break;
			case "mode":
				if (
					parsed.args === "approval-required" ||
					parsed.args === "auto-accept-edits" ||
					parsed.args === "full-access"
				) {
					void setRuntimeMode(sessionId, parsed.args);
				}
				break;
			case "plan":
				void setPermissionMode(sessionId, "plan");
				break;
			case "run":
				void setPermissionMode(sessionId, "default");
				break;
			case "goal":
				if (parsed.args.length > 0) {
					void send(sessionId, parsed.args, { asGoal: true });
				} else {
					setGoalSendMode(true);
				}
				break;
			case "diff":
				revealPanel("changes");
				break;
			case "copy": {
				const latest = [
					...(useMessagesStore.getState().messagesBySession[sessionId] ?? []),
				]
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
					const finalUrl = isImage ? `zuse://attachments/${ref.id}` : "";
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
			const client = await getRpcClient();
			const res = await Effect.runPromise(
				client["context.saveText"]({
					sessionId,
					text,
					ext: "md",
					...(workspaceRoot ? { rootPath: workspaceRoot } : {}),
				}),
			);
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
		if (directoryUnavailable) return false;
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
						shouldQueue: inFlight || holdForAgent,
					})
				: null;
		clearComposer(view, {
			clearPendingAttachments: onDraftSubmit === undefined,
		});
		clearComposerDraft(draftKey);
		setGoalSendMode(false);
		// Drain the tray: the annotations now live on `input` (carried into the
		// queue too, so a mid-turn submit flushes them intact).
		useAnnotationsStore.getState().clear(sessionId);
		// Draft mode (new-chat landing): hand the input back to the landing, which
		// creates the worktree + chat and queues this as the first message.
		if (onDraftSubmit !== undefined) {
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
		switch (route) {
			case "planFeedback":
				void (async () => {
					if (pendingNativePlanApproval !== null) {
						await deliverNativePlanFeedback({
							respond: () =>
								respondToPlan(
									sessionId,
									pendingNativePlanApproval.toolCallId,
									"cancelled",
									docText,
									{ silent: true },
								),
							fallbackSend: () => send(sessionId, input),
						});
						return;
					}
					if (pendingPlanApprovalRequest !== null) {
						await decidePermission(pendingPlanApprovalRequest.id, {
							_tag: "Deny",
						});
					}
					await send(sessionId, input);
				})();
				break;
			case "goal":
				void send(sessionId, input, { asGoal: true });
				break;
			case "queue":
				// Mid-turn submit — or a submit while the provider is still coming up
				// — becomes a queue chip; auto-flushed when the turn ends or steered
				// manually.
				queue(
					sessionId,
					goalSendMode ? ComposerInput.make({ ...input, asGoal: true }) : input,
				);
				break;
			case "send":
				void send(sessionId, input);
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
			await setPermissionMode(sessionId, "default");
			await send(sessionId, EMULATED_PLAN_APPROVAL_PROMPT);
		})();
	};
	const cancelEmulatedPlan = () => {
		void setPermissionMode(sessionId, "default");
	};
	const inUltracodeMode = reasoningLevel === "ultracode";
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
								head={headPermission}
								queueSize={pendingPermissions.length}
							/>
						) : pendingQuestion !== null ? (
							<QuestionCard
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
					<Frame className="composer-glass bg-transparent">
						{headerSlot !== undefined ? (
							<div className="mb-1 flex items-center px-1">{headerSlot}</div>
						) : null}
						{!isDraft ? (
							<div className="mb-1 overflow-hidden rounded-md border border-border/50 bg-muted/30 empty:hidden empty:mb-0">
								<PlanApprovalTray
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
											void setGoal(sessionId, {
												status: goal.status === "active" ? "paused" : "active",
											})
										}
										onSave={(objective, tokenBudget) =>
											void setGoal(sessionId, {
												objective,
												status: "active",
												tokenBudget,
											})
										}
										onClear={() => void clearGoal(sessionId)}
									/>
								) : null}
								<ContextTray sessionId={sessionId} />
								{!inPlanMode ? (
									<ProjectPlanTray key={sessionId} sessionId={sessionId} />
								) : null}
								<QueueTray sessionId={sessionId} />
							</div>
						) : null}
						<Card
							className={cn(
								// Light: opaque white input on the gray frame for clear
								// separation. Dark: transparent so the single glass layer
								// shows through (a second tint would re-opacify it).
								"min-h-30 rounded-lg bg-card transition-colors dark:bg-transparent",
								goalSendMode
									? "border-2 border-dashed border-amber-300/60 dark:border-amber-300/45"
									: inPlanMode
										? "border-2 border-dashed border-rose-300/60 dark:border-rose-300/40"
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
							<CardPanel className="relative flex items-stretch gap-2 px-3 py-2">
								{trigger !== null && editorViewRef.current !== null ? (
									trigger.kind === "slash" ? (
										<SlashCommandPopover
											trigger={trigger}
											view={editorViewRef.current}
											sessionId={sessionId}
											providerId={session.providerId}
											onClose={() => setTrigger(null)}
										/>
									) : (
										<FileTagPopover
											trigger={trigger}
											view={editorViewRef.current}
											projectId={session.projectId}
											worktreeId={session.worktreeId}
											workspaceRoot={workspaceRoot}
											onClose={() => setTrigger(null)}
										/>
									)
								) : null}
								<div
									ref={editorHostRef}
									className="flex-1 overflow-y-auto bg-transparent text-sm leading-relaxed outline-none"
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
						</Card>
						{/* Single action row: model + reasoning sit on the left, send /
                runtime / timer sit on the right — so the user's eye lands on
                the same line for "what model is this" and "send." Sub-agent
                config moved to settings; it doesn't belong in the per-turn
                strip. */}
						<FrameFooter className="flex items-center justify-between gap-2 px-2 py-1.5">
							<div className="flex items-center gap-1.5">
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => fileInputRef.current?.click()}
												aria-label="Attach files"
												className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
								<ModelPicker
									mode="session"
									sessionId={sessionId}
									chatId={session.chatId}
									runtimeMode={session.runtimeMode}
									providerId={session.providerId}
									currentModel={session.model}
									onOpenChange={setModelPickerOpen}
								/>
								<ReasoningPicker
									sessionId={sessionId}
									providerId={session.providerId}
									model={session.model}
									onLevelChange={setReasoningLevel}
								/>
								{findModelDescriptor(
									session.providerId,
									session.model,
								)?.optionDescriptors?.some(
									(d): d is BooleanOptionDescriptor =>
										d.kind === "boolean" && d.id === "fastMode",
								) === true &&
									// For Codex, the fast tier also requires a new-enough CLI
									// (the `fastMode` capability). Claude declares its own
									// `fastMode` descriptor and isn't version-gated, so only
									// filter when the provider gates it.
									(session.providerId !== "codex" ||
										capabilities.includes("fastMode")) && (
										<FastModeToggle sessionId={sessionId} />
									)}
								{goalCapable ? (
									<GoalModeToggle
										active={goalSendMode}
										hasGoal={goal !== null}
										onClick={() => setGoalSendMode((v) => !v)}
									/>
								) : null}
								{(findModelDescriptor(session.providerId, session.model)
									?.supportsPlanMode ??
									true) && (
									<PlanModeToggle
										sessionId={sessionId}
										current={session.permissionMode}
									/>
								)}
								<McpPopover
									projectId={session.projectId}
									providerId={session.providerId}
								/>
							</div>
							<div className="flex items-center gap-2">
								{!isDraft ? <ContextStatusPopover session={session} /> : null}
								{!isDraft ? <CostChip sessionId={sessionId} /> : null}
								{!isDraft ? (
									<SessionTimer sessionId={sessionId} inFlight={inFlight} />
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
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													variant="outline"
													size="icon-sm"
													onClick={() => void interrupt(sessionId)}
													aria-label="Interrupt"
												>
													<HugeiconsIcon
														icon={SquareIcon}
														className="size-3.5"
													/>
												</Button>
											}
										/>
										<TooltipPopup>Interrupt the running turn</TooltipPopup>
									</Tooltip>
								) : (
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													variant="default"
													size="icon-sm"
													onClick={() => void submit()}
													disabled={!canSend}
													loading={uploadingAttachmentCount > 0}
													aria-label={
														uploadingAttachmentCount > 0
															? "Uploading image"
															: "Send"
													}
												>
													<HugeiconsIcon icon={SentIcon} className="size-3.5" />
												</Button>
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
						</FrameFooter>
					</Frame>
				</div>
			</div>
		</TooltipProvider>
	);
}

/**
 * Claude Fast Mode is a boolean model option, persisted in the same
 * per-session sessionStorage namespace the send path already reads.
 */
function FastModeToggle({ sessionId }: { sessionId: SessionId }) {
	const storageKey = `zuse.modelOptions.${sessionId}.fastMode`;
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
						aria-label={
							enabled ? "Disable Claude fast mode" : "Enable Claude fast mode"
						}
						aria-pressed={enabled}
						className={cn(
							"flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
							enabled
								? "bg-amber-400/20 text-amber-700 hover:bg-amber-400/30 dark:bg-amber-300/15 dark:text-amber-200 dark:hover:bg-amber-300/25"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={FlashIcon} className="size-3.5" />
						{enabled ? <span>Fast</span> : null}
					</button>
				}
			/>
			<TooltipPopup>
				{enabled ? "Disable Claude fast mode" : "Enable Claude fast mode"}
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
	current,
}: {
	sessionId: SessionId;
	current: PermissionMode;
}) {
	const setPermissionMode = useSessionsStore((s) => s.setPermissionMode);
	const isPlan = current === "plan";

	// Toggle is binary: pressing flips between `default` and `plan`. The
	// wider mode space (`acceptEdits`) lives on the runtime-mode chip — a
	// user wanting auto-accept-edits goes there, not here.
	const onClick = () => {
		void setPermissionMode(sessionId, isPlan ? "default" : "plan");
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
							"flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
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
							"flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
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
 * Reasoning / variant selector. For non-opencode providers this reads
 * the static `reasoning` SelectOptionDescriptor from `MODELS_BY_PROVIDER`.
 * For opencode, the per-model variant list comes from the live inventory
 * (`useOpencodeInventory`) so models like `anthropic/claude-sonnet-4-5`
 * show their actual variants (`high`/`medium`/…) and models without
 * variants render nothing.
 *
 * Selection persists per-session; the messages store reads it back at
 * send time and forwards it as `modelOptions.reasoning` — which the
 * opencode driver in turn translates into the prompt body's `model.variant`.
 */
function ReasoningPicker({
	sessionId,
	providerId,
	model,
	onLevelChange,
}: {
	sessionId: SessionId;
	providerId: ProviderId;
	model: string;
	onLevelChange?: (level: string | null) => void;
}) {
	const opencodeInventory = useOpencodeInventory((s) => s.inventory);

	// For opencode, the variant list is per-model and lives on the live
	// inventory (`provider.list()` → `model.variants`). For other providers
	// it's the static reasoning/effort descriptor curated in
	// `MODELS_BY_PROVIDER`. Claude's descriptor is keyed `effort` (with
	// tiers up through ultracode); everything else uses
	// `reasoning`.
	const resolved = useMemo((): {
		label: string;
		options: ReadonlyArray<{ id: string; label: string }>;
		defaultId: string;
		descriptorId: string;
	} | null => {
		if (providerId === "opencode") {
			if (opencodeInventory === null) return null;
			for (const p of opencodeInventory.providers) {
				const m = p.models.find((mm) => mm.id === model);
				if (m === undefined) continue;
				if (m.variants.length === 0) return null;
				return {
					label: "Reasoning",
					options: m.variants.map((v) => ({ id: v, label: v })),
					defaultId: m.variants.includes("medium")
						? "medium"
						: m.variants.includes("high")
							? "high"
							: m.variants[0]!,
					descriptorId: "reasoning",
				};
			}
			return null;
		}
		const descriptor = findModelDescriptor(providerId, model);
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
	}, [providerId, model, opencodeInventory]);

	const defaultId = resolved?.defaultId ?? "medium";
	const descriptorId = resolved?.descriptorId ?? "reasoning";
	const storageKey = `zuse.modelOptions.${sessionId}.${descriptorId}`;
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

	if (resolved === null) return null;

	const options = resolved.options;

	const onChange = (next: string) => {
		if (!options.some((o) => o.id === next)) return;
		setLevel(next);
		if (typeof window !== "undefined") {
			window.sessionStorage.setItem(storageKey, next);
		}
	};

	const activeLabel = options.find((o) => o.id === level)?.label ?? level;
	const isUltracode = level === "ultracode";

	return (
		<Menu>
			<MenuTrigger
				className={cn(
					"flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors data-[popup-open]:bg-muted/60",
					isUltracode
						? "bg-gradient-to-r from-rose-400/90 via-amber-300/90 via-emerald-400/90 via-sky-400/90 to-violet-400/90 text-white shadow-sm/10 hover:opacity-95"
						: "text-foreground hover:bg-muted/60",
				)}
				aria-label={resolved.label}
				title={
					isUltracode
						? "Ultracode — max reasoning + automatic workflow orchestration."
						: `${resolved.label} for the next message`
				}
			>
				<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3" />
				<span>{activeLabel}</span>
				{isUltracode && (
					<HugeiconsIcon
						icon={InformationCircleIcon}
						className="size-3 opacity-90"
						aria-hidden
					/>
				)}
				<HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-44">
				<MenuGroup>
					<MenuGroupLabel>{resolved.label}</MenuGroupLabel>
					<MenuRadioGroup value={level} onValueChange={onChange}>
						{options.map((o) => (
							<MenuRadioItem key={o.id} value={o.id}>
								{o.label}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
				</MenuGroup>
			</MenuPopup>
		</Menu>
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
	const descriptor = findModelDescriptor(providerId, model);
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
	sessionId: SessionId,
	providerId: ProviderId,
	model: string,
): number | null => {
	if (typeof window === "undefined") {
		return descriptorContextWindowTokens(providerId, model);
	}
	const stored = readStorageWithLegacy(
		window.sessionStorage,
		`zuse.modelOptions.${sessionId}.contextWindow`,
		[`memoize.modelOptions.${sessionId}.contextWindow`],
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
		<svg viewBox="0 0 16 16" fill="none" className="size-3.5 -rotate-90">
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

function ContextStatusPopover({ session }: { session: Session }) {
	const messages = useMessagesStore(
		(s) => s.messagesBySession[session.id] ?? EMPTY_MESSAGES,
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

const formatCoarse = (ms: number): string => {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	const mins = min - hours * 60;
	return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
};

/**
 * Sum of every turn's duration in this session — start = user message,
 * end = last message of that turn (or `now` for the in-flight turn). Idle
 * gaps between a finished assistant reply and the next user prompt are
 * NOT counted, so an old session that's been sitting open doesn't claim
 * "47h" of work.
 */
function SessionTimer({
	sessionId,
	inFlight,
}: {
	sessionId: SessionId;
	inFlight: boolean;
}) {
	const messages = useMessagesStore(
		(s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
	);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!inFlight) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [inFlight]);

	const totalElapsed = useMemo(() => {
		let total = 0;
		let turnStart: number | null = null;
		let turnLastMs: number | null = null;
		let turnIsLast = false;

		const closeTurn = (endOverride?: number) => {
			if (turnStart === null) return;
			const end = endOverride ?? turnLastMs ?? turnStart;
			total += Math.max(0, end - turnStart);
		};

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i]!;
			if (m.content._tag === "user" || m.content._tag === "user_rich") {
				if (turnStart !== null) closeTurn();
				turnStart = m.createdAt.getTime();
				turnLastMs = turnStart;
				turnIsLast = i === messages.length - 1;
			} else if (turnStart !== null) {
				turnLastMs = m.createdAt.getTime();
				turnIsLast = i === messages.length - 1;
			}
		}
		if (turnStart !== null) {
			// The in-flight turn keeps growing until the next message lands; for
			// a completed last turn we freeze at its final message timestamp.
			closeTurn(inFlight && turnIsLast !== false ? now : undefined);
		}
		return total;
	}, [messages, inFlight, now]);

	if (messages.length === 0) return null;

	return (
		<span
			className="rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
			title="Total time spent across all turns in this session"
		>
			{formatCoarse(totalElapsed)}
		</span>
	);
}

const EMPTY_MESSAGES: ReadonlyArray<Message> = [];
