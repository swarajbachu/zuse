import type {
	ChatDirectoryStatus,
	ChatId,
	EnvironmentId,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { useEffect, useState } from "react";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";

/** Foreground-only availability probe for the selected conversation directory. */
export function useChatDirectoryStatus(
	environmentId: EnvironmentId,
	chatId: ChatId | null,
) {
	const [status, setStatus] = useState<ChatDirectoryStatus | null>(null);

	useEffect(() => {
		setStatus(null);
		if (chatId === null) return;
		let cancelled = false;
		let inFlight = false;
		let timer: number | null = null;
		const schedule = () => {
			if (!cancelled) timer = window.setTimeout(poll, 2_000);
		};
		const refresh = async () => {
			if (cancelled || inFlight) return;
			inFlight = true;
			try {
				const { result: next } = await dispatchEnvironmentShellCommand<
					{ readonly chatId: ChatId },
					ChatDirectoryStatus
				>({
					environmentId,
					kind: "chat.directoryStatus",
					commandId: CommandId.make(`chat-directory:${crypto.randomUUID()}`),
					payload: { chatId },
				});
				if (!cancelled) setStatus(next);
			} catch {
				// Existing data remains usable during a transient transport failure.
			} finally {
				inFlight = false;
				schedule();
			}
		};
		const poll = () => {
			if (document.visibilityState === "visible") void refresh();
			else schedule();
		};
		void refresh();
		window.addEventListener("focus", refresh);
		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [chatId, environmentId]);

	return status;
}
