import { HugeiconsIcon } from "@hugeicons/react";
import { MapsIcon, Search01Icon } from "@hugeicons-pro/core-solid-rounded";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	type ChatTurnNavigationEntry,
	deriveChatTurnRailEntries,
} from "../lib/chat-timeline-rows.ts";
import { cn } from "../lib/utils.ts";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";

export function ChatTurnNavigator({
	turns,
	activeMessageId,
	inFlight,
	hasOutOfViewUpdates,
	onReaderIntent,
	onNavigate,
}: {
	readonly turns: ReadonlyArray<ChatTurnNavigationEntry>;
	readonly activeMessageId: string | null;
	readonly inFlight: boolean;
	readonly hasOutOfViewUpdates: boolean;
	readonly onReaderIntent: () => void;
	readonly onNavigate: (entry: ChatTurnNavigationEntry) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [activeDescendantIndex, setActiveDescendantIndex] = useState<
		number | null
	>(null);
	const closeTimerRef = useRef<number | null>(null);
	const highlightGenerationRef = useRef(0);
	const turnListRef = useRef<LegendListRef | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const suppressFocusOpenRef = useRef(false);
	const listboxId = useId();

	const filteredTurns = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		if (needle.length === 0) return turns;
		return turns.filter((turn) =>
			turn.text.toLocaleLowerCase().includes(needle),
		);
	}, [query, turns]);
	const railTurns = useMemo(() => deriveChatTurnRailEntries(turns), [turns]);
	const activeTurnIndex = turns.findIndex(
		(turn) => turn.messageId === activeMessageId,
	);
	const highlightedOptionId =
		activeDescendantIndex === null ||
		filteredTurns[activeDescendantIndex] === undefined
			? undefined
			: `${listboxId}-option-${activeDescendantIndex}`;

	const positionHighlight = useCallback((index: number) => {
		const generation = highlightGenerationRef.current + 1;
		highlightGenerationRef.current = generation;
		setHighlightedIndex(index);
		setActiveDescendantIndex(null);
		requestAnimationFrame(() => {
			const list = turnListRef.current;
			if (list === null) return;
			void list
				.scrollToIndex({
					index,
					viewPosition: 0.5,
					animated: false,
				})
				.then(() => {
					if (highlightGenerationRef.current === generation) {
						setActiveDescendantIndex(index);
					}
				})
				.catch(() => {
					// Leave aria-activedescendant unset if the virtual row did not mount.
				});
		});
	}, []);

	useEffect(() => {
		if (!open) {
			highlightGenerationRef.current += 1;
			setActiveDescendantIndex(null);
			return;
		}
		const activeIndex = filteredTurns.findIndex(
			(turn) => turn.messageId === activeMessageId,
		);
		positionHighlight(Math.max(0, activeIndex));
	}, [activeMessageId, filteredTurns, open, positionHighlight]);

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
		}, 140);
	}, [cancelClose]);

	const moveHighlight = useCallback(
		(next: number) => {
			if (filteredTurns.length === 0) return;
			const bounded = Math.max(0, Math.min(next, filteredTurns.length - 1));
			positionHighlight(bounded);
		},
		[filteredTurns.length, positionHighlight],
	);
	const restoreTriggerFocus = useCallback(() => {
		suppressFocusOpenRef.current = true;
		triggerRef.current?.focus();
		requestAnimationFrame(() => {
			suppressFocusOpenRef.current = false;
		});
	}, []);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveHighlight(highlightedIndex + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveHighlight(highlightedIndex - 1);
		} else if (event.key === "Enter") {
			const selected = filteredTurns[highlightedIndex];
			if (selected === undefined) return;
			event.preventDefault();
			onNavigate(selected);
			setOpen(false);
			restoreTriggerFocus();
		} else if (event.key === "Escape") {
			setOpen(false);
			restoreTriggerFocus();
		}
	};

	if (turns.length < 2) return null;

	return (
		<div
			className="pointer-events-none absolute inset-y-0 left-2 z-20 flex items-center"
			onPointerEnter={(event) => {
				if (event.pointerType === "mouse") {
					cancelClose();
					onReaderIntent();
					setOpen(true);
				}
			}}
			onPointerLeave={(event) => {
				if (event.pointerType === "mouse") scheduleClose();
			}}
		>
			<Popover
				open={open}
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen);
					if (nextOpen) onReaderIntent();
				}}
			>
				<PopoverTrigger
					ref={triggerRef}
					aria-label={`Navigate conversation, ${turns.length} turns`}
					onFocus={(event) => {
						if (
							suppressFocusOpenRef.current ||
							!event.currentTarget.matches(":focus-visible")
						) {
							return;
						}
						onReaderIntent();
						setOpen(true);
					}}
					className={cn(
						"pointer-events-auto relative flex size-11 items-center justify-center rounded-md",
						"text-muted-foreground/55 outline-none transition-colors duration-150",
						"hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					<div
						className="relative flex h-8 w-3 flex-col justify-around"
						aria-hidden
					>
						{railTurns.map((turn) => (
							<span
								key={turn.messageId}
								className={cn(
									"h-px rounded-full bg-current",
									turn.messageId === activeMessageId ? "w-3" : "w-1.5",
									turn.messageId === activeMessageId && "text-foreground",
								)}
							/>
						))}
						{activeTurnIndex >= 0 ? (
							<span
								className="absolute left-0 h-0.5 w-3 -translate-y-1/2 rounded-full bg-foreground"
								style={{
									top: `${(activeTurnIndex / Math.max(1, turns.length - 1)) * 100}%`,
								}}
							/>
						) : null}
					</div>
					{hasOutOfViewUpdates ? (
						<span className="absolute right-0.5 top-1.5 size-1.5 rounded-full bg-lime-500" />
					) : null}
				</PopoverTrigger>
				<PopoverPopup
					side="right"
					align="center"
					sideOffset={6}
					className="w-80 max-w-[calc(100vw-4rem)] rounded-xl border border-border/70 bg-popover p-0 shadow-overlay-lg motion-reduce:transition-none"
					onPointerEnter={cancelClose}
					onPointerLeave={scheduleClose}
					onKeyDown={handleKeyDown}
				>
					<div>
						<div className="flex h-10 items-center gap-2 border-b border-border/60 px-3">
							<HugeiconsIcon
								icon={Search01Icon}
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								onFocus={onReaderIntent}
								placeholder="Find a turn"
								aria-label="Find a turn"
								role="combobox"
								aria-expanded={open}
								aria-controls={listboxId}
								aria-activedescendant={highlightedOptionId}
								className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
							/>
							<span className="text-[10px] tabular-nums text-muted-foreground">
								{filteredTurns.length}/{turns.length}
							</span>
						</div>
						{filteredTurns.length === 0 ? (
							<p className="px-3 py-8 text-center text-xs text-muted-foreground">
								No matching turns
							</p>
						) : (
							<LegendList<ChatTurnNavigationEntry>
								ref={turnListRef}
								data={filteredTurns}
								keyExtractor={(turn) => turn.messageId}
								estimatedItemSize={44}
								getFixedItemSize={() => 44}
								role="listbox"
								id={listboxId}
								aria-label="Conversation turns"
								className="max-h-[min(65vh,32rem)] overflow-y-auto overscroll-contain px-1.5"
								style={{
									height: Math.min(
										512,
										Math.max(44, filteredTurns.length * 44),
									),
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
											aria-selected={highlighted}
											aria-current={active ? "location" : undefined}
											onPointerMove={() => {
												highlightGenerationRef.current += 1;
												setHighlightedIndex(index);
												setActiveDescendantIndex(index);
											}}
											onClick={() => {
												onNavigate(turn);
												setOpen(false);
											}}
											className={cn(
												"flex h-11 w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none",
												highlighted && "bg-muted",
												active && "text-foreground",
											)}
										>
											<span className="mt-0.5 w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
												{turn.turnNumber}
											</span>
											<span className="line-clamp-2 min-w-0 flex-1 leading-5">
												{turn.text}
											</span>
											{active ? (
												<span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground" />
											) : null}
										</button>
									);
								}}
							/>
						)}
						<div className="flex h-9 items-center justify-between border-t border-border/60 px-3 text-[10px] text-muted-foreground">
							<span className="inline-flex items-center gap-1.5">
								<HugeiconsIcon icon={MapsIcon} className="size-3" />
								Conversation map
							</span>
							{inFlight ? <span>Reply streaming</span> : null}
						</div>
					</div>
				</PopoverPopup>
			</Popover>
		</div>
	);
}
