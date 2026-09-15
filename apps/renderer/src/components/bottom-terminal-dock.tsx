import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId } from "@zuse/contracts";
import { ComputerTerminal01Icon } from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	closeBottomTerminalTab,
	restoreOrOpenBottomTerminal,
} from "../lib/bottom-terminal-controller.ts";
import { makeCommittedAuthority } from "../lib/committed-authority.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import {
	hydrateRightTerminalCatalog,
	invalidateTerminalCatalog,
	loadTerminalCatalog,
} from "../lib/terminal-catalog.ts";
import {
	terminalOwnerLimitMessageFor,
	terminalOwnerLimitReached,
} from "../lib/terminal-policy.ts";
import {
	EMPTY_TERMINALS,
	terminalOwnerId,
	terminalOwnerLiveLimit,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import {
	bottomTerminalLayoutForChat,
	DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX,
	rightPaneKey,
	useUiStore,
} from "../store/ui.ts";
import { TerminalSlotPane } from "./terminal-pane.tsx";

const MIN_BOTTOM_TERMINAL_HEIGHT_PX = 140;

const clampHeight = (heightPx: number): number =>
	Math.min(
		Math.max(heightPx, MIN_BOTTOM_TERMINAL_HEIGHT_PX),
		Math.max(MIN_BOTTOM_TERMINAL_HEIGHT_PX, window.innerHeight * 0.7),
	);

/**
 * Chat-scoped terminal dock below the main surface. Its PTYs live in a
 * separate renderer collection from the established right-side terminal tabs.
 * Collapse only unmounts their surfaces; explicit tab close tears down PTYs.
 */
export function BottomTerminalDock({
	chatRef,
	rootPath,
	directoryUnavailable = false,
}: {
	chatRef: ChatRef;
	rootPath: string;
	directoryUnavailable?: boolean;
}) {
	// ChatView intentionally derives this value inline. Keep a stable domain ref
	// so streamed parent renders cannot retrigger terminal catalog discovery.
	const catalogRef = useMemo<ChatRef>(
		() => ({
			environmentId: chatRef.environmentId,
			chatId: chatRef.chatId,
		}),
		[chatRef.environmentId, chatRef.chatId],
	);
	const key = terminalsKey(catalogRef, "bottom");
	// A chat can be left and revisited with the same string key, and an
	// unavailable directory can become usable again. Give every committed
	// identity transition a fresh token so an old response cannot mark the new
	// surface authoritative (the A → B → A case).
	const catalogRequestKey = useMemo(
		() => Symbol("bottom-terminal-catalog-request"),
		[directoryUnavailable, key],
	);
	const layoutKey = rightPaneKey(chatRef);
	const terminals = useTerminalsStore(
		(state) => state.byKey[key] ?? EMPTY_TERMINALS,
	);
	const [catalogStatus, setCatalogStatus] = useState<
		Readonly<{
			requestKey: symbol;
			state: "loading" | "ready" | "failed";
		}>
	>({ requestKey: catalogRequestKey, state: "loading" });
	const catalogState =
		catalogStatus.requestKey === catalogRequestKey
			? catalogStatus.state
			: "loading";
	const activeCatalogRequestAuthorityRef = useRef(
		makeCommittedAuthority(catalogRequestKey),
	);
	useLayoutEffect(() => {
		activeCatalogRequestAuthorityRef.current.commit(catalogRequestKey);
	}, [catalogRequestKey]);
	const storedLayout = useUiStore(
		(state) => state.bottomTerminalLayoutByChat[layoutKey] ?? null,
	);
	const layout =
		storedLayout ?? bottomTerminalLayoutForChat(useUiStore.getState(), chatRef);
	const setOpen = useUiStore((state) => state.setBottomTerminalOpenForChat);
	const setHeight = useUiStore((state) => state.setBottomTerminalHeightForChat);
	const setActive = useUiStore((state) => state.setActiveBottomTerminalForChat);
	const activeTerminal =
		terminals.find((terminal) => terminal.id === layout.activeTerminalId) ??
		terminals[0] ??
		null;
	const ownerId = terminalOwnerId(catalogRef, "bottom");
	const ownerLimitReached = terminalOwnerLimitReached(
		terminals,
		catalogRef.environmentId,
		ownerId,
	);
	const ownerLimit = terminalOwnerLiveLimit(catalogRef.environmentId, ownerId);
	const ownerLimitMessage = terminalOwnerLimitMessageFor(
		catalogRef.environmentId,
		ownerId,
	);
	const resizeStartRef = useRef<{
		readonly pointerId: number;
		readonly y: number;
		readonly heightPx: number;
	} | null>(null);

	useEffect(() => {
		if (directoryUnavailable) return;
		let active = true;
		setCatalogStatus({ requestKey: catalogRequestKey, state: "loading" });
		// This dock is always mounted for the selected chat, even while collapsed.
		// Restore both independent collections before the user asks for another
		// shell, so a renderer reload reconnects instead of silently duplicating it.
		void loadTerminalCatalog(
			catalogRef,
			"bottom",
			catalogRef.environmentId,
		).then(
			() => {
				if (active)
					setCatalogStatus({ requestKey: catalogRequestKey, state: "ready" });
			},
			() => {
				if (active)
					setCatalogStatus({ requestKey: catalogRequestKey, state: "failed" });
			},
		);
		void hydrateRightTerminalCatalog(
			catalogRef,
			EnvironmentId.make(getLocalEnvironmentId()),
		).catch(() => undefined);
		return () => {
			active = false;
			invalidateTerminalCatalog(catalogRef, "bottom", catalogRef.environmentId);
		};
	}, [catalogRef, catalogRequestKey, directoryUnavailable]);

	const runCatalogAction = async (createNew = false) => {
		if (directoryUnavailable) return;
		const expectedRequestKey = catalogRequestKey;
		setCatalogStatus({ requestKey: expectedRequestKey, state: "loading" });
		const result = await restoreOrOpenBottomTerminal(catalogRef, rootPath, {
			isCurrent: () =>
				activeCatalogRequestAuthorityRef.current.isCurrent(expectedRequestKey),
			createNew,
		});
		if (
			result !== "cancelled" &&
			activeCatalogRequestAuthorityRef.current.isCurrent(expectedRequestKey)
		) {
			setCatalogStatus({ requestKey: expectedRequestKey, state: result });
		}
	};
	const openDock = () => runCatalogAction();
	const addTerminal = () => runCatalogAction(true);

	const beginResize = (event: ReactPointerEvent<HTMLHRElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		resizeStartRef.current = {
			pointerId: event.pointerId,
			y: event.clientY,
			heightPx: layout.heightPx,
		};
	};

	if (!layout.open) {
		return (
			<div className="flex h-7 shrink-0 items-center border-border border-t bg-background px-1">
				<button
					type="button"
					aria-label={
						catalogState === "failed"
							? "Retry bottom terminal catalog"
							: "Open bottom terminal"
					}
					onClick={() => void openDock()}
					disabled={directoryUnavailable || catalogState === "loading"}
					className="flex h-7 min-w-0 items-center gap-1.5 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				>
					<HugeiconsIcon
						icon={ComputerTerminal01Icon}
						className="size-3.5 shrink-0"
					/>
					<span>
						{catalogState === "failed"
							? "Terminal unavailable · Retry"
							: "Terminal"}
					</span>
					{terminals.length > 0 ? (
						<span className="font-mono text-[10px] opacity-70">
							{terminals.length}
						</span>
					) : null}
					<ChevronUp className="size-3" />
				</button>
			</div>
		);
	}

	return (
		<section
			aria-label="Bottom terminal"
			className="relative flex min-h-0 shrink-0 flex-col border-border border-t bg-background"
			style={{ height: `${layout.heightPx}px` }}
		>
			<hr
				aria-label="Resize bottom terminal"
				aria-orientation="horizontal"
				aria-valuenow={Math.round(layout.heightPx)}
				tabIndex={0}
				onPointerDown={beginResize}
				onPointerMove={(event) => {
					const start = resizeStartRef.current;
					if (start === null || start.pointerId !== event.pointerId) return;
					setHeight(
						chatRef,
						clampHeight(start.heightPx + start.y - event.clientY),
					);
				}}
				onPointerUp={(event) => {
					if (resizeStartRef.current?.pointerId !== event.pointerId) return;
					resizeStartRef.current = null;
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				onPointerCancel={() => {
					resizeStartRef.current = null;
				}}
				onLostPointerCapture={() => {
					resizeStartRef.current = null;
				}}
				onDoubleClick={() =>
					setHeight(chatRef, DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX)
				}
				onKeyDown={(event) => {
					if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
					event.preventDefault();
					setHeight(
						chatRef,
						clampHeight(layout.heightPx + (event.key === "ArrowUp" ? 16 : -16)),
					);
				}}
				className="absolute inset-x-0 -top-1 z-10 m-0 h-2 cursor-row-resize border-0 outline-none focus-visible:bg-ring/40"
			/>
			<div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto px-1 text-[11px]">
				{terminals.map((terminal) => {
					const active = terminal.id === activeTerminal?.id;
					return (
						<div
							key={terminal.id}
							className={`group flex h-7 shrink-0 items-center rounded px-1.5 transition-colors ${
								active
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
							}`}
						>
							<button
								type="button"
								onClick={() => setActive(chatRef, terminal.id)}
								className="flex h-7 max-w-36 items-center gap-1.5"
							>
								<HugeiconsIcon
									icon={ComputerTerminal01Icon}
									className="size-3.5 shrink-0 opacity-80"
								/>
								<span className="truncate">{terminal.title}</span>
							</button>
							<button
								type="button"
								aria-label={`Close ${terminal.title}`}
								onClick={() => closeBottomTerminalTab(chatRef, terminal.id)}
								className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
							>
								<X className="size-3" strokeWidth={1.8} />
							</button>
						</div>
					);
				})}
				<button
					type="button"
					aria-label="New bottom terminal"
					onClick={() => void addTerminal()}
					disabled={
						directoryUnavailable ||
						catalogState !== "ready" ||
						ownerLimitReached
					}
					title={ownerLimitReached ? ownerLimitMessage : undefined}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Plus className="size-3.5" strokeWidth={1.8} />
				</button>
				{ownerLimitReached ? (
					<span
						title={ownerLimitMessage}
						className="shrink-0 px-1 text-[10px] text-muted-foreground"
					>
						Limit {ownerLimit}
					</span>
				) : null}
				<div className="min-w-2 flex-1" />
				<button
					type="button"
					aria-label="Hide bottom terminal"
					onClick={() => setOpen(chatRef, false)}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
				>
					<ChevronDown className="size-3.5" />
				</button>
			</div>
			{catalogState === "failed" ? (
				<div
					role="alert"
					className="flex h-7 shrink-0 items-center gap-2 px-2 text-[11px] text-muted-foreground"
				>
					<span className="min-w-0 flex-1 truncate">
						Terminal catalog unavailable.
					</span>
					<button
						type="button"
						className="h-7 rounded bg-muted px-2 text-foreground hover:bg-muted/80"
						onClick={() => void openDock()}
					>
						Retry
					</button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col">
				{directoryUnavailable ? (
					<div
						role="status"
						className="grid min-h-0 flex-1 place-items-center px-4 text-center text-xs text-muted-foreground"
					>
						This directory is unavailable.
					</div>
				) : catalogState === "failed" && terminals.length === 0 ? (
					<div className="min-h-0 flex-1" />
				) : catalogState === "loading" && terminals.length === 0 ? (
					<div
						role="status"
						className="grid min-h-0 flex-1 place-items-center px-4 text-center text-xs text-muted-foreground"
					>
						Restoring terminal…
					</div>
				) : (
					terminals.map((terminal, slot) => (
						<div
							key={terminal.id}
							hidden={terminal.id !== activeTerminal?.id}
							className="flex min-h-0 flex-1 flex-col"
						>
							<TerminalSlotPane
								chatRef={chatRef}
								rootPath={rootPath}
								slot={slot}
								placement="bottom"
							/>
						</div>
					))
				)}
			</div>
		</section>
	);
}
