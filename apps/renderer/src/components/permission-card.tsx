import "@zuse/i18n/english/chat";
import type { SessionInteractionSubmission } from "@zuse/client-runtime/session-presentation";
import type {
	EnvironmentId,
	PermissionDecision,
	PermissionKind,
	PermissionRequest,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { cn } from "~/lib/utils";
import {
	decideEnvironmentPermission,
	denyEnvironmentPermissionAndInterrupt,
} from "../lib/environment-permissions-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { Button } from "./ui/button.tsx";

const kindHeadline = (kind: PermissionKind): string => {
	switch (kind._tag) {
		case "Bash":
			return "Run shell command?";
		case "FileWrite":
			return "Write file?";
		case "Network":
			return "Make network request?";
		case "Other":
			return `Use tool ${kind.tool}?`;
	}
};

const kindDetail = (kind: PermissionKind): string => {
	switch (kind._tag) {
		case "Bash":
			return kind.command;
		case "FileWrite":
			return kind.path;
		case "Network":
			return kind.url;
		case "Other":
			return kind.summary;
	}
};

/**
 * `forcePrompt` is overloaded server-side: sensitive credential paths always
 * force a one-shot approval, but so does plan mode (every bash/write/network
 * call). The old copy always said "Sensitive path", which was wrong for the
 * common Grok/ACP case of plan-mode shell prompts on ordinary commands.
 */
const forcePromptHint = (kind: PermissionKind): string => {
	switch (kind._tag) {
		case "Bash":
		case "Network":
			// Bash policy never path-scans the command string — forcePrompt here is
			// plan mode (or an equivalent "never silence this class" gate).
			return "Plan mode — only “Allow once” is available.";
		case "FileWrite":
			return "Sensitive path or plan mode — only “Allow once” is available.";
		case "Other":
			return "Only “Allow once” is available for this request.";
	}
};

const ALLOW_ONCE: PermissionDecision = { _tag: "AllowOnce" };
const ALLOW_FOR_SESSION: PermissionDecision = { _tag: "AllowForSession" };
const ALWAYS_ALLOW_FOLDER: PermissionDecision = {
	_tag: "AlwaysAllow",
	scope: "folder",
};
export function PermissionCard({
	head,
	queueSize,
	environmentId,
	submission = "pending",
	submissionError = null,
}: {
	readonly head: PermissionRequest;
	readonly queueSize: number;
	readonly environmentId: EnvironmentId;
	readonly submission?: SessionInteractionSubmission;
	readonly submissionError?: string | null;
}) {
	return (
		<PermissionPrompt
			submission={submission}
			submissionError={submissionError}
			holdUntilRemoved
			requestId={head.id}
			kind={head.kind}
			queueSize={queueSize}
			expired={head.recoveryState === "expired"}
			persistentDisabled={head.forcePrompt}
			onDecision={async (_requestId, decision) => {
				if (decision._tag === "Deny" && head.recoveryState !== "expired")
					await denyEnvironmentPermissionAndInterrupt(head, environmentId);
				else await decideEnvironmentPermission(head, decision, environmentId);
			}}
		/>
	);
}

/** One permission surface and keyboard/action behavior for provider and device approvals. */
export function PermissionPrompt({
	requestId,
	kind,
	queueSize,
	expired = false,
	persistentDisabled = false,
	onDecision,
	headline,
	context,
	submission = "pending",
	submissionError = null,
	holdUntilRemoved = false,
}: {
	requestId: string;
	kind: PermissionKind;
	queueSize: number;
	expired?: boolean;
	persistentDisabled?: boolean;
	onDecision: (
		requestId: string,
		decision: PermissionDecision,
	) => Promise<void>;
	headline?: ReactNode;
	context?: ReactNode;
	submission?: SessionInteractionSubmission;
	submissionError?: string | null;
	holdUntilRemoved?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const [localPending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const pending = localPending || submission === "submitting";
	useEffect(() => {
		pendingRef.current = false;
		setPending(false);
		setError(null);
	}, [requestId]);
	const [error, setError] = useState<string | null>(null);
	const decide = useCallback(
		async (requestId: string, decision: PermissionDecision): Promise<void> => {
			if (
				pendingRef.current ||
				pending ||
				(expired && decision._tag !== "Deny")
			)
				return;
			pendingRef.current = true;
			setPending(true);
			setError(null);
			try {
				await onDecision(requestId, decision);
				if (!holdUntilRemoved) {
					pendingRef.current = false;
					setPending(false);
				}
			} catch (cause) {
				setError(formatError(cause));
				pendingRef.current = false;
				setPending(false);
			}
		},
		[onDecision, expired, pending, holdUntilRemoved],
	);
	const deny = useCallback(
		() => decide(requestId, { _tag: "Deny" }),
		[decide, requestId],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				void deny();
				return;
			}
			if (!expired && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				void decide(requestId, ALLOW_ONCE);
				return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [requestId, decide, deny, expired]);

	return (
		<div
			aria-busy={pending || undefined}
			className="rounded-xl bg-card/95 p-3 shadow-overlay-sm ring-1 ring-border/70"
		>
			<div className="flex items-center gap-2">
				<div className="truncate text-[13px] font-medium leading-5 text-foreground">
					{expired
						? uiMessage(
								"chat:permission_card_approval_expired_after_agent_restart",
							)
						: (headline ?? kindHeadline(kind))}
				</div>
				{queueSize > 1 ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground shrink-0">
						{uiMessage("chat:permission_card_more_sentence", {
							value: queueSize - 1,
						})}
					</span>
				) : null}
			</div>
			{context}
			{expired ? (
				<p
					className="mt-2 text-xs text-muted-foreground"
					role="status"
					aria-live="polite"
				>
					{uiMessage(
						"chat:permission_card_the_agent_restarted_while_waiting_for_this_approval_it_cannot_consume",
					)}
				</p>
			) : null}
			{error || submissionError ? (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error ?? submissionError}
				</p>
			) : null}

			<div className="mt-2 max-h-24 overflow-y-auto break-all rounded-md bg-muted/45 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-foreground/90">
				{kindDetail(kind)}
			</div>

			{persistentDisabled ? (
				<div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
					{forcePromptHint(kind)}
				</div>
			) : null}

			<div className="mt-2.5 flex flex-wrap items-center justify-end gap-1">
				<Button
					size="xs"
					variant="ghost"
					disabled={pending}
					className="h-7"
					onClick={() => void deny()}
					title={uiMessage("chat:permission_card_esc")}
				>
					{expired
						? uiMessage("chat:permission_card_dismiss")
						: uiMessage("chat:permission_card_deny")}
				</Button>
				{expired ? null : (
					<>
						<Button
							size="xs"
							variant="ghost"
							disabled={persistentDisabled || pending}
							onClick={() => void decide(requestId, ALLOW_FOR_SESSION)}
							className={cn(
								"h-7",
								persistentDisabled && "pointer-events-none opacity-40",
							)}
						>
							{uiMessage("chat:permission_card_allow_for_session")}
						</Button>
						<Button
							size="xs"
							variant="ghost"
							disabled={persistentDisabled || pending}
							onClick={() => void decide(requestId, ALWAYS_ALLOW_FOLDER)}
							className={cn(
								"h-7",
								persistentDisabled && "pointer-events-none opacity-40",
							)}
						>
							{uiMessage("chat:permission_card_always_allow")}
						</Button>
						<Button
							size="xs"
							disabled={pending}
							onClick={() => void decide(requestId, ALLOW_ONCE)}
							className="ml-1 h-7"
							title={uiMessage("chat:permission_card_enter")}
						>
							{uiMessage("chat:permission_card_allow_once")}
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
