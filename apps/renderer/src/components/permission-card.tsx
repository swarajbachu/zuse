import type {
	EnvironmentId,
	PermissionDecision,
	PermissionKind,
	PermissionRequest,
} from "@zuse/contracts";
import { useCallback, useEffect } from "react";

import { cn } from "~/lib/utils";
import {
	decideEnvironmentPermission,
	denyEnvironmentPermissionAndInterrupt,
} from "../lib/environment-permissions-client-bus.ts";
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
}: {
	readonly head: PermissionRequest;
	readonly queueSize: number;
	readonly environmentId: EnvironmentId;
}) {
	const decide = useCallback(
		(requestId: string, decision: PermissionDecision): Promise<void> =>
			decideEnvironmentPermission(requestId, decision, environmentId),
		[environmentId],
	);
	const deny = useCallback(
		() => denyEnvironmentPermissionAndInterrupt(head, environmentId),
		[environmentId, head],
	);
	const persistentDisabled = head.forcePrompt;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				void deny();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				void decide(head.id, ALLOW_ONCE);
				return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [head.id, decide, deny]);

	return (
		<div className="rounded-xl bg-card/95 p-3 shadow-overlay-sm ring-1 ring-border/70">
			<div className="flex items-center gap-2">
				<div className="truncate text-[13px] font-medium leading-5 text-foreground">
					{kindHeadline(head.kind)}
				</div>
				{queueSize > 1 ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground shrink-0">
						+{queueSize - 1} more
					</span>
				) : null}
			</div>

			<div className="mt-2 max-h-24 overflow-y-auto break-all rounded-md bg-muted/45 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-foreground/90">
				{kindDetail(head.kind)}
			</div>

			{persistentDisabled ? (
				<div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
					{forcePromptHint(head.kind)}
				</div>
			) : null}

			<div className="mt-2.5 flex flex-wrap items-center justify-end gap-1">
				<Button
					size="xs"
					variant="ghost"
					onClick={() => void deny()}
					title="Esc"
				>
					Deny
				</Button>
				<Button
					size="xs"
					variant="ghost"
					disabled={persistentDisabled}
					onClick={() => void decide(head.id, ALLOW_FOR_SESSION)}
					className={cn(persistentDisabled && "pointer-events-none opacity-40")}
				>
					Allow for session
				</Button>
				<Button
					size="xs"
					variant="ghost"
					disabled={persistentDisabled}
					onClick={() => void decide(head.id, ALWAYS_ALLOW_FOLDER)}
					className={cn(persistentDisabled && "pointer-events-none opacity-40")}
				>
					Always allow
				</Button>
				<Button
					size="xs"
					onClick={() => void decide(head.id, ALLOW_ONCE)}
					className="ml-1"
					title="⌘+Enter"
				>
					Allow once
				</Button>
			</div>
		</div>
	);
}
