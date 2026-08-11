import type { ChatId } from "@zuse/contracts";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import * as terminalRegistry from "../lib/terminal-registry.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import {
	cloudSummaryForChat,
	localProjectForCloudChat,
} from "../store/cloud-chat-registry.ts";
import { openCloudChat, useCloudChatsStore } from "../store/cloud-chats.ts";
import {
	EMPTY_TERMINALS,
	type TerminalInstance,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import { ShimmerText } from "./ui/shimmer-text.tsx";

/**
 * Right-pane terminal host. Each right-dock terminal tab carries a
 * chat-relative `slot`; `TerminalSlotPane` resolves it against the active
 * chat's terminal list and mounts one `PtyTerminal`. The xterm + PTY live in
 * `terminal-registry.ts`, so unmounting (e.g. switching chats) detaches the
 * DOM but leaves the shell running — re-selecting the chat reconnects.
 */
function TerminalPlaceholder({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full w-full items-center justify-center bg-background text-xs text-muted-foreground">
			{children}
		</div>
	);
}

/**
 * Renders a single terminal for one right-dock tab. The tab carries a
 * chat-relative `slot`; this resolves it to the active chat's Nth terminal
 * instance (seeding via `ensureSlot`) and mounts one `PtyTerminal`. The PTY's
 * cwd is the active workspace root, but the terminal LIST is owned by the
 * chat, so each chat keeps its own shells.
 */
export function TerminalSlotPane({ slot }: { slot: number }) {
	const ctx = useActiveContext();
	const chatId = useChatsStore((s) => s.selectedChatId);
	const ready = ctx.status === "ready" && !ctx.worktreePending;

	if (ctx.status === "loading") {
		return (
			<TerminalPlaceholder>
				<ShimmerText>Loading workspace…</ShimmerText>
			</TerminalPlaceholder>
		);
	}
	if (ctx.status === "empty") {
		return (
			<TerminalPlaceholder>
				No folder selected. Add or pick a folder on the left.
			</TerminalPlaceholder>
		);
	}
	if (ctx.worktreePending) {
		return (
			<TerminalPlaceholder>
				<ShimmerText>Preparing worktree…</ShimmerText>
			</TerminalPlaceholder>
		);
	}
	if (!ready || chatId === null) return null;
	return (
		<PlainTerminalSlot chatId={chatId} rootPath={ctx.rootPath} slot={slot} />
	);
}

function PlainTerminalSlot({
	chatId,
	rootPath,
	slot,
}: {
	chatId: ChatId;
	rootPath: string;
	slot: number;
}) {
	const key = terminalsKey(chatId);
	const registeredCloudSummary = cloudSummaryForChat(chatId);
	const cloudSummary = useCloudChatsStore(
		(state) =>
			state.summaries.find((summary) => summary.chatId === chatId) ??
			registeredCloudSummary,
	);
	const cloudProjectId = localProjectForCloudChat(chatId);
	const [cloudConnection, setCloudConnection] = useState<
		"idle" | "connecting" | "ready" | "failed"
	>(cloudSummary === null ? "ready" : "idle");
	const list = useTerminalsStore((s) => s.byKey[key] ?? EMPTY_TERMINALS);
	const ensureSlot = useTerminalsStore((s) => s.ensureSlot);
	const resolvedRootPath =
		cloudSummary === null ? rootPath : "/home/zuse/workspace";

	const connectCloudTerminal = useCallback(
		(activate: boolean) => {
			if (
				cloudSummary === null ||
				cloudProjectId === null ||
				cloudConnection === "connecting"
			)
				return;
			setCloudConnection("connecting");
			void openCloudChat(cloudSummary, cloudProjectId, { activate })
				.then(() => {
					setCloudConnection("ready");
				})
				.catch(() => {
					setCloudConnection("failed");
				});
		},
		[cloudConnection, cloudProjectId, cloudSummary],
	);

	useEffect(() => {
		if (
			cloudSummary?.state !== "ready" ||
			cloudSummary.runtimeState !== "online" ||
			cloudConnection !== "idle"
		)
			return;
		connectCloudTerminal(false);
	}, [cloudConnection, cloudSummary, connectCloudTerminal]);

	useEffect(() => {
		if (cloudConnection !== "ready") return;
		const instance = list[slot];
		if (
			instance === undefined ||
			(cloudSummary !== null &&
				instance.environmentId !== cloudSummary.workspaceId)
		)
			ensureSlot(key, slot, resolvedRootPath);
	}, [
		cloudConnection,
		cloudSummary,
		ensureSlot,
		key,
		list,
		resolvedRootPath,
		slot,
	]);

	if (cloudConnection === "connecting")
		return (
			<TerminalPlaceholder>
				<ShimmerText>Connecting cloud terminal…</ShimmerText>
			</TerminalPlaceholder>
		);
	if (cloudSummary !== null && cloudConnection !== "ready")
		return (
			<TerminalPlaceholder>
				<div className="flex flex-col items-center gap-3 px-6 text-center">
					<span>
						{cloudConnection === "failed"
							? "Cloud terminal could not connect."
							: cloudSummary.state === "paused"
								? "This cloud workspace is paused."
								: "The cloud terminal is not connected."}
					</span>
					<button
						type="button"
						className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-secondary px-4 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						onClick={() => connectCloudTerminal(true)}
					>
						{cloudConnection === "failed" ? "Try again" : "Resume terminal"}
					</button>
				</div>
			</TerminalPlaceholder>
		);

	const inst = list[slot];
	if (inst === undefined) return null;
	return (
		<PtyTerminal
			cwd={inst.cwd}
			environmentId={inst.environmentId}
			instanceId={inst.id}
			command={inst.command}
		/>
	);
}

/**
 * Thin host for one terminal instance. The xterm + PTY live in
 * `terminal-registry.ts` keyed by environment and `instanceId`; this just
 * `attach`es the live
 * entry into its container on mount and `detach`es (NOT disposes) on unmount,
 * so the shell keeps running while its chat is in the background. The PTY is
 * only torn down on explicit close — see `useTerminalsStore.remove`.
 */
export function PtyTerminal({
	cwd,
	environmentId,
	instanceId,
	command,
}: {
	cwd: string;
	environmentId: string;
	instanceId: string;
	command?: TerminalInstance["command"];
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		terminalRegistry.attach(environmentId, instanceId, container, {
			cwd,
			command,
		});
		return () => terminalRegistry.detach(environmentId, instanceId);
		// `cwd`/`command` only matter on first open; reconnects reuse the live
		// entry, so the instance id is the sole identity that should re-run this.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [environmentId, instanceId]);

	return (
		<div
			ref={containerRef}
			className="h-full w-full min-w-0 overflow-hidden bg-background px-2 py-1.5"
		/>
	);
}
