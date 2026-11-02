import type { SessionId } from "@zuse/contracts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { type MainTab, useUiStore } from "../store/ui.ts";
import { requestReviewLeave } from "./review-edit-guard.ts";
import { currentSelectedEnvironmentId } from "./selected-environment.ts";

const reviewTabScope = (
	environmentId: string,
	chatId: string | null,
	sessionId: string | null,
): string => JSON.stringify([environmentId, chatId, sessionId]);

export const currentReviewTabScope = (): string =>
	reviewTabScope(
		currentSelectedEnvironmentId(),
		useChatsStore.getState().selectedChatId,
		useSessionsStore.getState().selectedSessionId,
	);

const scopedMainTab = (
	state: { activeMainTab: MainTab; reviewTabScope: string | null },
	scope: string,
): MainTab =>
	state.activeMainTab === "changes" && state.reviewTabScope !== scope
		? "chat"
		: state.activeMainTab;

export const useReviewTabState = (environmentId: string) => {
	const chatId = useChatsStore((s) => s.selectedChatId);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const scope = reviewTabScope(environmentId, chatId, sessionId);
	const changesTabOpen = useUiStore(
		(s) => s.changesTabOpen && s.reviewTabScope === scope,
	);
	const activeMainTab = useUiStore((s) => scopedMainTab(s, scope));
	return { changesTabOpen, activeMainTab };
};

/** Guard before mutating selection so a canceled leave keeps the mounted draft. */
export const selectReviewChatTab = (sessionId: SessionId | null): void => {
	const ui = useUiStore.getState();
	const sameSession =
		useSessionsStore.getState().selectedSessionId === sessionId;
	const effectiveTab = scopedMainTab(ui, currentReviewTabScope());
	if (sameSession && effectiveTab === "chat") return;
	const select = () => {
		if (!sameSession) useSessionsStore.getState().select(sessionId);
		// A chat already visible in another scope must not change the owner's tab.
		if (effectiveTab !== "chat") useUiStore.setState({ activeMainTab: "chat" });
	};
	if (effectiveTab === "changes") requestReviewLeave(select);
	else select();
};
