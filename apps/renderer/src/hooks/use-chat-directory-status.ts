import type { ChatDirectoryStatus, ChatId } from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import {
	getRpcClient,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";

/** Foreground-only availability probe for the selected conversation directory. */
export function useChatDirectoryStatus(chatId: ChatId | null) {
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
				const client = await getRpcClient();
				const next = await Effect.runPromise(
					client["chat.directoryStatus"]({ chatId }),
				);
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
		const unsubscribe = subscribeRendererRpcConnection((snapshot) => {
			if (snapshot.status === "connected") void refresh();
		});
		void refresh();
		window.addEventListener("focus", refresh);
		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			unsubscribe();
			window.removeEventListener("focus", refresh);
		};
	}, [chatId]);

	return status;
}
