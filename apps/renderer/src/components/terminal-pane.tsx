import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId, PtyId } from "@zuse/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCloudSyncStatus } from "../lib/cloud-sync-client-bus.ts";
import {
	cloudSummaryForChat,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import * as terminalRegistry from "../lib/terminal-registry.ts";
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
export function TerminalSlotPane({
	chatRef,
	rootPath,
	slot,
}: {
	chatRef: ChatRef;
	rootPath: string;
	slot: number;
}) {
	return (
		<PlainTerminalSlot chatRef={chatRef} rootPath={rootPath} slot={slot} />
	);
}

function PlainTerminalSlot({
	chatRef,
	rootPath,
	slot,
}: {
	chatRef: ChatRef;
	rootPath: string;
	slot: number;
}) {
	const key = terminalsKey(chatRef);
	const registeredCloudSummaryCandidate = cloudSummaryForChat(chatRef.chatId);
	const registeredCloudSummary =
		registeredCloudSummaryCandidate?.workspaceId === chatRef.environmentId
			? registeredCloudSummaryCandidate
			: null;
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find(
				(summary) =>
					summary.chatId === chatRef.chatId &&
					summary.workspaceId === chatRef.environmentId,
			) ?? registeredCloudSummary,
	);
	const list = useTerminalsStore((s) => s.byKey[key] ?? EMPTY_TERMINALS);
	const instance = list[slot];
	const localTerminal =
		cloudSummary !== null &&
		instance?.environmentId === getLocalEnvironmentId();
	const syncStatus = useCloudSyncStatus(
		localTerminal ? (cloudSummary?.workspaceId ?? null) : null,
	);
	const cloudShell = useEnvironmentShellResource(
		cloudSummary === null || localTerminal ? null : chatRef.environmentId,
		cloudSummary === null || localTerminal ? "cache-only" : "wake",
	);
	const cloudAttachment =
		cloudSummary === null ||
		localTerminal ||
		cloudShell.connection === "connected"
			? "ready"
			: cloudShell.connection === "waking" ||
					cloudShell.connection === "connecting" ||
					cloudShell.connection === "reconnecting"
				? "attaching"
				: cloudShell.connection === "failed" ||
						cloudShell.connection === "blocked-auth" ||
						cloudShell.connection === "update-required" ||
						cloudShell.connection === "revoked"
					? "failed"
					: "detached";
	const [pendingTerminalInput, setPendingTerminalInput] = useState("");
	const ensureSlot = useTerminalsStore((s) => s.ensureSlot);
	const resolvedRootPath =
		cloudSummary === null
			? rootPath
			: (cloudShell.data?.folders[0]?.path ?? rootPath);

	useEffect(() => {
		if (cloudAttachment !== "ready") return;
		const instance = list[slot];
		if (instance === undefined) ensureSlot(chatRef, slot, resolvedRootPath);
	}, [
		chatRef,
		cloudAttachment,
		cloudSummary,
		ensureSlot,
		list,
		resolvedRootPath,
		slot,
	]);

	if (cloudAttachment === "attaching")
		return (
			<TerminalPlaceholder>
				<ShimmerText>Reconnecting cloud terminal…</ShimmerText>
			</TerminalPlaceholder>
		);
	if (cloudSummary !== null && cloudAttachment !== "ready")
		if (
			cloudSummary.state === "resuming" ||
			cloudSummary.state === "provisioning" ||
			cloudSummary.state === "setup"
		)
			return (
				<TerminalPlaceholder>
					<ShimmerText>Resuming cloud workspace…</ShimmerText>
				</TerminalPlaceholder>
			);
	if (cloudSummary !== null && cloudAttachment !== "ready")
		return (
			<TerminalPlaceholder>
				<textarea
					value=""
					onChange={() => undefined}
					aria-label="Cloud terminal. Type to resume the workspace."
					placeholder={
						cloudAttachment === "failed"
							? "Cloud terminal could not connect. Type here to try again."
							: cloudSummary.state === "paused"
								? "Workspace paused — type here to resume the terminal."
								: "Cloud terminal is unavailable."
					}
					className="h-full min-h-11 w-full resize-none cursor-text content-center border-0 bg-transparent px-6 text-center text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					onKeyDown={(event) => {
						const input =
							event.key.length === 1
								? event.key
								: event.key === "Enter"
									? "\r"
									: event.key === "Tab"
										? "\t"
										: event.key === "Backspace"
											? "\u007f"
											: "";
						if (input.length === 0 || event.metaKey || event.ctrlKey) return;
						event.preventDefault();
						setPendingTerminalInput(input);
					}}
					onPaste={(event) => {
						const input = event.clipboardData.getData("text");
						if (input.length === 0) return;
						event.preventDefault();
						setPendingTerminalInput(input);
					}}
				/>
			</TerminalPlaceholder>
		);

	const inst = instance;
	if (inst === undefined) return null;
	const localSyncState = syncStatus?.state ?? "idle";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{localTerminal ? (
				<div className="flex h-7 shrink-0 items-center gap-2 px-3 text-[11px] text-muted-foreground">
					<span
						className={`size-1.5 rounded-full ${
							localSyncState === "in-sync"
								? "bg-emerald-400"
								: localSyncState === "error"
									? "bg-rose-400"
									: "animate-pulse bg-amber-400"
						}`}
					/>
					{localSyncState === "in-sync"
						? "File changes synced to local"
						: localSyncState === "error"
							? "Local file sync failed"
							: "Syncing files to local…"}
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				<PtyTerminal
					cwd={inst.cwd}
					environmentId={inst.environmentId}
					instanceId={inst.id}
					command={inst.command}
					initialInput={pendingTerminalInput}
					onInitialInputWritten={() => setPendingTerminalInput("")}
				/>
			</div>
		</div>
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
	initialInput,
	onInitialInputWritten,
}: {
	cwd: string;
	environmentId: EnvironmentId;
	instanceId: PtyId;
	command?: TerminalInstance["command"];
	initialInput?: string;
	onInitialInputWritten?: () => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		terminalRegistry.attach(environmentId, instanceId, container, {
			cwd,
			command,
			initialInput,
			onInitialInputWritten,
		});
		return () => terminalRegistry.detach(environmentId, instanceId);
		// `cwd`/`command` only matter on first open; reconnects reuse the live
		// entry, so the instance id is the sole identity that should re-run this.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [environmentId, instanceId]);

	return (
		<div
			ref={containerRef}
			className="h-full w-full min-w-0 overflow-hidden bg-background px-2 pb-1.5"
		/>
	);
}
