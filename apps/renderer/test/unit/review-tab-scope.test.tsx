import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	EnvironmentId,
	SessionId,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { MainTabs } from "../../src/components/main-tabs.tsx";
import { useCloudChatCatalogStore } from "../../src/lib/cloud-workspace-catalog.ts";
import { configureReviewEditGuard } from "../../src/lib/review-edit-guard.ts";
import { selectReviewChatTab } from "../../src/lib/review-tab-scope.ts";
import { useSelectedEnvironmentId } from "../../src/lib/selected-environment.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useUiStore } from "../../src/store/ui.ts";

it("keeps Review in the originating chat and session", () => {
	const chat = ChatId.make("review-chat");
	const session = SessionId.make("review-session");
	useChatsStore.setState({ selectedChatId: chat });
	useSessionsStore.setState({ selectedSessionId: session });
	useUiStore.getState().openChanges();
	const tabs = (environmentId = "local") =>
		renderToStaticMarkup(
			<MainTabs
				environmentId={EnvironmentId.make(environmentId)}
				projectId={null}
				emptyLabel="New chat"
			/>,
		);
	expect(tabs()).toContain("Close review");
	expect(tabs("other-environment")).not.toContain("Close review");
	useChatsStore.setState({ selectedChatId: ChatId.make("other-chat") });
	expect(tabs()).not.toContain("Close review");
	useChatsStore.setState({ selectedChatId: chat });
	useSessionsStore.setState({ selectedSessionId: SessionId.make("new-pane") });
	expect(tabs()).not.toContain("Close review");
	useSessionsStore.setState({ selectedSessionId: session });
	expect(tabs()).toContain("Close review");
	useChatsStore.setState({ selectedChatId: null });
	useSessionsStore.setState({ selectedSessionId: null });
	expect(tabs()).not.toContain("Close review");
});

it("does not change the session or Review when leaving is canceled", () => {
	const session = SessionId.make("draft-session");
	useSessionsStore.setState({ selectedSessionId: session });
	useUiStore.getState().openChanges();
	configureReviewEditGuard(true, null);
	vi.stubGlobal("window", { confirm: vi.fn(() => false) });
	selectReviewChatTab(SessionId.make("next-session"));
	expect(useSessionsStore.getState().selectedSessionId).toBe(session);
	expect(useUiStore.getState().activeMainTab).toBe("changes");
});

it("does not leave the originating Review when the effective chat is already selected", () => {
	useSessionsStore.setState({ selectedSessionId: SessionId.make("origin") });
	useUiStore.getState().openChanges();
	const next = SessionId.make("visible-chat");
	useSessionsStore.setState({ selectedSessionId: next });
	configureReviewEditGuard(true, null);
	const confirm = vi.fn(() => false);
	vi.stubGlobal("window", { confirm });
	selectReviewChatTab(next);
	expect(confirm).not.toHaveBeenCalled();
	expect(useUiStore.getState().activeMainTab).toBe("changes");
});

afterEach(() => {
	configureReviewEditGuard(false, null);
	vi.unstubAllGlobals();
	useCloudChatCatalogStore.setState({ summaries: [] });
	useEnvironmentCatalogStore.setState({ activeEnvironmentId: "local" });
});

it.each([
	true,
	false,
])("waits for saving before selecting another session (save succeeds: %s)", async (saved) => {
	const origin = SessionId.make("saving-origin");
	const target = SessionId.make("saving-target");
	useSessionsStore.setState({ selectedSessionId: origin });
	useUiStore.getState().openChanges();
	let complete!: (saved: boolean) => void;
	configureReviewEditGuard(
		true,
		() =>
			new Promise<boolean>((resolve) => {
				complete = resolve;
			}),
	);
	vi.stubGlobal("window", { confirm: vi.fn(() => true) });
	selectReviewChatTab(target);
	expect(useSessionsStore.getState().selectedSessionId).toBe(origin);
	complete(saved);
	await Promise.resolve();
	expect(useSessionsStore.getState().selectedSessionId).toBe(
		saved ? target : origin,
	);
	expect(useUiStore.getState().activeMainTab).toBe(saved ? "chat" : "changes");
});

it("selects another session after explicit discard", () => {
	useSessionsStore.setState({
		selectedSessionId: SessionId.make("discard-origin"),
	});
	useUiStore.getState().openChanges();
	configureReviewEditGuard(true, null);
	vi.stubGlobal("window", {
		confirm: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
	});
	const target = SessionId.make("discard-target");
	selectReviewChatTab(target);
	expect(useSessionsStore.getState().selectedSessionId).toBe(target);
	expect(useUiStore.getState().activeMainTab).toBe("chat");
});

it("uses the selected cloud environment before RPC activation completes", () => {
	const chatId = ChatId.make("selected-cloud-chat");
	const sessionId = SessionId.make("selected-cloud-session");
	useEnvironmentCatalogStore.setState({
		activeEnvironmentId: "previous-environment",
	});
	useCloudChatCatalogStore.setState({
		summaries: [
			CloudChatSummary.make({
				workspaceId: "selected-cloud",
				projectId: "project-cloud",
				repositoryIdentity: "github.com/example/repository",
				repositoryDisplayName: "repository",
				chatId,
				initialSessionId: AgentSessionId.make(sessionId),
				title: "Cloud chat",
				branch: "task",
				providerId: "provider-cloud",
				agent: "codex",
				model: "default",
				state: "paused",
				desiredState: "paused",
				runtimeState: "offline",
				statusCode: "paused",
				startupPhase: "running",
				revision: 1,
				unread: false,
				lastMessageAt: 1,
				createdAt: 1,
				updatedAt: 1,
			}),
		],
	});
	useChatsStore.setState({ selectedChatId: chatId });
	useSessionsStore.setState({ selectedSessionId: sessionId });
	useUiStore.getState().openChanges();
	const Scope = () => (
		<MainTabs
			environmentId={useSelectedEnvironmentId()}
			projectId={null}
			emptyLabel="Cloud chat"
		/>
	);
	expect(renderToStaticMarkup(<Scope />)).toContain("Close review");
	expect(JSON.parse(useUiStore.getState().reviewTabScope ?? "null")[0]).toBe(
		"selected-cloud",
	);
});
