import type { ChatRef } from "@zuse/client-runtime/resource-ref";

import { toastManager } from "../components/ui/toast.tsx";
import type { TerminalInstance } from "../store/terminals.ts";
import { restoreOrAddRightTerminal } from "./right-terminal-controller.ts";

/**
 * Spawn a command-bound terminal (e.g. the project's Run script) and surface
 * it in the owning chat's right dock. The shared right-terminal controller
 * first reconciles the authoritative server catalog and owner limit; only then
 * does it append and pin the fresh command instance to its exact list index.
 *
 * Terminals are scoped per chat, so the caller passes the chat that should own
 * the run (the active chat for the top-bar Run button, or the worktree's chat
 * for auto-run after setup). A Run action never adopts an unrelated restored
 * shell, and a catalog/cap failure remains visible as a retryable toast instead
 * of producing a doomed local slot.
 */
export async function openTerminalCommand(args: {
	readonly chatRef: ChatRef;
	readonly cwd: string;
	readonly title: string;
	readonly command: NonNullable<TerminalInstance["command"]>;
}): Promise<boolean> {
	const result = await restoreOrAddRightTerminal({
		ref: args.chatRef,
		environmentId: args.chatRef.environmentId,
		cwd: args.cwd,
		title: args.title,
		command: args.command,
		reuseRestored: false,
	});
	if (result.status === "ready") return true;
	if (result.status === "failed") {
		toastManager.add({
			type: "error",
			title: `Could not open ${args.title} terminal`,
			description:
				result.cause instanceof Error
					? result.cause.message
					: String(result.cause),
		});
	}
	return false;
}
