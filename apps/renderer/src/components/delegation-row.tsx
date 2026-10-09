import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, Message } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ClipboardIcon } from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import {
	type DelegationStatus,
	type DelegationView,
	delegationElapsedMs,
	formatElapsed,
} from "~/lib/delegation-display";
import { useRelativeTimeTick } from "~/lib/use-relative-time";
import { cn } from "~/lib/utils";

import { CopyButton } from "./copy-button.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import { MessageRow } from "./message-row.tsx";
import { DelegationAvatar } from "./subagent-identity.tsx";

const STATUS_LABEL_KEY = {
	working: "chat:delegation_status_running",
	done: "chat:delegation_status_done",
	failed: "chat:delegation_status_failed",
	stopped: "chat:delegation_status_stopped",
} as const satisfies Record<DelegationStatus, string>;

export const useDelegationStatusLabel = () => {
	const { message } = useUiMessages(["chat"]);
	return (status: DelegationStatus) => message(STATUS_LABEL_KEY[status]);
};

type Timing = Pick<DelegationView, "status" | "startedAt" | "completedAt">;

function LiveElapsed({ timing }: { readonly timing: Timing }) {
	const now = useRelativeTimeTick(1_000);
	const ms = delegationElapsedMs(timing, now);
	return ms === null ? null : formatElapsed(ms);
}

/** Ticks only while working, so settled rows never re-render. */
export function DelegationElapsed({ timing }: { readonly timing: Timing }) {
	if (timing.status === "working" && timing.completedAt === null) {
		return <LiveElapsed timing={timing} />;
	}
	const ms = delegationElapsedMs(timing, 0);
	return ms === null ? null : formatElapsed(ms);
}

/** The nested transcript of a subagent that has no session to open. */
export interface DelegationInlineBody {
	readonly prompt: string;
	readonly children: ReadonlyArray<Message>;
	readonly summaryText: string | null;
	readonly readOnly: boolean;
	readonly environmentId: EnvironmentId | undefined;
}

/**
 * One delegated agent: provider avatar with status dot, title, latest line,
 * elapsed time, and a chevron when it opens elsewhere.
 */
export function DelegationRow({
	view,
	onOpen,
	inline,
}: {
	readonly view: DelegationView;
	readonly onOpen: (() => void) | null;
	readonly inline: DelegationInlineBody | null;
}) {
	const { message } = useUiMessages(["chat"]);
	const statusLabel = useDelegationStatusLabel();
	const [expanded, setExpanded] = useState(false);
	const failed = view.status === "failed";
	const title = view.title || message("chat:delegation_row_starting");
	const label = statusLabel(view.status);
	const interactive = onOpen !== null || inline !== null;
	const Chevron = inline !== null && expanded ? ChevronDown : ChevronRight;
	const content = (
		<>
			<DelegationAvatar
				providerId={view.providerId}
				name={view.title}
				status={view.status}
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 truncate text-xs font-medium text-foreground">
						{title}
					</span>
					{view.detail !== null && view.status !== "done" ? (
						<span
							className={cn(
								"shrink-0 text-[10px]",
								failed ? "text-destructive" : "text-muted-foreground",
							)}
						>
							{label}
						</span>
					) : null}
				</span>
				<span
					className={cn(
						"block truncate text-[11px] leading-relaxed",
						failed ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{view.detail ?? label}
				</span>
			</span>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
				<DelegationElapsed timing={view} />
			</span>
			{interactive ? (
				<Chevron
					aria-hidden="true"
					className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/delegation:text-foreground"
				/>
			) : null}
		</>
	);
	const className =
		"group/delegation flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
	return (
		<div>
			{interactive ? (
				<button
					type="button"
					aria-label={message("chat:delegation_row_open", { title })}
					aria-description={label}
					aria-expanded={inline !== null ? expanded : undefined}
					onClick={() => {
						if (onOpen !== null) onOpen();
						else setExpanded((value) => !value);
					}}
					className={cn(
						className,
						"cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
					)}
				>
					{content}
				</button>
			) : (
				<div aria-description={label} className={className}>
					{content}
				</div>
			)}
			{inline !== null && expanded ? <InlineBody body={inline} /> : null}
		</div>
	);
}

function InlineBody({ body }: { readonly body: DelegationInlineBody }) {
	return (
		<div className="ml-5 mt-1 border-l border-border/60 pl-3">
			<PromptRow text={body.prompt} />
			<div className="flex flex-col">
				{body.children.map((child) => (
					<MessageRow
						key={child.id}
						message={child}
						readOnly={body.readOnly}
						environmentId={body.environmentId}
					/>
				))}
			</div>
			{body.summaryText !== null && body.summaryText.length > 0 ? (
				<div className="px-4 py-1">
					<MarkdownBody className="text-xs">{body.summaryText}</MarkdownBody>
				</div>
			) : null}
		</div>
	);
}

function PromptRow({ text }: { text: string }) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	return (
		<div className="px-4 pt-1">
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				className={cn(
					"group flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs",
					"hover:bg-muted/40 cursor-pointer",
				)}
			>
				<div className="relative grid size-4 shrink-0 place-items-center">
					<HugeiconsIcon
						icon={ClipboardIcon}
						strokeWidth={2}
						aria-hidden="true"
						className={cn(
							"col-start-1 row-start-1 size-3.5 text-muted-foreground transition-opacity duration-150 ease-out",
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
				<span className="shrink-0 font-medium text-foreground/90">
					{uiMessage("chat:subagent_row_prompt")}
				</span>
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					{text}
				</span>
			</button>
			{expanded ? (
				<div className="ml-7 mt-1 max-w-2xl border-l border-border/60 pl-3 pr-1">
					<div className="group/prompt relative">
						<CopyButton
							text={text}
							label={uiMessage("chat:subagent_row_copy_prompt")}
							className="absolute right-1.5 top-1.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
						/>
						<pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-message-rule bg-message-pre-bg px-3 py-2 pr-9 font-mono text-[11px] text-foreground/80">
							{text || uiMessage("chat:subagent_row_empty")}
						</pre>
					</div>
				</div>
			) : null}
		</div>
	);
}
