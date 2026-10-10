import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { useMessages } from "@zuse/i18n/react";
import {
	CommentAdd01Icon,
	Copy01Icon,
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
import { copyText } from "~/lib/platform-capabilities";
import { cn } from "~/lib/utils";
import { useAnnotationsStore } from "~/store/annotations";
import {
	DraftReviewAnnotation,
	useAnnotationAuthor,
} from "./review-annotation.tsx";
import { Button } from "./ui/button.tsx";
import { overlayPanelSurface } from "./ui/overlay-surface.ts";
import { toastManager } from "./ui/toast.tsx";

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

/**
 * Floating actions for text selected anywhere in a chat transcript —
 * assistant replies, the user's own messages, and generated UI. Annotate pins
 * a note to the quote using the same draft card as file annotations; it
 * travels with the next message like code and browser annotations.
 */
export function ChatSelectionMenu({
	rootRef,
	sessionRef,
}: {
	readonly rootRef: RefObject<HTMLElement | null>;
	readonly sessionRef: SessionRef;
}) {
	const { message: uiMessage } = useMessages(["chat", "common"]);
	const author = useAnnotationAuthor();
	const [selection, setSelection] = useState<ChatSelection | null>(null);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const [annotating, setAnnotating] = useState(false);
	const [copied, setCopied] = useState(false);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const annotatingRef = useRef(annotating);
	annotatingRef.current = annotating;
	const menuRef = useRef<HTMLElement | null>(null);

	const close = useCallback(() => {
		setSelection(null);
		setAnnotating(false);
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
			// While annotating, the draft card owns Escape (it confirms discards).
			if (
				event.key === "Escape" &&
				selectionRef.current !== null &&
				!annotatingRef.current
			)
				close();
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
	const save = (comment: string) => {
		useAnnotationsStore.getState().addChat(sessionRef.sessionId, {
			messageId: selection.messageId,
			source: selection.source,
			quote: selection.quote,
			comment,
		});
		finish();
		return Promise.resolve(true);
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
			<div
				ref={(node) => {
					menuRef.current = node;
				}}
				className="fixed z-50 w-[22rem]"
				style={style}
			>
				<DraftReviewAnnotation
					author={author}
					aiDisabledReason={null}
					githubEnabled={false}
					error={null}
					onCancel={close}
					onSave={save}
				/>
			</div>
		) : (
			<div
				ref={(node) => {
					menuRef.current = node;
				}}
				role="toolbar"
				aria-label={uiMessage("chat:selection_menu_label")}
				className={cn(
					overlayPanelSurface,
					"fixed z-50 flex items-center gap-0.5 rounded-lg p-0.5",
				)}
				style={style}
				// Keep the text selected while choosing an action.
				onMouseDown={(event) => event.preventDefault()}
			>
				<Button
					variant="ghost"
					className="h-7 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground"
					onClick={() => setAnnotating(true)}
				>
					<HugeiconsIcon icon={CommentAdd01Icon} aria-hidden="true" />
					{uiMessage("chat:selection_menu_annotate")}
				</Button>
				<Button
					variant="ghost"
					className="h-7 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground"
					onClick={() => {
						copyText(selection.text).then(
							() => setCopied(true),
							() =>
								toastManager.add({
									type: "error",
									title: uiMessage("common:copy_failed"),
								}),
						);
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
