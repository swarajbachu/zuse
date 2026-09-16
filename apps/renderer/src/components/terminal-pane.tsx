import { isInputComposing } from "../lib/input-composition.ts";
import "@zuse/i18n/english/chat";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import { appendPendingTerminalInput } from "@zuse/client-runtime/terminal-input-pump";
import type { EnvironmentId, PtyId, PtyOwnerId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Eraser, RotateCcw } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useCloudSyncStatus } from "../lib/cloud-sync-client-bus.ts";
import {
	cloudSummaryForChat,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import {
	invalidateTerminalCatalog,
	loadTerminalCatalog,
} from "../lib/terminal-catalog.ts";
import {
	terminalOwnerLimitMessageFor,
	terminalOwnerLimitReached,
} from "../lib/terminal-policy.ts";
import * as terminalRegistry from "../lib/terminal-registry.ts";
import {
	EMPTY_TERMINALS,
	type TerminalInstance,
	type TerminalPlacement,
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

/**
 * Right-pane terminal host. Each right-dock terminal tab carries a
 * chat-relative `slot`; `TerminalSlotPane` resolves it against the active
 * chat's terminal list and mounts one `PtyTerminal`. The Ghostty surface + PTY live in
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
	placement = "right",
}: {
	chatRef: ChatRef;
	rootPath: string;
	slot: number;
	placement?: TerminalPlacement;
}) {
	return (
		<PlainTerminalSlot
			chatRef={chatRef}
			rootPath={rootPath}
			slot={slot}
			placement={placement}
		/>
	);
}

function PlainTerminalSlot({
	chatRef,
	rootPath,
	slot,
	placement,
}: {
	chatRef: ChatRef;
	rootPath: string;
	slot: number;
	placement: TerminalPlacement;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	// Callers may construct an equivalent ChatRef on every render. Preserve its
	// domain identity so catalog effects do not turn unrelated parent renders
	// (notably streamed chat output) into repeated pty.list requests.
	const catalogRef = useMemo<ChatRef>(
		() => ({
			environmentId: chatRef.environmentId,
			chatId: chatRef.chatId,
		}),
		[chatRef.environmentId, chatRef.chatId],
	);
	const key = terminalsKey(catalogRef, placement);
	const registeredCloudSummaryCandidate = cloudSummaryForChat(
		catalogRef.chatId,
	);
	const registeredCloudSummary =
		registeredCloudSummaryCandidate?.workspaceId === chatRef.environmentId
			? registeredCloudSummaryCandidate
			: null;
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find(
				(summary) =>
					summary.chatId === catalogRef.chatId &&
					summary.workspaceId === catalogRef.environmentId,
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
		cloudSummary === null || localTerminal ? null : catalogRef.environmentId,
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
	const [pendingTerminalInput, setPendingTerminalInput] = useState({
		data: "",
		overflowed: false,
	});
	const queuePendingTerminalInput = (input: string): void => {
		setPendingTerminalInput((current) =>
			appendPendingTerminalInput(current, input),
		);
	};
	const ensureSlot = useTerminalsStore((s) => s.ensureSlot);
	const resolvedRootPath =
		cloudSummary === null
			? rootPath
			: (cloudShell.data?.folders[0]?.path ?? rootPath);
	const catalogEnvironmentId =
		instance?.environmentId ?? catalogRef.environmentId;
	const catalogOwnerId = terminalOwnerId(catalogRef, placement);
	// A reconnect must earn a fresh authoritative catalog result. Including the
	// concrete connection state makes ready → detached → ready a new identity,
	// while scalar ref/owner fields prevent parent renders from restarting it.
	const catalogRequestKey = useMemo(
		() => Symbol("terminal-catalog-request"),
		[
			catalogEnvironmentId,
			catalogRef.chatId,
			catalogRef.environmentId,
			cloudShell.connection,
			placement,
		],
	);
	const [catalogStatus, setCatalogStatus] = useState<
		Readonly<{
			requestKey: symbol;
			attempt: symbol;
			state: "loading" | "ready" | "failed";
		}>
	>({
		requestKey: catalogRequestKey,
		attempt: Symbol("terminal-catalog-attempt"),
		state: "loading",
	});
	const catalogState =
		catalogStatus.requestKey === catalogRequestKey
			? catalogStatus.state
			: "loading";
	const ownerLimitReached =
		instance === undefined &&
		terminalOwnerLimitReached(list, catalogEnvironmentId, catalogOwnerId);

	const waitingForCloud =
		cloudSummary !== null &&
		!localTerminal &&
		cloudAttachment !== "failed" &&
		(cloudSummary.state === "paused" ||
			cloudSummary.state === "resuming" ||
			cloudSummary.state === "provisioning" ||
			cloudSummary.state === "setup" ||
			cloudSummary.state === "queued");

	useEffect(() => {
		if (cloudAttachment !== "ready" || waitingForCloud) return;
		let active = true;
		const attempt = Symbol("terminal-catalog-attempt");
		setCatalogStatus({
			requestKey: catalogRequestKey,
			attempt,
			state: "loading",
		});
		void loadTerminalCatalog(catalogRef, placement, catalogEnvironmentId).then(
			() => {
				if (active)
					setCatalogStatus((current) =>
						current.requestKey === catalogRequestKey &&
						current.attempt === attempt
							? { requestKey: catalogRequestKey, attempt, state: "ready" }
							: current,
					);
			},
			() => {
				if (active)
					setCatalogStatus((current) =>
						current.requestKey === catalogRequestKey &&
						current.attempt === attempt
							? { requestKey: catalogRequestKey, attempt, state: "failed" }
							: current,
					);
			},
		);
		return () => {
			active = false;
		};
	}, [
		catalogEnvironmentId,
		catalogRef,
		catalogRequestKey,
		cloudAttachment,
		placement,
	]);

	useEffect(() => {
		if (cloudAttachment !== "ready" || catalogState !== "ready") return;
		const instance = list[slot];
		if (
			instance === undefined &&
			!terminalOwnerLimitReached(list, catalogEnvironmentId, catalogOwnerId)
		)
			ensureSlot(catalogRef, slot, resolvedRootPath, placement);
	}, [
		catalogEnvironmentId,
		catalogOwnerId,
		catalogRef,
		catalogState,
		cloudAttachment,
		waitingForCloud,
		cloudSummary,
		ensureSlot,
		list,
		placement,
		resolvedRootPath,
		slot,
	]);

	if (waitingForCloud)
		return (
			<TerminalPlaceholder>
				<span role="status" aria-live="polite">
					<ShimmerText>
						{uiMessage("chat:cloud_queue_waiting_for_cloud")}
					</ShimmerText>
				</span>
			</TerminalPlaceholder>
		);
	if (cloudAttachment === "attaching")
		return (
			<TerminalPlaceholder>
				<ShimmerText>
					{uiMessage("chat:terminal_pane_reconnecting_cloud_terminal")}
				</ShimmerText>
			</TerminalPlaceholder>
		);
	if (cloudSummary !== null && cloudAttachment !== "ready")
		return (
			<TerminalPlaceholder>
				<div className="relative h-full w-full">
					<textarea
						value=""
						onChange={() => undefined}
						aria-label={uiMessage(
							"chat:terminal_pane_cloud_terminal_type_to_resume_the_workspace",
						)}
						placeholder={
							cloudAttachment === "failed"
								? uiMessage(
										"chat:terminal_pane_cloud_terminal_could_not_connect_type_here_to_try_again",
									)
								: cloudSummary.state === "paused"
									? uiMessage(
											"chat:terminal_pane_workspace_paused_type_here_to_resume_the_terminal",
										)
									: uiMessage(
											"chat:terminal_pane_cloud_terminal_is_unavailable",
										)
						}
						className="h-full min-h-11 w-full resize-none cursor-text content-center border-0 bg-transparent px-6 text-center text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
						onKeyDown={(event) => {
							if (isInputComposing(event)) return;
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
							queuePendingTerminalInput(input);
						}}
						onPaste={(event) => {
							const input = event.clipboardData.getData("text");
							if (input.length === 0) return;
							event.preventDefault();
							queuePendingTerminalInput(input);
						}}
					/>
					{pendingTerminalInput.overflowed ? (
						<div
							role="alert"
							className="absolute inset-x-3 bottom-2 text-center text-[11px] text-destructive"
						>
							{uiMessage("chat:terminal_input_limit")}
						</div>
					) : null}
				</div>
			</TerminalPlaceholder>
		);
	if (catalogState === "loading")
		return (
			<TerminalPlaceholder>
				<ShimmerText>{uiMessage("chat:terminal_restoring")}</ShimmerText>
			</TerminalPlaceholder>
		);
	if (catalogState === "failed")
		return (
			<TerminalPlaceholder>
				<div className="flex items-center gap-2">
					<span>{uiMessage("chat:terminal_catalog_unavailable")}</span>
					<button
						type="button"
						className="h-7 rounded bg-muted px-2 text-foreground hover:bg-muted/80"
						onClick={() => {
							invalidateTerminalCatalog(
								catalogRef,
								placement,
								catalogEnvironmentId,
							);
							const requestKey = catalogRequestKey;
							const attempt = Symbol("terminal-catalog-attempt");
							setCatalogStatus({ requestKey, attempt, state: "loading" });
							void loadTerminalCatalog(
								catalogRef,
								placement,
								catalogEnvironmentId,
								{ force: true },
							).then(
								() =>
									setCatalogStatus((current) =>
										current.requestKey === requestKey &&
										current.attempt === attempt
											? { requestKey, attempt, state: "ready" }
											: current,
									),
								() =>
									setCatalogStatus((current) =>
										current.requestKey === requestKey &&
										current.attempt === attempt
											? { requestKey, attempt, state: "failed" }
											: current,
									),
							);
						}}
					>
						{uiMessage("common:retry")}
					</button>
				</div>
			</TerminalPlaceholder>
		);
	if (ownerLimitReached)
		return (
			<TerminalPlaceholder>
				<span role="alert">
					{terminalOwnerLimitMessageFor(catalogEnvironmentId, catalogOwnerId)}
				</span>
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
						? uiMessage("chat:terminal_pane_file_changes_synced_to_local")
						: localSyncState === "error"
							? uiMessage("chat:terminal_pane_local_file_sync_failed")
							: localSyncState === "pending"
								? uiMessage("chat:terminal_pane_waiting_for_changes_to_settle")
								: uiMessage("chat:terminal_pane_syncing_files_to_local")}
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				<PtyTerminal
					cwd={inst.cwd}
					environmentId={inst.environmentId}
					instanceId={inst.id}
					ownerId={inst.ownerId}
					title={inst.title}
					serverPtyId={inst.serverPtyId}
					processEpoch={inst.processEpoch}
					command={inst.command}
					initialInput={pendingTerminalInput.data}
					onInitialInputWritten={() =>
						setPendingTerminalInput({ data: "", overflowed: false })
					}
					onPtyBound={(ptyId, processEpoch) =>
						useTerminalsStore
							.getState()
							.bindPty(catalogRef, inst.id, placement, ptyId, processEpoch)
					}
					onStatusChanged={(status) =>
						useTerminalsStore
							.getState()
							.observeRuntimeStatus(catalogRef, inst.id, placement, status)
					}
				/>
			</div>
		</div>
	);
}

export function TerminalTabControls({
	chatRef,
	instance,
	placement,
}: {
	chatRef: ChatRef;
	instance: TerminalInstance;
	placement: TerminalPlacement;
}) {
	const [draft, setDraft] = useState(instance.title);
	const { message: uiMessage } = useUiMessages(["chat"]);
	const [operation, setOperation] = useState<
		"rename" | "restart" | "clear" | null
	>(null);
	const operationRef = useRef<"rename" | "restart" | "clear" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const statuses = useSyncExternalStore(
		terminalRegistry.subscribeStatuses,
		terminalRegistry.getStatusesSnapshot,
		terminalRegistry.getStatusesSnapshot,
	);
	const status =
		statuses[
			terminalRegistry.terminalRuntimeKey(instance.environmentId, instance.id)
		] ?? "connecting";
	const runtimeFailure =
		status === "failed"
			? terminalRegistry.getTerminalFailureMessage(
					instance.environmentId,
					instance.id,
				)
			: null;

	useEffect(() => setDraft(instance.title), [instance.title]);

	const beginOperation = (kind: "rename" | "restart" | "clear"): boolean => {
		if (operationRef.current !== null) return false;
		operationRef.current = kind;
		setOperation(kind);
		setError(null);
		return true;
	};

	const finishOperation = (kind: "rename" | "restart" | "clear"): void => {
		if (operationRef.current !== kind) return;
		operationRef.current = null;
		setOperation(null);
	};

	const commitRename = async (event?: FormEvent) => {
		event?.preventDefault();
		const title = draft.trim();
		if (title.length === 0 || title === instance.title) {
			setDraft(instance.title);
			return;
		}
		if (!beginOperation("rename")) return;
		try {
			await terminalRegistry.rename(instance.environmentId, instance.id, title);
			useTerminalsStore
				.getState()
				.rename(chatRef, instance.id, placement, title);
		} catch (cause) {
			setDraft(instance.title);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			finishOperation("rename");
		}
	};

	const run = async (kind: "restart" | "clear") => {
		if (!beginOperation(kind)) return;
		try {
			if (kind === "restart")
				await terminalRegistry.restart(instance.environmentId, instance.id);
			else
				await terminalRegistry.clearScreen(instance.environmentId, instance.id);
		} catch (cause) {
			setError(
				terminalRegistry.getTerminalFailureMessage(
					instance.environmentId,
					instance.id,
				) ?? (cause instanceof Error ? cause.message : String(cause)),
			);
		} finally {
			finishOperation(kind);
		}
	};

	return (
		<Popover>
			<PopoverTrigger
				aria-label={uiMessage("chat:terminal_actions", {
					title: instance.title,
				})}
				title={`${instance.title}: ${error ?? runtimeFailure ?? status}`}
				className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span
					role="status"
					aria-label={`${instance.title}: ${error ?? runtimeFailure ?? status}`}
					className={`size-1.5 shrink-0 rounded-full ${
						status === "running"
							? "bg-emerald-400"
							: status === "failed"
								? "bg-rose-400"
								: status === "exited"
									? "bg-muted-foreground/50"
									: "animate-pulse bg-amber-400"
					}`}
				/>
			</PopoverTrigger>
			<PopoverPopup
				aria-label={uiMessage("chat:terminal_controls", {
					title: instance.title,
				})}
				align="end"
				className="w-56"
			>
				<form
					onSubmit={(event) => void commitRename(event)}
					className="min-w-0"
				>
					<input
						aria-label={uiMessage("chat:terminal_name")}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onBlur={() => void commitRename()}
						disabled={operation !== null}
						className="h-7 w-full truncate rounded bg-transparent px-1 text-xs text-foreground outline-none hover:bg-muted/50 focus:bg-muted/70"
					/>
				</form>
				<span
					className="block px-1 py-1 text-[11px] text-muted-foreground break-words"
					role="status"
					title={error ?? runtimeFailure ?? status}
				>
					{error ?? runtimeFailure ?? status}
				</span>
				<button
					type="button"
					aria-label={uiMessage("chat:terminal_clear_screen_label")}
					title={uiMessage("chat:terminal_clear_screen_label")}
					disabled={operation !== null || status !== "running"}
					onClick={() => void run("clear")}
					className="flex h-7 w-full items-center gap-2 rounded px-1 text-xs hover:bg-muted disabled:opacity-40"
				>
					<Eraser className="size-3" />
					{uiMessage("chat:terminal_clear_screen")}
				</button>
				<button
					type="button"
					aria-label={uiMessage("chat:terminal_restart_process_label")}
					title={uiMessage("chat:terminal_restart_process_label")}
					disabled={
						operation !== null ||
						status === "connecting" ||
						status === "reconnecting"
					}
					onClick={() => void run("restart")}
					className="flex h-7 w-full items-center gap-2 rounded px-1 text-xs hover:bg-muted disabled:opacity-40"
				>
					<RotateCcw
						className={`size-3 ${operation === "restart" ? "animate-spin" : ""}`}
					/>
					{uiMessage("chat:terminal_restart_process")}
				</button>
			</PopoverPopup>
		</Popover>
	);
}

/**
 * Thin host for one terminal instance. The Ghostty surface + PTY live in
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
	ownerId,
	title,
	serverPtyId,
	processEpoch,
	command,
	initialInput,
	onInitialInputWritten,
	onPtyBound,
	onStatusChanged,
}: {
	cwd: string;
	environmentId: EnvironmentId;
	instanceId: PtyId;
	ownerId: PtyOwnerId;
	title: string;
	serverPtyId?: PtyId;
	processEpoch?: string;
	command?: TerminalInstance["command"];
	initialInput?: string;
	onInitialInputWritten?: () => void;
	onPtyBound?: (ptyId: PtyId, processEpoch: string) => void;
	onStatusChanged?: (status: terminalRegistry.TerminalRuntimeStatus) => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		terminalRegistry.attach(environmentId, instanceId, container, {
			cwd,
			ownerId,
			title,
			serverPtyId,
			processEpoch,
			command,
			initialInput,
			onInitialInputWritten,
			onPtyBound,
			onStatusChanged,
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
