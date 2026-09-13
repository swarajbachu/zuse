import { providerLabel as getProviderLabel } from "@zuse/contracts";
import "@zuse/i18n/english/common";
import { formatNumber as formatUiNumber } from "@zuse/i18n";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type {
	AttachmentRef,
	BrowserAnnotation,
	CodeAnnotation,
	ComposerAnnotation,
	EnvironmentId,
	FileRef,
	FolderId,
	ForkDestination,
	Message,
	MessageOrigin,
	ProviderId,
	SessionId,
	SkillRef,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	AlertCircleIcon,
	Copy01Icon,
	DashboardSpeedIcon,
	LinkSquare01Icon,
	Loading02Icon,
	PlayIcon,
	Settings01Icon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import {
	ChevronDown,
	ChevronRight,
	RefreshCw as RefreshIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { FileIcon } from "~/components/file-icon";
import { attachmentDataUrl, useAttachmentUrl } from "~/lib/attachments";
import {
	localProjectForCloudEnvironment,
	useCloudChatCatalogStore,
} from "~/lib/cloud-workspace-catalog.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { openNewChatLanding } from "~/lib/open-new-chat-landing.ts";
import {
	orchestrationToolName,
	parseOrchestrationResult,
} from "~/lib/orchestration-tools";
import { attachmentUrl } from "~/lib/platform-capabilities";
import { resumeAfterProviderLogin } from "~/lib/provider-auth-recovery";
import { isCloudWorkspaceEnvironment } from "~/lib/rpc-client.ts";
import {
	type ChatError,
	classifyMessage,
	clearSessionCommandError,
	resumeSessionQueue,
	retryLastSessionMessage,
	sendSessionMessage,
} from "~/lib/session-actions";
import { isSessionTurnActive } from "~/lib/session-runtime-state";
import { useOptionalRendererSessionTimeline } from "~/lib/session-timeline-hooks.ts";
import { subagentTaskIdForBlockingWait } from "~/lib/subagent-wait";
import { normalizeToolCallEnvelope } from "~/lib/tool-call-envelope";
import {
	openExternal,
	supportsProviderLogin,
	useProviderLogin,
} from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import { useProvidersStore } from "~/store/providers";
import { useSessionsStore } from "~/store/sessions";
import { useUiStore } from "~/store/ui";
import { useRevealAnnotation } from "./annotation/annotation-navigation.ts";
import {
	AssistantMessageActions,
	MessageActions,
} from "./assistant-message-actions.tsx";
import { useChatLookups } from "./chat-lookups.tsx";
import { AnnotationFileChip, FileChip } from "./file-chip.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { SkillIcon } from "./skill-icon.tsx";
import { UserMessageText } from "./user-message-text.tsx";

const isBrowserAnnotation = (
	annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
	"_tag" in annotation && annotation._tag === "browser";

const browserAnnotationMeta = (annotation: BrowserAnnotation): string => {
	const count =
		annotation.elements.length +
		annotation.regions.length +
		annotation.strokes.length;
	const first = annotation.elements[0];
	if (first !== undefined) return `<${first.tagName}> · ${count}`;
	try {
		return `${new URL(annotation.pageUrl).host} · ${count}`;
	} catch {
		return `Browser · ${count}`;
	}
};

import { MarkdownBody } from "./markdown-body.tsx";
import {
	ExitPlanModeRow,
	OrchestrationThreadRow,
	SubagentWaitRow,
	ThinkingRow,
	ToolRow,
	UserInputRow,
} from "./tool-row.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import {
	userBubbleClass,
	userBubbleColumnClass,
	userBubbleRowClass,
} from "./user-bubble-frame.tsx";

export type { ToolResultRecord } from "./chat-lookups.tsx";

type MessageContent<Tag extends Message["content"]["_tag"]> = Extract<
	Message["content"],
	{ readonly _tag: Tag }
>;

const stringifyJson = (value: unknown): string => {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const RECONNECTING_PATTERN =
	/^\s*Reconnecting\s*\.{3}\s*(\d+)\s*\/\s*(\d+)\s*$/i;

const parseReconnectingStatus = (
	message: string,
): { readonly attempt: number; readonly maxAttempts: number } | null => {
	const match = RECONNECTING_PATTERN.exec(message);
	if (match === null) return null;
	const attempt = Number(match[1]);
	const maxAttempts = Number(match[2]);
	if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) return null;
	return { attempt, maxAttempts };
};

const formatDuration = (ms: number): string => {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const min = Math.floor(seconds / 60);
	const sec = seconds - min * 60;
	return `${min}m, ${sec.toFixed(1)}s`;
};

const formatTokenCount = (tokens: number): string => formatUiNumber(tokens);

const formatCompactTokenDelta = (
	beforeTokens: number | null,
	afterTokens: number | null,
): string | null => {
	if (beforeTokens !== null && afterTokens !== null) {
		return `${formatTokenCount(beforeTokens)} -> ${formatTokenCount(afterTokens)} tokens`;
	}
	if (beforeTokens !== null) {
		return `${formatTokenCount(beforeTokens)} tokens before`;
	}
	if (afterTokens !== null) {
		return `${formatTokenCount(afterTokens)} tokens after`;
	}
	return null;
};

/**
 * Render a single chat row. Variants are dispatched on `content._tag` rather
 * than `role` because role collapses tool_use and assistant text into one
 * bucket, but their visual treatment differs.
 *
 * Tool and user-question pairing data lives in ChatLookups context so settled
 * text rows can be memoized without receiving fresh lookup-map props.
 */
function MessageRowImpl({
	message,
	sessionId,
	environmentId,
	providerId,
	readOnly = false,
	showAssistantCommands = false,
	forkDestination,
	sourceProjectId,
}: {
	message: Message;
	sessionId?: SessionId;
	environmentId?: EnvironmentId;
	providerId?: ProviderId;
	readOnly?: boolean;
	showAssistantCommands?: boolean;
	forkDestination?: ForkDestination;
	sourceProjectId?: FolderId;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	switch (message.content._tag) {
		case "user":
			return (
				<UserBubble
					text={message.content.text}
					origin={message.content.origin}
					goal={message.content.goal}
					createdAt={message.createdAt}
				/>
			);
		case "user_rich":
			return (
				<UserBubble
					text={message.content.text}
					attachments={message.content.attachments}
					attachmentSession={
						environmentId !== undefined
							? { environmentId, sessionId: message.sessionId }
							: undefined
					}
					fileRefs={message.content.fileRefs}
					skillRefs={message.content.skillRefs}
					annotations={message.content.annotations}
					origin={message.content.origin}
					goal={message.content.goal}
					createdAt={message.createdAt}
				/>
			);
		case "assistant":
			return (
				<AssistantBubble
					text={message.content.text}
					createdAt={message.createdAt}
					messageId={message.id}
					sessionId={sessionId}
					forkDestination={forkDestination}
					sourceProjectId={sourceProjectId}
					showMessageCommands={showAssistantCommands}
				/>
			);
		case "thinking":
			return (
				<ThinkingMessageRow
					messageId={message.id}
					sessionId={readOnly ? undefined : sessionId}
					environmentId={environmentId}
					text={message.content.text}
					redacted={message.content.redacted}
				/>
			);
		case "tool_use":
			return (
				<ToolUseMessageRow
					content={message.content}
					createdAt={message.createdAt}
				/>
			);
		case "tool_result":
			return <ToolResultMessageRow content={message.content} />;
		case "user_question":
			return <UserQuestionMessageRow content={message.content} />;
		case "user_question_answer":
			// The paired `user_question` row above renders the answer inline, so
			// the standalone answer row is suppressed.
			return null;
		case "context_compaction":
			return (
				<CompactRow
					beforeTokens={message.content.beforeTokens}
					afterTokens={message.content.afterTokens}
					startedAt={message.content.startedAt}
					durationMs={message.content.durationMs}
					status={message.content.status ?? "completed"}
				/>
			);
		case "usage":
		case "context_usage":
		case "usage_limit":
		case "subagent_progress":
			return null;
		case "error":
			if (readOnly) return <ToolErrorRow output={message.content.message} />;
			// Classify so an auth failure (expired OAuth / 401 / "Please run
			// /login") gets the "Sign in to {provider}" headline + inline login
			// button rather than a bare generic error.
			return (
				<ErrorBubble
					error={classifyMessage(message.content.message, providerId)}
					sessionId={sessionId}
					environmentId={environmentId}
					providerId={providerId}
				/>
			);
		case "interrupted":
			// The user stopped the turn — a normal action, so render a small muted
			// badge rather than an error bubble.
			return (
				<div className="flex justify-center py-1">
					<span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
						{uiMessage("chat:message_row_interrupted_by_user")}
					</span>
				</div>
			);
	}
}

export const MessageRow = memo(MessageRowImpl);
MessageRow.displayName = "MessageRow";

function ThinkingMessageRow({
	messageId,
	sessionId,
	environmentId,
	text,
	redacted,
}: {
	messageId: Message["id"];
	sessionId?: SessionId;
	environmentId?: EnvironmentId;
	text: string;
	redacted: boolean;
}) {
	// Shimmer while this thinking block is the live tip of a running turn.
	const timeline = useOptionalRendererSessionTimeline(
		sessionId ?? null,
		"cache-only",
		environmentId ?? null,
	);
	const turnActive = isSessionTurnActive(timeline.runtime);
	const last = timeline.messages.at(-1);
	const pending = turnActive && last?.id === messageId;
	return <ThinkingRow text={text} redacted={redacted} pending={pending} />;
}

function ToolUseMessageRow({
	content,
	createdAt,
}: {
	content: MessageContent<"tool_use">;
	createdAt: Date;
}) {
	const { resultsByItemId, subagentsByTaskId } = useChatLookups();
	const result = resultsByItemId.get(content.itemId);
	if (content.tool === "ExitPlanMode") {
		return <ExitPlanModeRow input={content.input} result={result} />;
	}
	if (content.tool === "TaskOutput") {
		if (
			subagentTaskIdForBlockingWait(content.input, subagentsByTaskId) !== null
		) {
			return (
				<SubagentWaitRow
					input={content.input}
					result={result}
					startedAt={createdAt}
					subagentsByTaskId={subagentsByTaskId}
				/>
			);
		}
	}
	const normalized = normalizeToolCallEnvelope(
		content.tool,
		content.input,
		result,
	);
	const orch = orchestrationToolName(normalized.tool);
	if (
		orch === "create_thread" ||
		orch === "create_chat" ||
		orch === "create_session" ||
		orch === "send_to_thread"
	) {
		const parsed =
			normalized.result !== undefined
				? parseOrchestrationResult(normalized.result.output)
				: null;
		const renderCard =
			normalized.result === undefined ||
			(!normalized.result.isError &&
				parsed !== null &&
				typeof parsed.chatId === "string");
		if (renderCard) {
			return (
				<OrchestrationThreadRow variant={orch} result={normalized.result} />
			);
		}
	}
	return (
		<ToolRow
			tool={orch ?? normalized.tool}
			input={normalized.input}
			result={normalized.result}
			presentation={
				content.backgroundTask === undefined ? undefined : "background-task"
			}
		/>
	);
}

function ToolResultMessageRow({
	content,
}: {
	content: MessageContent<"tool_result">;
}) {
	const { resultsByItemId } = useChatLookups();
	// Suppress paired results — the matching ToolRow renders them inline.
	// Only orphan errors (no tool_use found, e.g. driver dropped the use
	// event) surface as a standalone error row.
	const paired = resultsByItemId.has(content.itemId);
	if (paired) return null;
	return content.isError ? <ToolErrorRow output={content.output} /> : null;
}

function UserQuestionMessageRow({
	content,
}: {
	content: MessageContent<"user_question">;
}) {
	const { answersByItemId } = useChatLookups();
	// Pending questions live in the composer slot — ChatComposer swaps the
	// editor for a QuestionCard. Once answered, the question + the user's
	// selections render here as a `UserInputRow` accordion so the Q&A
	// stays visible in scrollback like every other tool call.
	const answers = answersByItemId.get(content.itemId);
	if (answers === undefined) return null;
	return <UserInputRow questions={content.questions} answers={answers} />;
}

function CompactRow({
	beforeTokens,
	afterTokens,
	startedAt,
	durationMs,
	status,
}: {
	readonly beforeTokens: number | null;
	readonly afterTokens: number | null;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly status: "in_progress" | "completed";
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [now, setNow] = useState(() => Date.now());
	const inProgress = status === "in_progress";
	useEffect(() => {
		if (!inProgress) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [inProgress]);
	const elapsedMs = inProgress ? Math.max(0, now - startedAt) : durationMs;
	const tokenDelta = formatCompactTokenDelta(beforeTokens, afterTokens);
	const detail =
		tokenDelta === null
			? formatDuration(elapsedMs)
			: `${tokenDelta} · ${formatDuration(elapsedMs)}`;

	return (
		<div className="px-4 py-2 text-muted-foreground">
			<div className="flex items-center gap-2">
				<RefreshIcon
					aria-hidden
					className={cn(
						"size-3.5 shrink-0 opacity-70",
						inProgress && "animate-spin",
					)}
				/>
				<span className="text-sm font-medium text-foreground/90">
					{inProgress
						? uiMessage("chat:message_row_compacting")
						: uiMessage("chat:message_row_chat_compacted")}
				</span>
			</div>
			<div className="mt-1 pl-5 text-[11px] tabular-nums text-muted-foreground/70">
				{detail}
			</div>
		</div>
	);
}

/**
 * Strip the inline chip tokens (`[image:<id>]`, `@<path>`, `$<skill>`) from
 * text we render in the user bubble. The chips are surfaced as visual
 * thumbnails / chips below the bubble, so showing the raw token in-line is
 * just noise. Tokens for chip kinds the row didn't receive (legacy `user`
 * content, copy-pasted text) pass through unchanged.
 */
const stripChipTokens = (
	text: string,
	attachments: ReadonlyArray<AttachmentRef>,
	fileRefs: ReadonlyArray<FileRef>,
	skillRefs: ReadonlyArray<SkillRef>,
): string => {
	let out = text;
	for (const a of attachments) {
		out = out.replaceAll(`[image:${a.id}]`, "");
	}
	// Attachments uploaded but submitted while still holding the renderer-side
	// temp id — we strip them defensively too so the bubble doesn't show
	// `[image:pending-xxx]`.
	out = out.replace(/\[image:pending-[a-z0-9]+\]/gi, "");
	for (const f of fileRefs) {
		out = out.replaceAll(`@${f.relPath}`, "");
	}
	for (const s of skillRefs) {
		out = out.replaceAll(`$${s.name}`, "");
		out = out.replaceAll(`/${s.name}`, "");
	}
	return out.replace(/[ \t]{2,}/g, " ").trim();
};

export function UserBubble({
	text,
	attachments,
	attachmentSession,
	attachmentPreviews,
	fileRefs,
	skillRefs,
	annotations,
	origin,
	goal = false,
	createdAt,
}: {
	text: string;
	attachmentSession?: SessionRef;
	attachmentPreviews?: Readonly<Record<string, string>>;
	attachments?: ReadonlyArray<AttachmentRef>;
	fileRefs?: ReadonlyArray<FileRef>;
	skillRefs?: ReadonlyArray<SkillRef>;
	annotations?: ReadonlyArray<ComposerAnnotation>;
	origin?: MessageOrigin;
	goal?: boolean;
	createdAt?: Date;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const hasAnnotations = annotations !== undefined && annotations.length > 0;
	const revealAnnotation = useRevealAnnotation();
	const { chatsByProject } = useActiveEnvironmentEntities();
	const originChatLoaded =
		origin !== undefined &&
		Object.values(chatsByProject).some((list) =>
			list.some((chat) => chat.id === origin.chatId),
		);
	const hasChips =
		(attachments !== undefined && attachments.length > 0) ||
		(fileRefs !== undefined && fileRefs.length > 0) ||
		(skillRefs !== undefined && skillRefs.length > 0);
	const display = hasChips
		? stripChipTokens(text, attachments ?? [], fileRefs ?? [], skillRefs ?? [])
		: text;
	return (
		<div className={userBubbleRowClass}>
			<div className={userBubbleColumnClass}>
				<div data-chat-user-bubble className={userBubbleClass}>
					{origin !== undefined ? (
						<button
							type="button"
							disabled={!originChatLoaded}
							onClick={() => useChatsStore.getState().select(origin.chatId)}
							className="mb-1.5 flex items-center gap-1.5 text-[11px] text-user-bubble-foreground/65 hover:text-user-bubble-foreground disabled:cursor-default"
							title={
								originChatLoaded
									? uiMessage("chat:message_row_open_the_sender_s_chat")
									: uiMessage("chat:message_row_sender_chat_not_loaded")
							}
						>
							<ProviderIcon providerId={origin.providerId} className="size-3" />
							<span>
								{uiMessage(
									"chat:message_row_sent_by_from_another_chat_sentence",
									{ value: getProviderLabel(origin.providerId) },
								)}
							</span>
						</button>
					) : null}
					{hasAnnotations ? (
						<ol className="mb-2 space-y-1">
							{(annotations ?? []).map((a, i) => (
								<li key={a.id}>
									<button
										type="button"
										onClick={() => {
											if (!isBrowserAnnotation(a)) revealAnnotation(a);
										}}
										disabled={isBrowserAnnotation(a)}
										className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-user-bubble-foreground/12 bg-background/10 px-2 py-1.5 text-left text-xs hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-user-bubble-foreground/30"
										title={
											isBrowserAnnotation(a)
												? uiMessage("chat:message_row_browser_annotation")
												: uiMessage("chat:message_row_open_annotation")
										}
									>
										<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background/20 text-[10px] font-semibold tabular-nums">
											{i + 1}
										</span>
										<span className="grid min-w-0 flex-1 gap-1">
											{isBrowserAnnotation(a) ? (
												<span className="min-w-0 truncate font-medium">
													{browserAnnotationMeta(a)}
												</span>
											) : (
												<AnnotationFileChip annotation={a as CodeAnnotation} />
											)}
											<span className="min-w-0 break-words leading-snug">
												{a.comment}
											</span>
										</span>
									</button>
								</li>
							))}
						</ol>
					) : null}
					{hasChips ? (
						<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
							{(attachments ?? []).map((attachment) => (
								<AttachmentChip
									key={attachment.id}
									attachment={attachment}
									sessionRef={attachmentSession ?? null}
									previewUrl={attachmentPreviews?.[attachment.id]}
								/>
							))}
							{(fileRefs ?? []).map((f) => (
								<FileChip
									key={f.relPath}
									relPath={f.relPath}
									absPath={f.absPath}
									kind={f.kind}
								/>
							))}
							{(skillRefs ?? []).map((s) => (
								<span
									key={s.name}
									className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/90"
								>
									<SkillIcon className="size-3 text-primary/75" />
									{s.name}
								</span>
							))}
						</div>
					) : null}
					{display.length > 0 ? <UserMessageText text={display} /> : null}
					{goal ? (
						<div className="mt-2 flex items-center gap-1.5 text-xs text-user-bubble-foreground/65">
							<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />
							<span>{uiMessage("chat:message_row_sent_as_goal")}</span>
						</div>
					) : null}
				</div>
				<MessageActions
					text={display || text}
					createdAt={createdAt}
					className="mt-1"
				/>
			</div>
		</div>
	);
}

function AssistantBubble({
	text,
	createdAt,
	messageId,
	sessionId,
	forkDestination,
	sourceProjectId,
	showMessageCommands,
}: {
	text: string;
	createdAt?: Date;
	messageId: Message["id"];
	sessionId?: SessionId;
	forkDestination?: ForkDestination;
	sourceProjectId?: FolderId;
	showMessageCommands: boolean;
}) {
	return (
		<div
			data-chat-assistant-bubble
			className="group/assistant px-[var(--chat-assistant-gutter,0.75rem)] py-1.5"
		>
			<div className="max-w-full">
				<MarkdownBody className="chat-assistant-markdown">{text}</MarkdownBody>
				<AssistantMessageActions
					text={text}
					createdAt={createdAt}
					messageId={messageId}
					sessionId={sessionId}
					forkDestination={forkDestination}
					sourceProjectId={sourceProjectId}
					showMessageCommands={showMessageCommands}
					className="mt-1"
				/>
			</div>
		</div>
	);
}

function ToolErrorRow({ output }: { output: unknown }) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const text = typeof output === "string" ? output : stringifyJson(output);
	const firstLine = text.split("\n", 1)[0] ?? "";
	return (
		<div className="px-4">
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				className="group flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent"
			>
				<div className="relative grid size-4 shrink-0 place-items-center">
					<HugeiconsIcon
						icon={AlertCircleIcon}
						strokeWidth={2}
						aria-hidden="true"
						className={cn(
							"col-start-1 row-start-1 size-3.5 text-destructive transition-opacity duration-150 ease-out",
							"group-hover:opacity-0 motion-reduce:transition-none",
						)}
					/>
					<Chevron
						aria-hidden="true"
						className={cn(
							"col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
							"group-hover:opacity-100 motion-reduce:transition-none",
						)}
					/>
				</div>
				<span className="font-medium text-foreground">
					{uiMessage("chat:message_row_error")}
				</span>
				<span className="truncate text-muted-foreground">{firstLine}</span>
			</button>
			{expanded ? (
				<div className="ml-7 mt-1 border-l border-border/60 pl-3">
					<pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
						{text || uiMessage("chat:message_row_empty")}
					</pre>
				</div>
			) : null}
		</div>
	);
}

type RateLimitInfo = {
	readonly resetText?: string;
	readonly period?: "weekly" | "monthly" | "daily";
};

// Parse rate-limit / usage-limit messages emitted by Claude Code, the
// Anthropic SDK, or other providers. We see them as plain strings (the
// wire ErrorEvent carries no structured metadata) so this is best-effort
// pattern matching against the human-readable text.
const parseRateLimit = (text: string): RateLimitInfo | null => {
	const isRateLimit =
		/usage limit|rate[-\s]?limit|quota|429|too many requests|overloaded|hit your limit|reached (?:your |the )?limit|agent reached limit/i.test(
			text,
		);
	if (!isRateLimit) return null;

	const resetMatch =
		text.match(
			/reset(?:s|ing)?(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*\([^)]+\))?)/i,
		) ??
		text.match(
			/(?:try|see|check)\s+again\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*(?:\([^)]+\)|[A-Z][A-Za-z_/-]*(?:\s+time)?))?)/i,
		) ??
		text.match(/reset(?:s|ing)?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}[T0-9:.Z+-]*)/i);

	const lower = text.toLowerCase();
	const period: RateLimitInfo["period"] = lower.includes("monthly")
		? "monthly"
		: lower.includes("weekly")
			? "weekly"
			: lower.includes("daily")
				? "daily"
				: undefined;

	return { resetText: resetMatch?.[1], period };
};

const formatResetDetail = (info: RateLimitInfo): string => {
	if (info.resetText !== undefined) return `Resets ${info.resetText}`;
	if (info.period !== undefined) {
		const label = info.period.charAt(0).toUpperCase() + info.period.slice(1);
		return `${label} limit`;
	}
	return "Try again later";
};

/**
 * "Authentication required" card shown when a login-capable provider reports
 * an auth failure. Reuses the shared `useProviderLogin` flow
 * (open browser → wait for the OAuth callback → done): on success it re-probes
 * availability and clears the bottom error.
 *
 * This card is a *persisted* message in scrollback, so it must not carry sticky
 * per-instance UI: once the provider reports `authenticated` (whether via this
 * card, another duplicate card, Settings, or the terminal) every auth card
 * resolves to nothing. That's what kills the "stuck on Signed in. Resuming…"
 * and the duplicate cards after a successful sign-in.
 */
function ProviderAuthCard({
	providerId,
	sessionId,
	environmentId,
	onOpenSettings,
	onDismiss,
}: {
	providerId: ProviderId;
	sessionId: SessionId | undefined;
	environmentId: EnvironmentId | undefined;
	onOpenSettings: () => void;
	onDismiss?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const refreshProviders = useProvidersStore((s) => s.refresh);
	const authStatus = useProvidersStore(
		(s) => s.availability.find((a) => a.providerId === providerId)?.authStatus,
	);
	const reopenSession = useSessionsStore((s) => s.resume);
	const { state, start, cancel } = useProviderLogin(providerId, {
		onSuccess: () => {
			// Re-probe first so the keychain write has landed and this card
			// resolves (hides) before recovery. Reopen the provider with the fresh
			// credentials, then retry an existing turn or release a fresh chat's
			// queued first message.
			void (async () => {
				await refreshProviders();
				if (sessionId !== undefined && environmentId !== undefined) {
					const ref = { environmentId, sessionId };
					const resumed = await resumeAfterProviderLogin({
						reopen: () => reopenSession(sessionId, environmentId),
						resumeQueue: () => resumeSessionQueue(ref, providerId),
					});
					if (resumed) clearSessionCommandError(ref);
				}
			})();
		},
	});
	const label = getProviderLabel(providerId);

	// Resolved — the provider is authenticated now, so this historical card has
	// nothing left to do. Render nothing (no nag, no spinner, no duplicate).
	if (authStatus === "authenticated") return null;

	return (
		<div className="px-4 py-2">
			<div className="w-fit max-w-[80%] rounded-lg border border-border/60 bg-card px-3 py-2.5 text-xs text-foreground">
				<div className="flex items-center justify-between gap-2">
					<span className="inline-flex items-center gap-1.5 font-medium text-foreground">
						<HugeiconsIcon
							icon={AlertCircleIcon}
							className="size-3.5 text-destructive"
							aria-hidden
						/>
						{uiMessage("chat:message_row_authentication_required")}
					</span>
					{onDismiss !== undefined && (
						<button
							type="button"
							onClick={onDismiss}
							className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							{uiMessage("chat:message_row_dismiss")}
						</button>
					)}
				</div>

				{state.kind === "waiting" ? (
					<div className="mt-2 flex min-h-[3.75rem] flex-col gap-2">
						<div
							className="flex items-center gap-2 text-[11px] text-muted-foreground"
							role="status"
							aria-live="polite"
						>
							<HugeiconsIcon
								icon={Loading02Icon}
								className="size-3.5 animate-spin motion-reduce:animate-none"
								aria-hidden
							/>
							<ShimmerText as="span">
								{state.url === null
									? uiMessage("chat:message_row_starting_sign_in", {
											label: String(label),
										})
									: uiMessage("chat:message_row_waiting_for_browser_sign_in")}
							</ShimmerText>
						</div>
						<div className="flex flex-wrap items-center gap-1.5">
							{state.url !== null && (
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={() => {
										if (state.url !== null) openExternal(state.url);
									}}
									className="gap-1.5"
								>
									<HugeiconsIcon
										icon={LinkSquare01Icon}
										className="size-3"
										aria-hidden
									/>
									{uiMessage("chat:message_row_open_browser_again")}
								</Button>
							)}
							<Button type="button" size="xs" variant="ghost" onClick={cancel}>
								{uiMessage("common:cancel")}
							</Button>
						</div>
					</div>
				) : state.kind === "success" ? (
					<div
						className="mt-2 flex min-h-[3.75rem] items-start gap-2 text-[11px] text-muted-foreground"
						role="status"
						aria-live="polite"
					>
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3.5 animate-spin motion-reduce:animate-none"
							aria-hidden
						/>
						<ShimmerText as="span">
							{uiMessage("chat:message_row_signed_in_finishing")}
						</ShimmerText>
					</div>
				) : (
					<div className="min-h-[3.75rem]">
						<p className="mt-1 leading-relaxed text-muted-foreground">
							{uiMessage(
								"chat:message_row_to_resolve_sign_in_to_we_apos_ll_validate_the_login_automati_sentence",
								{ label: label },
							)}
						</p>
						{state.kind === "failed" && (
							<p className="mt-1 text-[11px] text-destructive">
								{state.reason}
							</p>
						)}
						<div className="mt-2 flex flex-wrap items-center gap-1.5">
							<Button
								type="button"
								size="xs"
								variant="outline"
								onClick={() => void start()}
								className="gap-1.5"
							>
								<HugeiconsIcon icon={PlayIcon} className="size-3" aria-hidden />
								{state.kind === "failed"
									? uiMessage("chat:message_row_try_sign_in_again", {
											label: String(label),
										})
									: uiMessage("chat:message_row_sign_in_to", {
											label: String(label),
										})}
							</Button>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={onOpenSettings}
								className="gap-1"
							>
								<HugeiconsIcon
									icon={Settings01Icon}
									className="size-3"
									aria-hidden
								/>
								{uiMessage("common:settings")}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function CloudProviderAuthCard({
	providerId,
	authMode,
	environmentId,
	onOpenCloudSettings,
	onDismiss,
}: {
	providerId: ProviderId;
	authMode: "legacy-image" | "broker-v1" | "unknown";
	environmentId: EnvironmentId;
	onOpenCloudSettings: () => void;
	onDismiss?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const providerLabel = getProviderLabel(providerId);
	const replacementProjectId = localProjectForCloudEnvironment(environmentId);
	const legacy = authMode === "legacy-image";
	const broker = authMode === "broker-v1";
	return (
		<div className="px-4 py-2">
			<div className="w-fit max-w-[80%] rounded-lg bg-alert-error-bg px-3 py-2.5 text-xs text-foreground">
				<div className="flex items-center justify-between gap-2">
					<span className="inline-flex items-center gap-1.5 font-medium">
						<HugeiconsIcon
							icon={AlertCircleIcon}
							className="size-3.5 text-destructive"
							aria-hidden
						/>
						{legacy
							? uiMessage(
									"chat:message_row_this_cloud_chat_uses_legacy_authentication",
									{ providerLabel: String(providerLabel) },
								)
							: broker
								? uiMessage("chat:message_row_account_needs_reconnecting", {
										providerLabel: String(providerLabel),
									})
								: uiMessage("chat:message_row_authentication_is_unavailable", {
										providerLabel: String(providerLabel),
									})}
					</span>
					{onDismiss !== undefined && (
						<button
							type="button"
							onClick={onDismiss}
							className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							{uiMessage("chat:message_row_dismiss")}
						</button>
					)}
				</div>
				<p className="mt-1.5 max-w-[32rem] text-[11px] leading-4 text-muted-foreground">
					{legacy
						? uiMessage(
								"chat:message_row_its_image_owned_credential_cannot_be_migrated_safely_reconnect_on",
								{ providerLabel: String(providerLabel) },
							)
						: broker
							? uiMessage(
									"chat:message_row_reconnect_once_in_cloud_workspace_settings_the_account_credential",
									{ providerLabel: String(providerLabel) },
								)
							: uiMessage(
									"chat:message_row_open_cloud_workspace_settings_to_restore_account_level_authentica",
									{ providerLabel: String(providerLabel) },
								)}
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					{legacy && replacementProjectId !== null ? (
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={() => openNewChatLanding(replacementProjectId)}
						>
							{uiMessage("chat:message_row_create_replacement_chat")}
						</Button>
					) : null}
					<Button
						type="button"
						size="xs"
						variant={legacy ? "ghost" : "outline"}
						onClick={onOpenCloudSettings}
					>
						<HugeiconsIcon
							icon={Settings01Icon}
							className="size-3"
							aria-hidden
						/>
						{uiMessage("chat:message_row_open_cloud_authentication")}
					</Button>
				</div>
			</div>
		</div>
	);
}

const GEMINI_UPGRADE_COMMAND = "npm i -g @google/gemini-cli@latest";

const isGeminiAcpUpgradeError = (text: string): boolean =>
	/Gemini CLI.*(?:does not support ACP|--experimental-acp)|Unknown arguments?:.*(?:experimental-acp|experimentalAcp)/is.test(
		text,
	);

function GeminiUpgradeCard({ onDismiss }: { onDismiss?: () => void }) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [copied, setCopied] = useState(false);
	const copyCommand = () => {
		void navigator.clipboard.writeText(GEMINI_UPGRADE_COMMAND).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		});
	};

	return (
		<div className="px-4 py-2">
			<div className="max-w-[34rem] rounded-xl border border-warning/25 bg-alert-warning-bg px-4 py-3 text-xs text-foreground shadow-sm">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-warning/12 text-warning">
						<HugeiconsIcon
							icon={AlertCircleIcon}
							strokeWidth={2}
							aria-hidden="true"
							className="size-4"
						/>
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium text-foreground">
							{uiMessage("chat:message_row_gemini_cli_needs_an_upgrade")}
						</div>
						<p className="mt-1 leading-relaxed text-muted-foreground">
							{uiMessage(
								"chat:message_row_your_installed_gemini_cli_does_not_support_acp_mode_yet_so_zuse_zuse_b",
							)}
						</p>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<code className="rounded-md border border-border/60 bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground">
								{GEMINI_UPGRADE_COMMAND}
							</code>
							<Button size="xs" variant="outline" onClick={copyCommand}>
								{copied ? (
									<HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
								) : (
									<HugeiconsIcon icon={Copy01Icon} className="size-3.5" />
								)}
								{copied
									? uiMessage("common:copied")
									: uiMessage("chat:message_row_copy_upgrade_command")}
							</Button>
							{onDismiss !== undefined && (
								<Button size="xs" variant="ghost" onClick={onDismiss}>
									{uiMessage("chat:message_row_dismiss")}
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function ErrorBubble({
	error,
	sessionId,
	environmentId,
	providerId,
	onDismiss,
}: {
	error: ChatError;
	sessionId?: SessionId;
	environmentId?: EnvironmentId;
	providerId?: ProviderId;
	onDismiss?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const cloudSummary = useCloudChatCatalogStore((state) =>
		environmentId === undefined
			? null
			: (state.summaries.find(
					(summary) => summary.workspaceId === environmentId,
				) ?? null),
	);

	const onRetry = () => {
		if (sessionId !== undefined && environmentId !== undefined) {
			void retryLastSessionMessage({ environmentId, sessionId }, providerId);
		}
	};
	const onKeepGoing = () => {
		if (sessionId !== undefined && environmentId !== undefined) {
			void sendSessionMessage({ environmentId, sessionId }, "keep going", {
				providerId,
			});
		}
	};
	const onOpenSettings = () => {
		setView("settings");
		setSettingsSection({ kind: "providers" });
	};
	const onOpenCloudSettings = () => {
		setView("settings");
		setSettingsSection({ kind: "machines" });
	};

	if (isGeminiAcpUpgradeError(error.message)) {
		return <GeminiUpgradeCard onDismiss={onDismiss} />;
	}

	const rateLimit = parseRateLimit(error.message);
	if (rateLimit !== null) {
		return (
			<div className="px-4 py-1.5">
				<div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
					<span className="font-medium">
						{uiMessage("chat:message_row_limit_reached")}
					</span>
					<span className="text-muted-foreground">
						{formatResetDetail(rateLimit)}
					</span>
					{onDismiss !== undefined && (
						<button
							type="button"
							onClick={onDismiss}
							className="rounded-[0.1875rem] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							aria-label={uiMessage("chat:message_row_dismiss_limit_status")}
						>
							{uiMessage("chat:message_row_dismiss")}
						</button>
					)}
				</div>
			</div>
		);
	}

	const reconnecting = parseReconnectingStatus(error.message);
	if (reconnecting !== null) {
		const isFinalAttempt = reconnecting.attempt >= reconnecting.maxAttempts;
		return (
			<div className="px-4 py-1.5">
				<div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
					<span className="font-medium">
						{uiMessage("chat:message_row_reconnecting")}
					</span>
					<span className="font-mono text-muted-foreground">
						{reconnecting.attempt}/{reconnecting.maxAttempts}
					</span>
					{isFinalAttempt && (
						<>
							<span className="h-3 w-px bg-border/60" aria-hidden="true" />
							<button
								type="button"
								onClick={onKeepGoing}
								disabled={sessionId === undefined}
								className="rounded-[0.1875rem] bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground transition-colors hover:bg-secondary/90"
							>
								{uiMessage("common:retry")}
							</button>
						</>
					)}
					{onDismiss !== undefined && (
						<button
							type="button"
							onClick={onDismiss}
							className="rounded-[0.1875rem] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							aria-label={uiMessage(
								"chat:message_row_dismiss_reconnecting_status",
							)}
						>
							{uiMessage("chat:message_row_dismiss")}
						</button>
					)}
				</div>
			</div>
		);
	}

	// Auth failure for a provider we can sign into in-app → the dedicated
	// "Authentication required" card with the one-click OAuth button. Other
	// providers (or auth errors without a provider) fall through to the generic
	// bubble below with a "Open Provider Settings" link.
	if (error.kind === "auth" && error.providerId !== undefined) {
		if (
			environmentId !== undefined &&
			isCloudWorkspaceEnvironment(environmentId) &&
			["claude", "codex", "cursor", "grok"].includes(error.providerId)
		) {
			return (
				<CloudProviderAuthCard
					providerId={error.providerId}
					authMode={
						error.providerId === "codex"
							? (cloudSummary?.codexAuthMode ?? "unknown")
							: (cloudSummary?.providerAuthMode ?? "unknown")
					}
					environmentId={environmentId}
					onOpenCloudSettings={onOpenCloudSettings}
					onDismiss={onDismiss}
				/>
			);
		}
		if (supportsProviderLogin(error.providerId))
			return (
				<ProviderAuthCard
					providerId={error.providerId}
					sessionId={sessionId}
					environmentId={environmentId}
					onOpenSettings={onOpenSettings}
					onDismiss={onDismiss}
				/>
			);
	}

	const headline =
		error.kind === "auth"
			? `Sign in to ${
					error.providerId
						? getProviderLabel(error.providerId)
						: "your provider"
				}`
			: error.kind === "network"
				? "Connection lost"
				: error.kind === "terminal"
					? error.headline
					: null;

	const iconTone =
		error.kind === "auth"
			? "text-destructive"
			: error.kind === "network"
				? "text-warning"
				: "text-destructive";
	const bg =
		error.kind === "network" ? "bg-alert-warning-bg" : "bg-alert-error-bg";

	return (
		<div className="py-2">
			<div
				className={cn(
					"w-full rounded-xl px-3 py-2 text-xs text-foreground",
					bg,
				)}
			>
				<div className="flex min-w-0 items-start gap-2">
					<HugeiconsIcon
						icon={AlertCircleIcon}
						strokeWidth={2}
						aria-hidden="true"
						className={cn("mt-px size-3.5 shrink-0", iconTone)}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						{headline !== null ? (
							<span className="font-medium text-foreground">{headline}</span>
						) : (
							<span className="font-medium text-foreground">
								{uiMessage("chat:message_row_provider_error")}
							</span>
						)}
						<pre className="min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
							{error.message || uiMessage("chat:message_row_empty")}
						</pre>
						{sessionId !== undefined && error.kind !== "terminal" && (
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={onRetry}
									className="gap-1"
								>
									<RefreshIcon className="size-3" aria-hidden />
									{uiMessage("common:retry")}
								</Button>
								{error.kind === "auth" && (
									<Button
										type="button"
										size="xs"
										variant="ghost"
										onClick={onOpenSettings}
										className="gap-1"
									>
										<HugeiconsIcon
											icon={Settings01Icon}
											className="size-3"
											aria-hidden
										/>
										{uiMessage("chat:message_row_open_provider_settings")}
									</Button>
								)}
							</div>
						)}
					</div>
					{onDismiss !== undefined && (
						<button
							type="button"
							onClick={onDismiss}
							className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							{uiMessage("chat:message_row_dismiss")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

const truncate = (name: string): string =>
	name.length > 28 ? `${name.slice(0, 25)}...` : name;

function AttachmentChip({
	attachment: a,
	sessionRef,
	previewUrl,
}: {
	attachment: AttachmentRef;
	previewUrl?: string;
	sessionRef: SessionRef | null;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const isImage = a.mimeType.startsWith("image/");
	const preview = useAttachmentUrl(isImage ? sessionRef : null, a.id);
	const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
	const candidate =
		previewUrl ??
		(sessionRef === null || !isImage
			? a.id.startsWith("pending-")
				? null
				: attachmentUrl(a.id)
			: preview.src);
	const src = candidate === brokenSrc ? null : candidate;
	const className =
		"inline-flex items-center gap-1.5 rounded-md border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 hover:bg-[color-mix(in_oklch,var(--chip-bg)_80%,var(--foreground)_4%)] hover:text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]";
	const inner = (
		<>
			{isImage && src !== null ? (
				<img
					src={src}
					alt=""
					onError={() => setBrokenSrc(src)}
					className="size-4 shrink-0 rounded object-cover"
				/>
			) : isImage ? (
				<span
					className="flex size-4 shrink-0 items-center justify-center rounded bg-muted/30 text-[10px] text-muted-foreground"
					role="status"
					aria-label={
						preview.failed || brokenSrc !== null
							? uiMessage("chat:message_row_retry_preview")
							: uiMessage("chat:message_row_preparing_image")
					}
				>
					{preview.failed || brokenSrc !== null ? "↻" : "…"}
				</span>
			) : (
				<FileIcon
					name={a.originalName}
					kind="file"
					className="inline-flex size-4 shrink-0 items-center justify-center"
				/>
			)}
			<span className="truncate">{truncate(a.originalName)}</span>
		</>
	);
	if (isImage) {
		return (
			<button
				key={a.id}
				type="button"
				title={
					preview.failed || brokenSrc !== null
						? uiMessage("chat:message_row_could_not_load_image_click_to_retry")
						: a.originalName
				}
				className={className}
				disabled={src === null && !preview.failed && brokenSrc === null}
				onClick={() => {
					if (src === null) {
						setBrokenSrc(null);
						preview.retry();
						return;
					}
					const open = (previewSrc: string) =>
						useUiStore.getState().openFileInTab({
							kind: "image",
							src: previewSrc,
							name: a.originalName,
						});
					if (src.startsWith("blob:")) {
						// The draft owns this URL and releases it after upload. An open
						// image tab needs its own portable copy.
						void fetch(src)
							.then((response) => response.arrayBuffer())
							.then((bytes) =>
								open(attachmentDataUrl(new Uint8Array(bytes), a.mimeType)),
							)
							.catch(() => setBrokenSrc(src));
					} else open(src);
				}}
			>
				{inner}
			</button>
		);
	}
	return (
		<a
			key={a.id}
			href={src ?? undefined}
			target="_blank"
			rel="noreferrer"
			title={
				preview.failed || brokenSrc !== null
					? uiMessage("chat:message_row_could_not_load_image_click_to_retry")
					: a.originalName
			}
			className={className}
		>
			{inner}
		</a>
	);
}
