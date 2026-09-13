import "@zuse/i18n/english/chat";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Privacy-aware email pill. Blurs the address by default so screen recordings
 * and screenshots don't leak it; click toggles reveal/hide.
 */
export function BlurredEmail({ email }: { email: string }) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const [revealed, setRevealed] = useState(false);
	return (
		<span
			onClick={(e) => {
				e.stopPropagation();
				setRevealed((r) => !r);
			}}
			title={
				revealed
					? uiMessage("chat:blurred_email_click_to_hide")
					: uiMessage("chat:blurred_email_click_to_reveal")
			}
			aria-label={
				revealed
					? uiMessage("chat:blurred_email_hide_email")
					: uiMessage("chat:blurred_email_reveal_email")
			}
			className={cn(
				"inline-block max-w-[16rem] cursor-pointer truncate rounded bg-muted/40 px-1 py-0.5 text-left font-mono text-[11px] text-foreground transition-[filter,background-color] duration-150",
				revealed ? "" : "blur-[5px] select-none hover:blur-[3px]",
			)}
		>
			{email}
		</span>
	);
}
