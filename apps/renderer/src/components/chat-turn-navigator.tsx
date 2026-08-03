import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { useMediaQuery } from "../hooks/use-media-query.ts";
import {
	type ChatTurnNavigationEntry,
	deriveChatTurnRailEntries,
} from "../lib/chat-timeline-rows.ts";
import {
	canShowChatTurnNavigator,
	resolveChatTurnListHeight,
} from "../lib/chat-turn-navigator-layout.ts";
import { cn } from "../lib/utils.ts";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";

const CLOSE_DELAY_MS = 140;
const MAX_LIST_HEIGHT = 320;
const HIGHLIGHT_SETTLE_ATTEMPTS = 4;

export function ChatTurnNavigator({
	turns,
	activeMessageId,
	hasOutOfViewUpdates,
	onReaderIntent,
	onNavigate,
}: {
	readonly turns: ReadonlyArray<ChatTurnNavigationEntry>;
	readonly activeMessageId: string | null;
	readonly hasOutOfViewUpdates: boolean;
	readonly onReaderIntent: () => void;
	readonly onNavigate: (entry: ChatTurnNavigationEntry) => void;
}) {
	const [open, setOpen] = useState(false);
	const [hasSpace, setHasSpace] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [activeDescendantIndex, setActiveDescendantIndex] = useState<
		number | null
	>(null);
	const closeTimerRef = useRef<number | null>(null);
	const highlightGenerationRef = useRef(0);
	const turnListRef = useRef<LegendListRef | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const suppressFocusOpenRef = useRef(false);
	const focusPopupOnOpenRef = useRef(false);
	const listboxId = useId();
	const coarsePointer = useMediaQuery({ pointer: "coarse" });
	const rowHeight = coarsePointer ? 44 : 32;
	const canNavigate = turns.length >= 2;
	const railTurns = useMemo(
		() => deriveChatTurnRailEntries(turns, 18, activeMessageId),
		[activeMessageId, turns],
	);
	const highlightedOptionId =
		activeDescendantIndex === null || turns[activeDescendantIndex] === undefined
			? undefined
			: `${listboxId}-option-${activeDescendantIndex}`;

	useLayoutEffect(() => {
		if (!canNavigate) {
			setHasSpace(false);
			return;
		}
		const transcript = wrapperRef.current?.parentElement;
		if (transcript === null || transcript === undefined) return;

		const update = () => {
			const next = canShowChatTurnNavigator({
				width: transcript.clientWidth,
				height: transcript.clientHeight,
			});
			setHasSpace(next);
			if (!next) setOpen(false);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(transcript);
		return () => observer.disconnect();
	}, [canNavigate]);

	const positionHighlight = useCallback((index: number) => {
		const generation = highlightGenerationRef.current + 1;
		highlightGenerationRef.current = generation;
		setHighlightedIndex(index);
		setActiveDescendantIndex(null);
		const settle = (attempts: number) => {
			requestAnimationFrame(() => {
				if (highlightGenerationRef.current !== generation) return;
				const list = turnListRef.current;
				if (list === null) {
					if (attempts > 0) settle(attempts - 1);
					return;
				}
				void list
					.scrollToIndex({ index, viewPosition: 0.5, animated: false })
					.then(() => {
						if (highlightGenerationRef.current === generation) {
							setActiveDescendantIndex(index);
						}
					})
					.catch(() => {
						if (highlightGenerationRef.current === generation && attempts > 0) {
							settle(attempts - 1);
						}
					});
			});
		};
		settle(HIGHLIGHT_SETTLE_ATTEMPTS);
	}, []);

	useEffect(() => {
		if (!open) {
			highlightGenerationRef.current += 1;
			setActiveDescendantIndex(null);
			return;
		}
		const activeIndex = turns.findIndex(
			(turn) => turn.messageId === activeMessageId,
		);
		positionHighlight(Math.max(0, activeIndex));
	}, [activeMessageId, open, positionHighlight, turns]);

	useEffect(
		() => () => {
			if (closeTimerRef.current !== null) {
				window.clearTimeout(closeTimerRef.current);
			}
		},
		[],
	);

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
		}, CLOSE_DELAY_MS);
	}, [cancelClose]);

	const openFromReaderIntent = useCallback(
		(focusPopup: boolean) => {
			if (!hasSpace) return;
			focusPopupOnOpenRef.current = focusPopup;
			cancelClose();
			onReaderIntent();
			setOpen(true);
		},
		[cancelClose, hasSpace, onReaderIntent],
	);

	const moveHighlight = useCallback(
		(next: number) => {
			const bounded = Math.max(0, Math.min(next, turns.length - 1));
			positionHighlight(bounded);
		},
		[positionHighlight, turns.length],
	);

	const restoreTriggerFocus = useCallback(() => {
		suppressFocusOpenRef.current = true;
		triggerRef.current?.focus();
		requestAnimationFrame(() => {
			suppressFocusOpenRef.current = false;
		});
	}, []);

	const selectTurn = useCallback(
		(turn: ChatTurnNavigationEntry) => {
			onNavigate(turn);
			setOpen(false);
		},
		[onNavigate],
	);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveHighlight(highlightedIndex + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveHighlight(highlightedIndex - 1);
		} else if (event.key === "Enter") {
			const selected = turns[highlightedIndex];
			if (selected === undefined) return;
			event.preventDefault();
			selectTurn(selected);
			restoreTriggerFocus();
		} else if (event.key === "Escape") {
			setOpen(false);
			restoreTriggerFocus();
		}
	};

	if (!canNavigate) return null;

	return (
		<div
			ref={wrapperRef}
			data-chat-turn-navigator
			aria-hidden={hasSpace ? undefined : true}
			className={cn(
				"pointer-events-none absolute right-0 top-0 z-20",
				!hasSpace && "invisible",
			)}
		>
			<Popover
				open={hasSpace && open}
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen && hasSpace);
					if (nextOpen && hasSpace) onReaderIntent();
				}}
			>
				<PopoverTrigger
					ref={triggerRef}
					aria-label="Navigate conversation"
					disabled={!hasSpace}
					tabIndex={hasSpace ? 0 : -1}
					onPointerEnter={(event) => {
						if (event.pointerType === "mouse") openFromReaderIntent(false);
					}}
					onPointerDown={() => {
						focusPopupOnOpenRef.current = false;
					}}
					onPointerLeave={(event) => {
						if (event.pointerType === "mouse") scheduleClose();
					}}
					onFocus={(event) => {
						if (
							suppressFocusOpenRef.current ||
							!event.currentTarget.matches(":focus-visible")
						) {
							return;
						}
						openFromReaderIntent(true);
					}}
					className={cn(
						"pointer-events-auto relative flex items-center justify-end bg-transparent",
						coarsePointer ? "size-11" : "size-8",
						"text-muted-foreground/50 outline-none transition-colors duration-150",
						"hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
					)}
				>
					<div
						className="relative flex h-6 w-5 flex-col items-end justify-around"
						aria-hidden
					>
						{railTurns.map((turn) => (
							<span
								key={turn.messageId}
								className={cn(
									"h-px rounded-full bg-current transition-[width,opacity] duration-150",
									turn.messageId === activeMessageId
										? "w-5 opacity-100"
										: "w-3.5 opacity-65",
								)}
							/>
						))}
					</div>
					{hasOutOfViewUpdates ? (
						<span className="absolute right-0 top-0 size-1.5 rounded-full bg-lime-500" />
					) : null}
				</PopoverTrigger>
				<PopoverPopup
					side="bottom"
					align="end"
					sideOffset={4}
					className="w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border/70 bg-popover p-0 shadow-overlay-lg motion-reduce:transition-none [&_[data-slot=popover-viewport]]:rounded-lg [&_[data-slot=popover-viewport]]:p-0"
					initialFocus={() => focusPopupOnOpenRef.current}
					finalFocus={false}
					onPointerEnter={cancelClose}
					onPointerLeave={scheduleClose}
					onKeyDown={handleKeyDown}
				>
					<LegendList<ChatTurnNavigationEntry>
						ref={turnListRef}
						data={turns}
						keyExtractor={(turn) => turn.messageId}
						estimatedItemSize={rowHeight}
						getFixedItemSize={() => rowHeight}
						role="listbox"
						id={listboxId}
						aria-label="Conversation turns"
						aria-activedescendant={highlightedOptionId}
						tabIndex={0}
						className="overflow-y-auto overscroll-contain py-1 pl-1 [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-border"
						style={{
							height: resolveChatTurnListHeight({
								turnCount: turns.length,
								rowHeight,
								maxHeight: MAX_LIST_HEIGHT,
							}),
						}}
						renderItem={({ item: turn, index }) => {
							const active = turn.messageId === activeMessageId;
							const highlighted = index === highlightedIndex;
							return (
								<button
									key={turn.messageId}
									id={`${listboxId}-option-${index}`}
									type="button"
									role="option"
									tabIndex={-1}
									aria-selected={active}
									aria-current={active ? "location" : undefined}
									onPointerMove={() => {
										highlightGenerationRef.current += 1;
										setHighlightedIndex(index);
										setActiveDescendantIndex(index);
									}}
									onClick={() => selectTurn(turn)}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none",
										"transition-[background-color,color,transform] duration-150 ease-out hover:translate-x-0.5 hover:bg-muted/70",
										highlighted && "bg-muted/70",
										active && "bg-muted/45 text-foreground",
									)}
									style={{ height: rowHeight }}
								>
									<span className="min-w-0 flex-1 truncate">{turn.text}</span>
									{active ? (
										<span className="size-1.5 shrink-0 rounded-full bg-foreground" />
									) : null}
								</button>
							);
						}}
					/>
				</PopoverPopup>
			</Popover>
		</div>
	);
}
