import "@zuse/i18n/english/chat";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ProviderId } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	ArrowRight01Icon,
	BotIcon,
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	CircleDashedIcon,
	MinusSignCircleIcon,
	SourceCodeIcon,
	WorkflowSquare03Icon,
} from "@zuse/icons/stroke-rounded";
import { useMemo, useState } from "react";
import type {
	DelegationStatus,
	DelegationView,
} from "~/lib/delegation-display";
import { cn } from "~/lib/utils";
import {
	type WorkflowAgentStatus,
	type WorkflowAgentView,
	type WorkflowSection,
	workflowInput,
	workflowMetadata,
	workflowProgress,
	workflowSections,
} from "~/lib/workflow-display";
import { CodeBlock } from "./code-block.tsx";
import {
	DelegationElapsed,
	type DelegationInlineBody,
	DelegationRow,
	useDelegationStatusLabel,
} from "./delegation-row.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const VISIBLE_AGENTS = 6;
const SCRIPT_HEIGHT = 360;

type PhaseState = "pending" | "active" | "done" | "failed" | "stopped";

const phaseState = (
	section: WorkflowSection,
	run: DelegationStatus,
): PhaseState => {
	const { agents } = section;
	if (agents.some((agent) => agent.status === "failed")) return "failed";
	if (
		agents.some(
			(agent) => agent.status === "working" || agent.status === "queued",
		)
	)
		return "active";
	if (agents.length > 0 && agents.every((agent) => agent.status === "done"))
		return "done";
	if (agents.length > 0 || run !== "working") return "stopped";
	return "pending";
};

const RUN_TONE: Record<DelegationStatus, string> = {
	working: "text-lime-300",
	done: "text-emerald-400",
	failed: "text-destructive",
	stopped: "text-muted-foreground",
};

/**
 * A native workflow run as a board: one column per phase, left to right in
 * script order, with each agent as a tile. Selecting a tile shows what it was
 * asked and what it returned. Columns stack when the transcript is narrow.
 */
export function WorkflowRun({
	input,
	view,
	onOpen = null,
	inline = null,
}: {
	readonly input: unknown;
	readonly view: DelegationView;
	readonly onOpen?: (() => void) | null;
	readonly inline?: DelegationInlineBody | null;
}) {
	const { message } = useMessages(["chat"]);
	const statusLabel = useDelegationStatusLabel();
	const record = workflowInput(input);
	const scriptPath =
		typeof record.scriptPath === "string" ? record.scriptPath : null;
	const script =
		scriptPath === null && typeof record.script === "string"
			? record.script
			: null;
	const meta = useMemo(
		() => (script === null ? null : workflowMetadata(script)),
		[script],
	);
	const progress = workflowProgress(input);
	const sections = useMemo(
		() => workflowSections(meta?.phases ?? [], progress, view.status),
		[meta, progress, view.status],
	);
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const [scriptOpen, setScriptOpen] = useState(false);
	const name =
		(typeof record.workflow_name === "string"
			? record.workflow_name
			: (meta?.name ??
				(typeof record.name === "string" ? record.name : view.title))) ||
		message("chat:workflow_run_workflow");
	const description =
		meta?.description ??
		(typeof record.description === "string" ? record.description : null);
	const states = sections.map((section) => phaseState(section, view.status));
	const agents = sections.flatMap((section) => section.agents);
	const done = agents.filter((agent) => agent.status === "done").length;
	const failed = agents.filter((agent) => agent.status === "failed").length;
	const selected =
		agents.find((agent) => agent.index === selectedIndex) ?? null;
	const facts = [
		...(agents.length > 0
			? [
					message("chat:workflow_run_agents_done", {
						done,
						total: agents.length,
					}),
				]
			: []),
		...(failed > 0
			? [message("chat:delegation_group_failed", { count: failed })]
			: []),
	];
	return (
		<section
			aria-label={message("chat:workflow_run_label", { name })}
			className="@container min-w-0 px-4 py-1.5 text-xs"
		>
			<div className="flex min-w-0 items-center gap-2.5">
				{view.providerId !== null ? (
					<ProviderIcon
						providerId={view.providerId}
						className="size-4 text-foreground/80"
					/>
				) : (
					<HugeiconsIcon
						icon={WorkflowSquare03Icon}
						strokeWidth={2}
						aria-hidden="true"
						className="size-4 shrink-0 text-foreground/80"
					/>
				)}
				<h3 className="min-w-0 shrink truncate text-[13px] font-medium text-foreground">
					{name}
				</h3>
				<p className="ms-auto min-w-0 max-w-[65%] shrink-0 truncate text-muted-foreground">
					<span className={cn("font-medium", RUN_TONE[view.status])}>
						{view.status === "working" ? (
							<ShimmerText tone="lime">{statusLabel(view.status)}</ShimmerText>
						) : (
							statusLabel(view.status)
						)}
					</span>
					{facts.map((fact) => (
						<span key={fact}> · {fact}</span>
					))}
					<span className="tabular-nums">
						{" · "}
						<DelegationElapsed timing={view} />
					</span>
				</p>
			</div>
			{description !== null ? (
				<p className="ms-6.5 mt-1 line-clamp-2 break-words leading-relaxed text-muted-foreground">
					{description}
				</p>
			) : null}
			{sections.length > 0 ? (
				<ol
					aria-label={message("chat:workflow_run_phases")}
					className="mt-3 flex min-w-0 flex-col gap-1.5 @lg:flex-row @lg:items-stretch @lg:overflow-x-auto"
				>
					{sections.map((section, index) => (
						<PhaseColumn
							key={section.key}
							section={section}
							state={states[index] ?? "pending"}
							last={index === sections.length - 1}
							providerId={view.providerId}
							selectedIndex={selectedIndex}
							onSelect={(agent) =>
								setSelectedIndex((current) =>
									current === agent ? null : agent,
								)
							}
						/>
					))}
				</ol>
			) : null}
			{selected !== null ? (
				<AgentDetail agent={selected} providerId={view.providerId} />
			) : null}
			{onOpen !== null || inline !== null ? (
				<div className="-mx-2 mt-1.5">
					<DelegationRow
						view={{ ...view, title: message("chat:workflow_run_result") }}
						onOpen={onOpen}
						inline={inline}
					/>
				</div>
			) : null}
			{script !== null || scriptPath !== null ? (
				<div className="mt-1.5 min-w-0">
					<button
						type="button"
						aria-expanded={scriptOpen}
						onClick={() => setScriptOpen((value) => !value)}
						className="-ms-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
					>
						<HugeiconsIcon
							icon={SourceCodeIcon}
							strokeWidth={2}
							aria-hidden="true"
							className="size-3.5"
						/>
						{message(
							scriptOpen
								? "chat:workflow_run_script_collapse"
								: "chat:workflow_run_script_expand",
						)}
					</button>
					{scriptOpen ? (
						<div className="mt-1">
							{script !== null ? (
								<CodeBlock
									filename="workflow.js"
									language="js"
									text={script}
									variant="plain"
									maxHeight={SCRIPT_HEIGHT}
								/>
							) : (
								<p className="break-all font-mono text-[11px] text-muted-foreground">
									{scriptPath}
								</p>
							)}
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}

const COLUMN_TONE: Record<PhaseState, string> = {
	pending: "bg-muted/15",
	active: "bg-lime-400/[0.06]",
	done: "bg-muted/25",
	failed: "bg-destructive/[0.06]",
	stopped: "bg-muted/15",
};

const PHASE_ICON: Record<
	Exclude<PhaseState, "active">,
	{ readonly icon: IconSvgElement; readonly className: string }
> = {
	pending: { icon: CircleDashedIcon, className: "text-muted-foreground/50" },
	done: { icon: CheckmarkCircle02Icon, className: "text-emerald-400" },
	failed: { icon: CancelCircleIcon, className: "text-destructive" },
	stopped: { icon: MinusSignCircleIcon, className: "text-muted-foreground/60" },
};

function PhaseColumn({
	section,
	state,
	last,
	providerId,
	selectedIndex,
	onSelect,
}: {
	readonly section: WorkflowSection;
	readonly state: PhaseState;
	readonly last: boolean;
	readonly providerId: ProviderId | null;
	readonly selectedIndex: number | null;
	readonly onSelect: (agent: number) => void;
}) {
	const { message } = useMessages(["chat"]);
	const [showAll, setShowAll] = useState(false);
	const icon = state === "active" ? null : PHASE_ICON[state];
	const visible = showAll
		? section.agents
		: section.agents.slice(0, VISIBLE_AGENTS);
	const hidden = section.agents.length - visible.length;
	return (
		<li className="flex min-w-0 flex-1 items-stretch gap-1.5 @lg:min-w-40">
			<div
				className={cn(
					"flex min-w-0 flex-1 flex-col gap-1 rounded-xl p-2",
					COLUMN_TONE[state],
				)}
			>
				<div className="flex h-6 min-w-0 items-center gap-1.5 px-1">
					{icon === null ? (
						<span
							aria-hidden="true"
							className="flex size-3.5 shrink-0 items-center justify-center"
						>
							<span className="size-2 rounded-full bg-lime-400 shadow-[0_0_0_3px] shadow-lime-400/20" />
						</span>
					) : (
						<HugeiconsIcon
							icon={icon.icon}
							strokeWidth={2}
							aria-hidden="true"
							className={cn("size-3.5 shrink-0", icon.className)}
						/>
					)}
					<span
						className={cn(
							"min-w-0 truncate font-medium",
							state === "pending"
								? "text-muted-foreground"
								: "text-foreground/90",
						)}
					>
						{section.title ?? message("chat:workflow_run_unphased")}
					</span>
					{section.agents.length > 0 ? (
						<span className="ms-auto shrink-0 text-muted-foreground/70 tabular-nums">
							{section.done}/{section.agents.length}
						</span>
					) : null}
				</div>
				{section.agents.length === 0 ? (
					<p className="px-1 pb-1 leading-relaxed text-muted-foreground/60">
						{section.detail ??
							message(
								state === "pending"
									? "chat:workflow_run_phase_waiting"
									: "chat:workflow_run_phase_empty",
							)}
					</p>
				) : (
					<ul className="flex min-w-0 flex-col gap-1">
						{visible.map((agent) => (
							<li key={agent.index} className="min-w-0">
								<AgentTile
									agent={agent}
									providerId={providerId}
									selected={agent.index === selectedIndex}
									onSelect={() => onSelect(agent.index)}
								/>
							</li>
						))}
					</ul>
				)}
				{hidden > 0 ? (
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="h-7 cursor-pointer rounded-lg px-2 text-left text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
					>
						{message("chat:workflow_run_more", { count: hidden })}
					</button>
				) : null}
			</div>
			{last ? null : (
				<HugeiconsIcon
					icon={ArrowRight01Icon}
					strokeWidth={2}
					aria-hidden="true"
					className="hidden size-3 shrink-0 self-center text-muted-foreground/40 @lg:block"
				/>
			)}
		</li>
	);
}

const AGENT_TONE: Record<WorkflowAgentStatus, string> = {
	queued: "text-muted-foreground/40",
	working:
		"text-foreground/85 motion-safe:animate-spin motion-safe:[animation-duration:3s]",
	done: "text-muted-foreground",
	failed: "text-destructive",
	stopped: "text-muted-foreground/40",
};

/** The provider's mark: it turns while the agent works and takes the outcome's tone after. */
function AgentMark({
	providerId,
	status,
}: {
	readonly providerId: ProviderId | null;
	readonly status: WorkflowAgentStatus;
}) {
	const className = cn("size-3.5 shrink-0", AGENT_TONE[status]);
	return providerId !== null ? (
		<ProviderIcon providerId={providerId} className={className} />
	) : (
		<HugeiconsIcon
			icon={BotIcon}
			strokeWidth={2}
			aria-hidden="true"
			className={className}
		/>
	);
}

const useAgentStatusLabel = () => {
	const { message } = useMessages(["chat"]);
	const statusLabel = useDelegationStatusLabel();
	return (status: WorkflowAgentStatus) =>
		status === "queued"
			? message("chat:workflow_run_queued")
			: statusLabel(status);
};

const agentTiming = (agent: WorkflowAgentView) =>
	agent.status === "queued" ? null : (
		<DelegationElapsed
			timing={{
				status: agent.status,
				startedAt: agent.startedAt,
				completedAt: agent.completedAt,
			}}
		/>
	);

function AgentTile({
	agent,
	providerId,
	selected,
	onSelect,
}: {
	readonly agent: WorkflowAgentView;
	readonly providerId: ProviderId | null;
	readonly selected: boolean;
	readonly onSelect: () => void;
}) {
	const agentStatusLabel = useAgentStatusLabel();
	const inspectable = agent.prompt !== null || agent.result !== null;
	const className = cn(
		"flex h-8 w-full min-w-0 items-center gap-2 rounded-lg bg-background/70 px-2 text-left",
		selected && "ring-1 ring-foreground/20",
	);
	const content = (
		<>
			<AgentMark providerId={providerId} status={agent.status} />
			<span
				className={cn(
					"min-w-0 flex-1 truncate",
					agent.status === "failed" ? "text-destructive" : "text-foreground/85",
				)}
			>
				{agent.label}
			</span>
			<span className="shrink-0 text-muted-foreground/70 tabular-nums">
				{agentTiming(agent)}
			</span>
		</>
	);
	return inspectable ? (
		<button
			type="button"
			aria-pressed={selected}
			aria-description={agentStatusLabel(agent.status)}
			title={agent.preview ?? undefined}
			onClick={onSelect}
			className={cn(
				className,
				"cursor-pointer transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
			)}
		>
			{content}
		</button>
	) : (
		<div
			aria-description={agentStatusLabel(agent.status)}
			className={className}
		>
			{content}
		</div>
	);
}

function AgentDetail({
	agent,
	providerId,
}: {
	readonly agent: WorkflowAgentView;
	readonly providerId: ProviderId | null;
}) {
	const { message } = useMessages(["chat"]);
	const agentStatusLabel = useAgentStatusLabel();
	return (
		<div className="mt-1.5 flex min-w-0 flex-col gap-2.5 rounded-xl bg-muted/20 px-3 py-2.5">
			<div className="flex min-w-0 items-center gap-2">
				<AgentMark providerId={providerId} status={agent.status} />
				<span className="min-w-0 truncate font-medium text-foreground/90">
					{agent.label}
				</span>
				<span className="shrink-0 text-muted-foreground">
					{agentStatusLabel(agent.status)}
				</span>
				<span className="ms-auto shrink-0 text-muted-foreground/70 tabular-nums">
					{agentTiming(agent)}
				</span>
			</div>
			{agent.prompt !== null ? (
				<Preview
					title={message("chat:workflow_run_prompt")}
					text={agent.prompt}
				/>
			) : null}
			{agent.result !== null ? (
				<Preview
					title={message("chat:workflow_run_result")}
					text={agent.result}
					failed={agent.status === "failed"}
				/>
			) : null}
		</div>
	);
}

function Preview({
	title,
	text,
	failed = false,
}: {
	readonly title: string;
	readonly text: string;
	readonly failed?: boolean;
}) {
	return (
		<div className="min-w-0">
			<p className="text-[11px] font-medium text-muted-foreground">{title}</p>
			<p
				className={cn(
					"mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words leading-relaxed",
					failed ? "text-destructive" : "text-foreground/85",
				)}
			>
				{text}
			</p>
		</div>
	);
}
