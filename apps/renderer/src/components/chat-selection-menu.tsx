import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import {
	CommentAdd01Icon,
	Copy01Icon,
	LeftToRightBlockQuoteIcon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { type ChatSelection, readChatSelection } from "~/lib/chat-selection";
import { insertIntoCurrentComposer } from "~/lib/context-handoff";
import { isInputComposing } from "~/lib/input-composition";
import { copyText } from "~/lib/platform-capabilities";
import { cn } from "~/lib/utils";
import { useAnnotationsStore } from "~/store/annotations";
import { Button } from "./ui/button.tsx";
import { overlayPanelSurface } from "./ui/overlay-surface.ts";
import { Textarea } from "./ui/textarea.tsx";

const HIGHLIGHT_NAME = "chat-annotation";
/** Keep the floating menu this far from the viewport edges. */
const EDGE = 12;

/** Selected text being annotated stays painted after focus moves to the note. */
const useSelectionHighlight = (range: Range | null) => {
	useEffect(() => {
		if (range === null || typeof Highlight === "undefined" || !CSS.highlights)
			return;
		CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
		return () => {
			CSS.highlights.delete(HIGHLIGHT_NAME);
		};
	}, [range]);
};

const quoteMarkdown = (text: string) =>
	`${text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n")}\n\n`;

/**
 * Floating actions for text selected anywhere in a chat transcript —
 * assistant replies, the user's own messages, and generated UI. Annotate pins
 * a note to the quote; it travels with the next message like code and browser
 * annotations. Quote inserts the text into the composer; Copy copies it.
 */
export function ChatSelectionMenu({
	rootRef,
	sessionRef,
}: {
	readonly rootRef: RefObject<HTMLElement | null>;
	readonly sessionRef: SessionRef;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	const [selection, setSelection] = useState<ChatSelection | null>(null);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const [annotating, setAnnotating] = useState(false);
	const [note, setNote] = useState("");
	const [copied, setCopied] = useState(false);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const annotatingRef = useRef(annotating);
	annotatingRef.current = annotating;
	const menuRef = useRef<HTMLElement | null>(null);

	const close = useCallback(() => {
		setSelection(null);
		setAnnotating(false);
		setNote("");
		setCopied(false);
	}, []);

	useEffect(() => {
		let frame = 0;
		const read = (event: Event) => {
			// Choosing an action must not re-read (and reset) the selection.
			if (
				event.target instanceof Node &&
				menuRef.current?.contains(event.target)
			)
				return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const root = rootRef.current;
				if (root === null || annotatingRef.current) return;
				const next = readChatSelection(document.getSelection(), root);
				setSelection(next);
				setRect(next?.range.getBoundingClientRect() ?? null);
				setCopied(false);
			});
		};
		const onSelectionChange = () => {
			if (annotatingRef.current) return;
			if (document.getSelection()?.isCollapsed !== false) setSelection(null);
		};
		const onScroll = () => {
			const current = selectionRef.current;
			if (current === null) return;
			const next = current.range.getBoundingClientRect();
			// Virtualized rows unmount offscreen; a detached range has no box.
			if (next.width === 0 && next.height === 0) {
				if (!annotatingRef.current) setSelection(null);
				return;
			}
			setRect(next);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && selectionRef.current !== null) close();
		};
		document.addEventListener("pointerup", read);
		document.addEventListener("keyup", read);
		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointerup", read);
			document.removeEventListener("keyup", read);
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [close, rootRef]);

	useSelectionHighlight(annotating ? (selection?.range ?? null) : null);

	if (selection === null || rect === null) return null;

	const finish = () => {
		document.getSelection()?.removeAllRanges();
		close();
	};
	const save = () => {
		const comment = note.trim();
		if (comment.length === 0) return;
		useAnnotationsStore.getState().addChat(sessionRef.sessionId, {
			messageId: selection.messageId,
			source: selection.source,
			quote: selection.quote,
			comment,
		});
		finish();
	};

	const above = rect.top > 96;
	const style = {
		left: Math.min(
			Math.max(rect.left + rect.width / 2, EDGE + 160),
			window.innerWidth - EDGE - 160,
		),
		top: above ? rect.top - 8 : rect.bottom + 8,
		transform: `translate(-50%, ${above ? "-100%" : "0"})`,
	};

	return createPortal(
		annotating ? (
			<form
				ref={(node) => {
					menuRef.current = node;
				}}
				className={cn(
					overlayPanelSurface,
					"fixed z-50 flex w-80 flex-col gap-2 rounded-xl p-2",
				)}
				style={style}
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}
			>
				<p className="line-clamp-2 px-0.5 text-[11px] text-muted-foreground italic">
					{selection.quote}
				</p>
				<Textarea
					size="sm"
					value={note}
					placeholder={uiMessage("chat:selection_menu_note_placeholder")}
					aria-label={uiMessage("chat:selection_menu_annotate")}
					onChange={(event) => setNote(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (isInputComposing(event)) return;
						if (event.key === "Escape") {
							event.preventDefault();
							close();
						} else if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							save();
						}
					}}
					autoFocus
				/>
				<div className="flex justify-end gap-1.5">
					<Button type="button" variant="ghost" className="h-7" onClick={close}>
						{uiMessage("chat:selection_menu_cancel")}
					</Button>
					<Button
						type="submit"
						className="h-7"
						disabled={note.trim().length === 0}
					>
						{uiMessage("chat:selection_menu_add_note")}
					</Button>
				</div>
			</form>
		) : (
			<div
				ref={(node) => {
					menuRef.current = node;
				}}
				role="toolbar"
				aria-label={uiMessage("chat:selection_menu_label")}
				className={cn(
					overlayPanelSurface,
					"fixed z-50 flex items-center gap-0.5 rounded-xl p-1",
				)}
				style={style}
				// Keep the text selected while choosing an action.
				onMouseDown={(event) => event.preventDefault()}
			>
				<Button
					variant="ghost"
					className="h-7 px-2"
					onClick={() => setAnnotating(true)}
				>
					<HugeiconsIcon icon={CommentAdd01Icon} aria-hidden="true" />
					{uiMessage("chat:selection_menu_annotate")}
				</Button>
				<Button
					variant="ghost"
					className="h-7 px-2"
					onClick={() => {
						insertIntoCurrentComposer(
							quoteMarkdown(selection.quote),
							sessionRef,
						);
						finish();
					}}
				>
					<HugeiconsIcon icon={LeftToRightBlockQuoteIcon} aria-hidden="true" />
					{uiMessage("chat:selection_menu_quote")}
				</Button>
				<Button
					variant="ghost"
					className="h-7 px-2"
					onClick={() => {
						void copyText(selection.quote).then(() => setCopied(true));
					}}
				>
					<HugeiconsIcon
						icon={copied ? Tick01Icon : Copy01Icon}
						aria-hidden="true"
					/>
					{uiMessage(
						copied ? "chat:selection_menu_copied" : "chat:selection_menu_copy",
					)}
				</Button>
			</div>
		),
		document.body,
	);
}
