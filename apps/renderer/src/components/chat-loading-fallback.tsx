import "@zuse/i18n/english/shell";
import { useMessages } from "@zuse/i18n/react";
import type { ReactNode } from "react";
import { Spinner } from "./ui/spinner.tsx";

/** Quiet loading row in the transcript column; never repeat the chat title. */
export function ChatLoadingFallback({
	footer,
}: {
	readonly footer?: ReactNode;
}) {
	const { message } = useMessages(["shell"]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="mx-auto w-full max-w-[var(--chat-reading-column)] px-[var(--chat-row-gutter)] pt-5">
				<div
					role="status"
					aria-live="polite"
					className="flex items-center gap-2 text-xs text-muted-foreground"
				>
					<Spinner
						className="size-3.5 shrink-0 motion-reduce:animate-none"
						aria-hidden="true"
						role="presentation"
					/>
					<span>{message("shell:chat_loading_fallback_loading_chat")}</span>
				</div>
			</div>
			<div className="flex-1" />
			{footer ? (
				<div className="mx-auto w-full max-w-[var(--chat-reading-column)] px-[var(--chat-row-gutter)] pb-4">
					{footer}
				</div>
			) : null}
		</div>
	);
}
