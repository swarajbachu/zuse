import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import {
	ChatId,
	CloudChatSummary,
	CommandId,
	EnvironmentId,
	Message,
	MessageId,
	SessionId,
	type SessionTimelineProjection,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CloudMailboxQueue } from "../../src/components/composer/cloud-mailbox-queue.tsx";
import { useCloudMessageQueue } from "../../src/lib/cloud-message-queue.ts";
import { useCloudChatCatalogStore } from "../../src/lib/cloud-workspace-catalog.ts";
import { isCloudWorkspaceEnvironment } from "../../src/lib/rpc-client.ts";
import type { RendererSessionTimeline } from "../../src/lib/session-timeline-hooks.ts";

const initialCatalog = useCloudChatCatalogStore.getState();
afterEach(() => useCloudChatCatalogStore.setState(initialCatalog));
it.each([
	"box",
	"e2b",
])("queues a cold %s send before connection registration and mailbox status", (providerId) => {
	const workspaceId = `unattached-${providerId}`;
	const sessionId = SessionId.make("session");
	useCloudChatCatalogStore.setState({
		summaries: [
			CloudChatSummary.make({
				workspaceId,
				projectId: "project",
				repositoryIdentity: "github.com/zuse/zuse",
				repositoryDisplayName: "zuse",
				chatId: ChatId.make("chat"),
				initialSessionId: sessionId,
				title: "chat",
				branch: "cloud",
				providerId,
				agent: "codex",
				model: "gpt-5.6-sol",
				state: "paused",
				desiredState: "paused",
				runtimeState: "offline",
				statusCode: "paused",
				startupPhase: "running",
				revision: 1,
				summaryRevision: 1,
				sessionHeadVersion: 1,
				unread: false,
				lastMessageAt: 1,
				createdAt: 1,
				updatedAt: 1,
			}),
		],
	});
	expect(isCloudWorkspaceEnvironment(workspaceId)).toBe(false);
	const prompt = Message.make({
		id: MessageId.make("pending"),
		sessionId,
		role: "user",
		content: { _tag: "user", text: "Wait for cloud", goal: false },
		createdAt: new Date(),
	});
	const timeline: RendererSessionTimeline = {
		ref: { environmentId: EnvironmentId.make(workspaceId), sessionId },
		projection: null,
		messages: [prompt],
		runtime: "starting",
		view: {
			...emptyResourceView<SessionTimelineProjection>(),
			pendingCommands: [
				{
					commandId: CommandId.make("message-send:pending"),
					kind: "messages.send",
					submittedAt: 1,
				},
			],
		},
	};
	function Surface() {
		const result = useCloudMessageQueue(timeline);
		expect(result.transcript).toEqual([]);
		expect(result.waiting).toEqual([prompt]);
		return (
			<CloudMailboxQueue
				messages={result.waiting}
				commands={timeline.view.pendingCommands}
				waitingForCloud
			/>
		);
	}
	const html = renderToStaticMarkup(<Surface />);
	expect(html).toContain("Waiting for cloud to start");
	expect(html).toContain("Wait for cloud");
});
