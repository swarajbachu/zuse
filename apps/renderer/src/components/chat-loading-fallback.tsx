import "@zuse/i18n/english/shell";
import { useMessages } from "@zuse/i18n/react";
import type { ReactNode } from "react";
import { Spinner } from "./ui/spinner.tsx";

/** Keep loading in the chat plane, with the same quiet treatment as other empty states. */
export function ChatLoadingFallback({
	title,
	footer,
}: {
	readonly title?: string;
	readonly footer?: ReactNode;
}) {
	const { message } = useMessages(["shell"]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 items-center justify-center px-[var(--chat-row-gutter)]">
				<div className="flex min-w-0 max-w-sm flex-col items-center gap-2 text-center">
					{title ? (
						<p
							className="max-w-full truncate text-sm font-medium text-foreground/80"
							title={title}
						>
							{title}
						</p>
					) : null}
					<div
						role="status"
						aria-live="polite"
						className="flex items-center gap-2 text-xs text-muted-foreground"
					>
						<Spinner
							className="size-3.5 shrink-0"
							aria-hidden="true"
							role="presentation"
						/>
						<span>{message("shell:chat_loading_fallback_loading_chat")}</span>
					</div>
				</div>
			</div>
			{footer ? (
				<div className="mx-auto w-full max-w-[var(--chat-reading-column)] px-[var(--chat-row-gutter)] pb-4">
					{footer}
				</div>
			) : null}
		</div>
	);
}
