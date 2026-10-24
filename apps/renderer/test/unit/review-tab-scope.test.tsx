import { ChatId, EnvironmentId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MainTabs } from "../../src/components/main-tabs.tsx";
import { useChatsStore } from "../../src/store/chats.ts";
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
