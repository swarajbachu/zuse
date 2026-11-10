import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/commands";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LegendListRef } from "@legendapp/list/react";
import type { SessionId } from "@zuse/contracts";
import { formatNumber } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Cancel01Icon,
} from "@zuse/icons/solid-rounded";
import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePrefersReducedMotion } from "../hooks/use-media-query.ts";
import {
	type ChatFindMatch,
	chatFindMatcher,
	findChatMatches,
	firstChatFindIndexFromRow,
	normalizeChatFindQuery,
	resolveActiveChatFindIndex,
	wrapChatFindIndex,
} from "../lib/chat-find.ts";
import {
	clearChatFindHighlights,
	collectChatFindRanges,
	mountedChatFindRow,
	mountedChatFindRows,
	pickCurrentChatFindRange,
	readChatFindSelection,
	resolveChatFindRowRoot,
	scrollChatFindTargetIntoView,
	setChatFindHighlights,
} from "../lib/chat-find-dom.ts";
import type { ChatTimelineRow } from "../lib/chat-timeline-rows.ts";
import { cn } from "../lib/utils.ts";
import { useChatFindStore } from "../store/chat-find.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { overlaySurface } from "./ui/overlay-surface.ts";

const EMPTY_MATCHES: ReadonlyArray<ChatFindMatch> = [];
/** Frames to wait for the virtualizer to mount a row after scrolling to it. */
const MOUNT_RETRY_FRAMES = 8;

interface TrackedMatches {
	readonly query: string;
	readonly matches: ReadonlyArray<ChatFindMatch>;
	readonly index: number;
	/** Bumps when the user (not the transcript) moved the active match. */
	readonly navigation: number;
}

const nextFrame = (): Promise<void> =>
	new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});

/** A fresh search starts from what the reader is looking at, not the top. */
const firstVisibleRow = (list: LegendListRef | null): number =>
	list === null ? 0 : Math.max(0, list.getState().start);

/**
 * Floating find widget for the active transcript. Matching runs over the
 * timeline rows (the list is virtualized); highlights are painted only on the
 * rows that are mounted and refreshed when the transcript DOM changes.
 */
export function ChatFindBar({
	sessionId,
	rows,
	listRef,
	onNavigate,
	historyStatus,
}: {
	readonly sessionId: SessionId;
	readonly rows: ReadonlyArray<ChatTimelineRow>;
	readonly listRef: RefObject<LegendListRef | null>;
	readonly onNavigate: () => void;
	readonly historyStatus?: "loading" | "failed";
}) {
	const { message: uiMessage } = useUiMessages(["chat", "commands"]);
	const open = useChatFindStore((state) => state.open);
	const revealToken = useChatFindStore((state) => state.revealToken);
	const query = useChatFindStore((state) => state.query);
	const prefersReducedMotion = usePrefersReducedMotion();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const deferredQuery = useDeferredValue(query);
	const matches = useMemo(
		() => (open ? findChatMatches(rows, deferredQuery) : EMPTY_MATCHES),
		[open, rows, deferredQuery],
	);

	const [tracked, setTracked] = useState<TrackedMatches>({
		query: "",
		matches: EMPTY_MATCHES,
		index: -1,
		navigation: 0,
	});
	if (tracked.matches !== matches) {
		const previous = tracked.matches[tracked.index] ?? null;
		const queryChanged = tracked.query !== deferredQuery;
		setTracked({
			// Closing forgets the query so reopening starts a fresh search.
			query: open ? deferredQuery : "",
			matches,
			index: queryChanged
				? firstChatFindIndexFromRow(
						previous?.rowIndex ?? firstVisibleRow(listRef.current),
						matches,
					)
				: resolveActiveChatFindIndex(previous, tracked.index, matches),
			navigation:
				queryChanged && matches.length > 0
					? tracked.navigation + 1
					: tracked.navigation,
		});
	}
	const current = tracked.matches[tracked.index] ?? null;
	const total = tracked.matches.length;

	const step = useCallback((direction: 1 | -1) => {
		setTracked((state) =>
			state.matches.length === 0
				? state
				: {
						...state,
						index: wrapChatFindIndex(
							state.index + direction,
							state.matches.length,
						),
						navigation: state.navigation + 1,
					},
		);
	}, []);

	const close = useCallback(() => {
		useChatFindStore.getState().close();
		useComposerBridge.getState().focus?.();
	}, []);

	// Repaint highlights against whatever rows are mounted right now. Reading
	// through refs keeps the mutation observer subscribed once per transcript.
	const matcherRef = useRef<RegExp | null>(null);
	matcherRef.current = open ? chatFindMatcher(tracked.query) : null;
	const currentRef = useRef<ChatFindMatch | null>(null);
	currentRef.current = current;
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const currentRangeRef = useRef<Range | null>(null);

	const applyHighlights = useCallback((): void => {
		const list = listRef.current;
		const matcher = matcherRef.current;
		currentRangeRef.current = null;
		if (list === null || matcher === null) {
			clearChatFindHighlights();
			return;
		}
		const all: Range[] = [];
		let currentRange: Range | null = null;
		const activeMatch = currentRef.current;
		for (const mounted of mountedChatFindRows(list, rowsRef.current.length)) {
			const row = rowsRef.current[mounted.index];
			if (row === undefined) continue;
			const ranges = collectChatFindRanges(
				resolveChatFindRowRoot(mounted.element, row),
				matcher,
			);
			if (activeMatch !== null && mounted.index === activeMatch.rowIndex) {
				currentRange = pickCurrentChatFindRange(ranges, activeMatch);
			}
			for (const range of ranges) all.push(range);
		}
		currentRangeRef.current = currentRange;
		setChatFindHighlights(all, currentRange);
	}, [listRef]);

	useEffect(() => {
		if (open) applyHighlights();
		else clearChatFindHighlights();
	}, [open, applyHighlights, tracked.matches, tracked.index]);

	// Rows mounting, unmounting, or streaming are DOM mutations; repaint once
	// per frame so highlights track the transcript without touching its markup.
	const hasRows = rows.length > 0;
	useEffect(() => {
		if (!open || !hasRows) return;
		const root = listRef.current?.getScrollableNode() ?? null;
		if (root === null) return;
		let frame: number | null = null;
		const observer = new MutationObserver(() => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				applyHighlights();
			});
		});
		observer.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [open, hasRows, applyHighlights, listRef]);

	// Bring the active match into view after the user moves it. Transcript
	// updates that merely re-derive the same match must not scroll, so the
	// effect keys on the navigation counter alone and reads the rest via refs.
	const onNavigateRef = useRef(onNavigate);
	onNavigateRef.current = onNavigate;
	const behaviorRef = useRef<ScrollBehavior>("smooth");
	behaviorRef.current = prefersReducedMotion ? "auto" : "smooth";
	const navigationGenerationRef = useRef(0);
	useEffect(() => {
		const current = currentRef.current;
		if (!open || tracked.navigation === 0 || current === null) return;
		navigationGenerationRef.current += 1;
		const generation = navigationGenerationRef.current;
		const list = listRef.current;
		if (list === null) return;
		const behavior = behaviorRef.current;
		onNavigateRef.current();
		void (async () => {
			let container = mountedChatFindRow(list, current.rowIndex);
			if (container === null) {
				await list
					.scrollToIndex({
						index: current.rowIndex,
						viewPosition: 0.5,
						animated: false,
					})
					.catch(() => {});
				for (let attempt = 0; attempt < MOUNT_RETRY_FRAMES; attempt += 1) {
					await nextFrame();
					if (navigationGenerationRef.current !== generation) return;
					container = mountedChatFindRow(list, current.rowIndex);
					if (container !== null) break;
				}
			}
			if (navigationGenerationRef.current !== generation) return;
			if (container === null) return;
			applyHighlights();
			scrollChatFindTargetIntoView(
				list.getScrollableNode(),
				currentRangeRef.current ?? container,
				behavior,
			);
		})();
	}, [open, tracked.navigation, listRef, applyHighlights]);

	// Reveal: prefill from a transcript selection, then focus and select.
	useEffect(() => {
		if (!open) return;
		const input = inputRef.current;
		if (input === null) return;
		const selected = readChatFindSelection(
			listRef.current?.getScrollableNode() ?? null,
		);
		if (selected !== null) useChatFindStore.getState().setQuery(selected);
		input.focus();
		const frame = requestAnimationFrame(() => input.select());
		return () => cancelAnimationFrame(frame);
	}, [open, revealToken, listRef]);

	// Switching chats (or unmounting the transcript) ends the search.
	useEffect(
		() => () => {
			clearChatFindHighlights();
			useChatFindStore.getState().close();
		},
		[sessionId],
	);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			step(event.shiftKey ? -1 : 1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	};

	if (!open) return null;
	const label = uiMessage("commands:find_in_chat");
	const status =
		historyStatus !== undefined
			? uiMessage(
					historyStatus === "failed"
						? "chat:cloud_history_retry"
						: "chat:cloud_history_loading",
				)
			: normalizeChatFindQuery(tracked.query).length === 0
				? ""
				: total === 0
					? uiMessage("chat:find_in_chat_no_results")
					: uiMessage("chat:find_in_chat_count", {
							current: formatNumber(tracked.index + 1),
							total: formatNumber(total),
						});
	return (
		<search
			aria-label={label}
			data-chat-find-bar
			className={cn(
				overlaySurface,
				"absolute right-3 top-2 z-30 flex h-9 items-center gap-0.5 rounded-xl p-1 shadow-overlay-sm",
			)}
		>
			<Input
				ref={inputRef}
				unstyled
				type="text"
				value={query}
				placeholder={label}
				aria-label={label}
				autoComplete="off"
				spellCheck={false}
				className="inline-flex w-44 rounded-lg bg-foreground/4 text-xs transition-colors focus-within:bg-foreground/6"
				onChange={(event) =>
					useChatFindStore.getState().setQuery(event.target.value)
				}
				onKeyDown={onKeyDown}
			/>
			<output
				aria-live="polite"
				className={cn(
					"min-w-14 whitespace-nowrap px-1.5 text-center text-xs tabular-nums",
					total === 0 && tracked.query.length > 0
						? "text-muted-foreground/70"
						: "text-muted-foreground",
				)}
			>
				{status}
			</output>
			<Button
				aria-label={uiMessage("chat:find_in_chat_previous")}
				size="icon"
				variant="ghost"
				disabled={total === 0}
				onClick={() => step(-1)}
			>
				<HugeiconsIcon icon={ArrowUp01Icon} />
			</Button>
			<Button
				aria-label={uiMessage("chat:find_in_chat_next")}
				size="icon"
				variant="ghost"
				disabled={total === 0}
				onClick={() => step(1)}
			>
				<HugeiconsIcon icon={ArrowDown01Icon} />
			</Button>
			<Button
				aria-label={uiMessage("chat:find_in_chat_close")}
				size="icon"
				variant="ghost"
				onClick={close}
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</search>
	);
}
