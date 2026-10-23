import {
	isHtmlRenderTool,
	readHtmlRenderResult,
} from "@zuse/client-runtime/html-render";
import { isGenerateImageTool } from "@zuse/client-runtime/tool-image-result";
import { providerDisplayName } from "~/lib/provider-labels";
import { useStreamingText } from "../hooks/use-streaming-text.ts";
import { useMastersStore } from "../store/masters.ts";
import { ContextPill, contextPillClass } from "./context-pill.tsx";
import { GeneratedImageCard } from "./generated-image-card.tsx";
import { HtmlVisual } from "./html-visual.tsx";
import "@zuse/i18n/english/common";
import { formatNumber as formatUiNumber } from "@zuse/i18n";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type {
	AttachmentRef,
	BrowserAnnotation,
	ComposerAnnotation,
	FileRef,
	FolderId,
	ForkDestination,
	Message,
	MessageOrigin,
	MessageSource,
	ProviderId,
	SessionId,
	SkillRef,
} from "@zuse/contracts";
import { EnvironmentId, findModelDescriptor } from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { AlertCircleIcon, DashboardSpeedIcon } from "@zuse/icons/solid-rounded";
import {
	ChevronDown,
	ChevronRight,
	RefreshCw as RefreshIcon,
} from "lucide-react";
import {
	lazy,
	memo,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import { FileIcon } from "~/components/file-icon";
import {
	attachmentDataUrl,
	downloadAttachment,
	useAttachmentUrl,
} from "~/lib/attachments";
import {
	CHAT_MESSAGE_ATTRIBUTE,
	CHAT_SOURCE_ATTRIBUTE,
	chatSelectionSource,
} from "~/lib/chat-selection";
import { spawnDelegationMember } from "~/lib/delegation-display";
import { useEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { formatError } from "~/lib/format-error";
import {
	orchestrationToolName,
	parseOrchestrationResult,
} from "~/lib/orchestration-tools";
import { attachmentUrl } from "~/lib/platform-capabilities";
import { describeProviderError } from "~/lib/provider-error-notice";
import { type ChatError, classifyErrorContent } from "~/lib/session-actions";
import { openSession } from "~/lib/session-navigation";
import { isSessionTurnActive } from "~/lib/session-runtime-state";
import { useOptionalRendererSessionTimeline } from "~/lib/session-timeline-hooks.ts";
import { subagentTaskIdForBlockingWait } from "~/lib/subagent-wait";
import { normalizeToolCallEnvelope } from "~/lib/tool-call-envelope";
import { cn } from "~/lib/utils";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog";
import { useModelCatalogStore } from "~/store/model-catalog";
import { useUiStore } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";
import { useRevealAnnotation } from "./annotation/annotation-navigation.ts";
import { ChatAnnotationChip } from "./annotation/chat-annotation-chip.tsx";
import {
	AssistantMessageActions,
	MessageActions,
} from "./assistant-message-actions.tsx";
import { useChatLookups } from "./chat-lookups.tsx";
import { CopyButton } from "./copy-button.tsx";
import { DelegationGroup } from "./delegation-group.tsx";
import { AnnotationFileChip, FileChip } from "./file-chip.tsx";
import { MessageSourceHeader } from "./message-source-header.tsx";
import { useProviderErrorCopy } from "./provider-error-copy.ts";
import { ProviderIcon } from "./provider-icons.tsx";
import { SkillIcon } from "./skill-icon.tsx";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "./ui/collapsible.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import { UiSpecFallback } from "./ui-spec-fallback.tsx";
import { UserMessageText } from "./user-message-text.tsx";

const UiSpecBlock = lazy(() =>
	import("./ui-spec-block.tsx").then((module) => ({
		default: module.UiSpecBlock,
	})),
);

const _isBrowserAnnotation = (
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

function MessageRowImpl({
	message,
	sessionId,
	environmentId,
	providerId,
	readOnly = false,
	showAssistantCommands = false,
	smoothStreaming = false,
	forkDestination,
	sourceProjectId,
	interactive = false,
}: {
	message: Message;
	sessionId?: SessionId;
	environmentId?: EnvironmentId;
	providerId?: ProviderId;
	readOnly?: boolean;
	showAssistantCommands?: boolean;
	smoothStreaming?: boolean;
	forkDestination?: ForkDestination;
	sourceProjectId?: FolderId;

	interactive?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	switch (message.content._tag) {
		case "user":
			return (
				<UserBubble
					text={message.content.text}
					origin={message.content.origin}
					origins={message.content.origins}
					source={message.content.source}
					environmentId={environmentId}
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
					origins={message.content.origins}
					source={message.content.source}
					environmentId={environmentId}
					goal={message.content.goal}
					createdAt={message.createdAt}
				/>
			);
		case "assistant":
			return (
				<AssistantBubble
					smoothStreaming={smoothStreaming}
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
					sessionRef={
						environmentId
							? { environmentId, sessionId: message.sessionId }
							: undefined
					}
					content={message.content}
					createdAt={message.createdAt}
				/>
			);
		case "tool_result":
			return <ToolResultMessageRow content={message.content} />;
		case "user_question":
			return <UserQuestionMessageRow content={message.content} />;
		case "user_question_answer":
			if (message.content.resolution)
				return (
					<div className="px-4 py-2 text-xs text-muted-foreground">
						{uiMessage(
							message.content.resolution === "timed-out"
								? "chat:question_timed_out"
								: "chat:question_cancelled",
						)}
					</div>
				);

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
		case "ui_spec":
			return (
				<div className="px-[var(--chat-assistant-gutter,0.75rem)] py-1.5">
					<ErrorBoundary
						resetKey={message.content.spec}
						fallback={<UiSpecFallback spec={message.content.spec} reason="" />}
					>
						<Suspense
							fallback={
								<div
									className="h-24 animate-pulse rounded-lg bg-muted/40"
									aria-busy="true"
								/>
							}
						>
							<UiSpecBlock
								spec={message.content.spec}
								messageId={message.id}
								sessionRef={
									interactive && !readOnly && environmentId !== undefined
										? { environmentId, sessionId: message.sessionId }
										: undefined
								}
							/>
						</Suspense>
					</ErrorBoundary>
				</div>
			);
		case "usage":
		case "context_usage":
		case "usage_limit":
		case "subagent_progress":
			return null;
		case "error": {
			if (readOnly) return <ToolErrorRow output={message.content.message} />;

			return (
				<ProviderErrorRow
					error={classifyErrorContent(message.content, providerId)}
					providerId={providerId}
					environmentId={environmentId}
				/>
			);
		}
		case "model_switch":
			return <ModelSwitchRow content={message.content} />;
		case "interrupted":
			return (
				<div className="flex justify-center py-1">
					<span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
						{uiMessage("chat:message_row_interrupted_by_user")}
					</span>
				</div>
			);
	}
}

function SelectableMessageRow(props: Parameters<typeof MessageRowImpl>[0]) {
	const source = chatSelectionSource(props.message.content);
	const row = <MessageRowImpl {...props} />;
	if (source === null) return row;
	return (
		<div
			className="contents"
			{...{
				[CHAT_MESSAGE_ATTRIBUTE]: props.message.id,
				[CHAT_SOURCE_ATTRIBUTE]: source,
			}}
		>
			{row}
		</div>
	);
}

export const MessageRow = memo(SelectableMessageRow);
MessageRow.displayName = "MessageRow";

function ModelSwitchLabel({
	providerId,
	children,
}: {
	providerId: ProviderId;
	children?: ReactNode;
}) {
	return (
		<span className="inline-flex items-center gap-1 align-middle">
			<ProviderIcon
				providerId={providerId}
				className="size-3 shrink-0"
				aria-hidden="true"
			/>
			<span>{children}</span>
		</span>
	);
}

function ModelSwitchRow({
	content,
}: {
	content: MessageContent<"model_switch">;
}) {
	const { message } = useUiMessages(["chat"]);
	const catalog = useModelCatalogStore((state) => state.catalog);
	const from =
		findModelDescriptor(catalog, content.fromProviderId, content.fromModel)
			?.label ?? content.fromModel;
	const to =
		findModelDescriptor(catalog, content.toProviderId, content.toModel)
			?.label ?? content.toModel;
	return (
		<div className="flex items-start justify-center gap-1.5 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
			<p className="min-w-0 text-center [overflow-wrap:anywhere]">
				<RichMessage
					id="chat:message_row_model_switched"
					values={{ from, to }}
					components={{
						from: <ModelSwitchLabel providerId={content.fromProviderId} />,
						to: <ModelSwitchLabel providerId={content.toProviderId} />,
					}}
				/>
				<span className="px-1.5" aria-hidden="true">
					·
				</span>
				{message(
					content.context === "handoff"
						? "chat:message_row_context_handed_off"
						: "chat:message_row_context_preserved",
				)}
			</p>
		</div>
	);
}

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
	sessionRef,
	content,
	createdAt,
}: {
	sessionRef?: SessionRef;
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
	if (
		sessionRef &&
		isHtmlRenderTool(normalized.tool) &&
		normalized.result &&
		!normalized.result.isError
	) {
		const visual = readHtmlRenderResult(normalized.result.output);
		if (visual) return <HtmlVisual visual={visual} sessionRef={sessionRef} />;
	}
	if (isGenerateImageTool(normalized.tool)) {
		return (
			<GeneratedImageCard result={normalized.result} startedAt={createdAt} />
		);
	}
	const spawn = spawnDelegationMember(
		content.itemId,
		content,
		createdAt,
		result,
	);
	if (spawn !== null) {
		return (
			<DelegationGroup
				members={[spawn]}
				providerId={null}
				parentLive={false}
				chatRef={null}
				environmentId={sessionRef?.environmentId}
			/>
		);
	}
	const orch = orchestrationToolName(normalized.tool);
	if (orch === "send_to_thread") {
		const parsed =
			normalized.result !== undefined
				? parseOrchestrationResult(normalized.result.output)
				: null;
		if (
			normalized.result === undefined ||
			(!normalized.result.isError && typeof parsed?.chatId === "string")
		) {
			return <OrchestrationThreadRow result={normalized.result} />;
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

	const answers = answersByItemId.get(content.itemId);
	if (answers === undefined || answers.length === 0) return null;
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
	readonly status: "in_progress" | "completed" | "failed";
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
		<div className="flex min-w-0 items-center gap-2 px-4 py-2 text-muted-foreground">
			<RefreshIcon
				aria-hidden
				className={cn(
					"size-3.5 shrink-0 opacity-70",
					inProgress && "animate-spin",
				)}
			/>
			<span className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground/90">
				{inProgress
					? uiMessage("chat:message_row_compacting")
					: status === "failed"
						? uiMessage("chat:message_row_compaction_failed")
						: uiMessage("chat:message_row_chat_compacted")}
			</span>
			<span
				className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground/70"
				title={detail}
			>
				{detail}
			</span>
		</div>
	);
}

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
	origins,
	source,
	environmentId,
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
	origins?: ReadonlyArray<MessageOrigin>;
	/** External chat attribution; its `text` replaces the agent-facing prompt. */
	source?: MessageSource;
	environmentId?: EnvironmentId;
	goal?: boolean;
	createdAt?: Date;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const hasAnnotations = annotations !== undefined && annotations.length > 0;
	const revealAnnotation = useRevealAnnotation();
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const senderEnvironmentId =
		environmentId ?? attachmentSession?.environmentId ?? activeEnvironmentId;
	const sources = origins ?? (origin ? [origin] : []);
	const { chatsByProject, sessionsByProject } = useEnvironmentEntities(
		senderEnvironmentId,
		sources.length > 0,
	);
	const hasChips =
		(attachments !== undefined && attachments.length > 0) ||
		(fileRefs !== undefined && fileRefs.length > 0) ||
		(skillRefs !== undefined && skillRefs.length > 0);
	const display =
		source !== undefined
			? source.text
			: hasChips
				? stripChipTokens(
						text,
						attachments ?? [],
						fileRefs ?? [],
						skillRefs ?? [],
					)
				: text;
	return (
		<div className={userBubbleRowClass}>
			<div className={userBubbleColumnClass}>
				{hasAnnotations ? (
					<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
						{(annotations ?? [])
							.filter((a) => "_tag" in a && a._tag === "context")
							.map((a) => (
								<ContextPill key={a.id} label={"label" in a ? a.label : ""}>
									<MarkdownBody githubHtml>{a.comment}</MarkdownBody>
								</ContextPill>
							))}
						{(annotations ?? []).some(
							(a) => !("_tag" in a) || a._tag !== "context",
						) ? (
							<ContextPill
								label={`${(annotations ?? []).filter((a) => !("_tag" in a) || a._tag !== "context").length} ${uiMessage("chat:annotation_tray_annotations")}`}
							>
								<div className="divide-y divide-border/40">
									{(annotations ?? [])
										.filter((a) => !("_tag" in a) || a._tag !== "context")
										.map((a) => (
											<div key={a.id} className="space-y-1 p-2">
												{"_tag" in a && a._tag === "chat" ? (
													<ChatAnnotationChip annotation={a} />
												) : "_tag" in a ? (
													<span className="text-muted-foreground">
														{a._tag === "browser"
															? browserAnnotationMeta(a)
															: a.label}
													</span>
												) : (
													<button
														type="button"
														onClick={() => revealAnnotation(a)}
													>
														<AnnotationFileChip annotation={a} />
													</button>
												)}
												<MarkdownBody githubHtml>{a.comment}</MarkdownBody>
											</div>
										))}
								</div>
							</ContextPill>
						) : null}
					</div>
				) : null}
				{hasChips ? (
					<div className="mb-1.5 flex flex-wrap items-center justify-end gap-1.5">
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
								className={contextPillClass}
							/>
						))}
						{(skillRefs ?? []).map((s) => (
							<span key={s.name} className={contextPillClass}>
								<SkillIcon className="size-3 text-primary/75" />
								{s.name}
							</span>
						))}
					</div>
				) : null}

				{display.length > 0 ||
				sources.length > 0 ||
				source !== undefined ||
				goal ? (
					<div data-chat-user-bubble className={userBubbleClass}>
						{source !== undefined ? (
							<MessageSourceHeader source={source} text={text} />
						) : null}
						{sources.map((source) => {
							const session = Object.values(sessionsByProject)
								.flat()
								.find(
									(candidate) =>
										candidate.id === source.sessionId &&
										candidate.chatId === source.chatId,
								);
							const chat = Object.values(chatsByProject)
								.flat()
								.find((candidate) => candidate.id === source.chatId);
							const available =
								Boolean(source.masterId && source.environmentId) ||
								(session !== undefined &&
									chat !== undefined &&
									session.archivedAt === null &&
									chat.archivedAt === null);
							const name =
								session?.title?.trim() ||
								source.title?.trim() ||
								providerDisplayName(source.providerId);
							return (
								<button
									key={`${source.chatId}:${source.sessionId}`}
									type="button"
									disabled={!available}
									onClick={() => {
										if (source.masterId && source.environmentId) {
											useMastersStore.getState().select({
												masterId: source.masterId,
												environmentId: source.environmentId,
											});
											return;
										}
										void openSession({
											environmentId: EnvironmentId.make(senderEnvironmentId),
											sessionId: source.sessionId,
										}).catch((cause) =>
											useWorkspaceStore.setState({ error: formatError(cause) }),
										);
									}}
									className="mb-1.5 flex max-w-full items-center gap-1.5 text-[11px] text-user-bubble-foreground/65 hover:text-user-bubble-foreground disabled:cursor-default"
									title={
										available
											? uiMessage("chat:message_row_open_the_sender_s_chat")
											: uiMessage("chat:message_row_sender_chat_not_loaded")
									}
								>
									<ProviderIcon
										providerId={source.providerId}
										className="size-3 shrink-0"
									/>
									<span className="truncate">
										{uiMessage("chat:message_row_sent_by_sender", {
											value: name,
										})}
									</span>
								</button>
							);
						})}
						{display.length > 0 ? <UserMessageText text={display} /> : null}
						{goal ? (
							<div className="mt-2 flex items-center gap-1.5 text-xs text-user-bubble-foreground/65">
								<HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />
								<span>{uiMessage("chat:message_row_sent_as_goal")}</span>
							</div>
						) : null}
					</div>
				) : null}
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
	smoothStreaming,
	text,
	createdAt,
	messageId,
	sessionId,
	forkDestination,
	sourceProjectId,
	showMessageCommands,
}: {
	smoothStreaming: boolean;
	text: string;
	createdAt?: Date;
	messageId: Message["id"];
	sessionId?: SessionId;
	forkDestination?: ForkDestination;
	sourceProjectId?: FolderId;
	showMessageCommands: boolean;
}) {
	const visibleText = useStreamingText(text, smoothStreaming);
	return (
		<div
			data-chat-assistant-bubble
			className="group/assistant px-[var(--chat-assistant-gutter,0.75rem)] py-1.5"
		>
			<div className="max-w-full">
				<MarkdownBody className="chat-assistant-markdown">
					{visibleText}
				</MarkdownBody>
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

function ProviderErrorRow({
	error,
	providerId,
	environmentId,
}: {
	error: ChatError;
	providerId?: ProviderId;
	environmentId?: EnvironmentId;
}) {
	const describe = useProviderErrorCopy(environmentId);
	const [open, setOpen] = useState(false);
	const notice = describeProviderError(error, providerId, environmentId);
	const copy = describe(notice, error);
	const fullText = error.message.trim();

	const quiet =
		notice.kind !== "generic" &&
		notice.kind !== "terminal" &&
		notice.kind !== "network";
	const summary = (
		<>
			<span className="font-medium text-foreground/90">{copy.title}</span>
			{copy.detail.length > 0 ? (
				<span className="min-w-0 truncate text-muted-foreground">
					{copy.detail}
				</span>
			) : null}
		</>
	);
	const icon = (
		<HugeiconsIcon
			icon={AlertCircleIcon}
			strokeWidth={2}
			aria-hidden="true"
			className={cn(
				"col-start-1 row-start-1 size-3.5",
				quiet ? "text-muted-foreground" : "text-destructive/80",
			)}
		/>
	);

	if (fullText.length === 0)
		return (
			<div className="px-4 py-0.5">
				<div className="flex min-w-0 max-w-full items-center gap-2 px-1.5 py-0.5 text-xs">
					<span className="grid size-4 shrink-0 place-items-center">
						{icon}
					</span>
					{summary}
				</div>
			</div>
		);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="px-4 py-0.5">
			<CollapsibleTrigger className="group flex w-fit min-w-0 max-w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
				<span className="grid size-4 shrink-0 place-items-center">
					<span
						className={cn(
							"col-start-1 row-start-1 grid place-items-center transition-opacity duration-150 ease-out motion-reduce:transition-none",
							open ? "opacity-0" : "group-hover:opacity-0",
						)}
					>
						{icon}
					</span>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"col-start-1 row-start-1 size-3.5 text-muted-foreground transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
							open
								? "rotate-90 opacity-100"
								: "opacity-0 group-hover:opacity-100",
						)}
					/>
				</span>
				{summary}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="group/error relative mt-1 mb-1.5 ml-[1.625rem] w-fit max-w-[min(46rem,calc(100%-1.625rem))] rounded-lg bg-muted/40">
					<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words py-2 pr-9 pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground select-text [overflow-wrap:anywhere]">
						{fullText}
					</pre>
					<CopyButton
						text={fullText}
						className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/error:opacity-100 focus-visible:opacity-100"
					/>
				</div>
			</CollapsiblePanel>
		</Collapsible>
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
	const className = contextPillClass;
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
	if (sessionRef !== null) {
		return (
			<AttachmentDownloadButton
				key={JSON.stringify([
					sessionRef.environmentId,
					sessionRef.sessionId,
					a.id,
				])}
				refValue={sessionRef}
				attachment={a}
			>
				{inner}
			</AttachmentDownloadButton>
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

function AttachmentDownloadButton({
	refValue,
	attachment,
	children,
}: {
	refValue: SessionRef;
	attachment: AttachmentRef;
	children: ReactNode;
}) {
	const { message } = useUiMessages(["common"]);
	const request = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => () => request.current?.abort(), []);
	return (
		<button
			type="button"
			className={contextPillClass}
			disabled={busy || attachment.id.startsWith("pending-")}
			aria-busy={busy}
			title={error ?? attachment.originalName}
			onClick={() => {
				if (request.current !== null) return;
				const controller = new AbortController();
				request.current = controller;
				setBusy(true);
				setError(null);
				void downloadAttachment(refValue, attachment.id, controller.signal)
					.catch((cause: unknown) => {
						if (!controller.signal.aborted) setError(formatError(cause));
					})
					.finally(() => {
						if (!controller.signal.aborted) {
							request.current = null;
							setBusy(false);
						}
					});
			}}
		>
			{children}
			{busy ? (
				<span role="status">{message("common:loading")}</span>
			) : error !== null ? (
				<span role="alert">{message("common:retry")}</span>
			) : null}
		</button>
	);
}
