import { cloudSessionPlaceholder } from "@zuse/client-runtime/cloud-catalog";
import { ChatId, CloudChatSummary, FolderId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { selectChatSurface } from "../../src/lib/chat-surface-selection.ts";
import { resolveCloudSession } from "../../src/lib/cloud-session-selection.ts";
import { cloudSummaryActiveSessionId } from "../../src/lib/cloud-workspace-catalog.ts";
import type { EnvironmentShellData } from "../../src/lib/environment-shell-client-bus.ts";

const summary = (providerId: string) =>
	CloudChatSummary.make({
		workspaceId: "workspace",
		projectId: "api-project",
		repositoryIdentity: "github.com/zuse/zuse",
		repositoryDisplayName: "zuse",
		chatId: ChatId.make("chat"),
		initialSessionId: SessionId.make("initial"),
		activeSessionId: null,
		title: "Cloud chat",
		branch: "cloud",
		providerId,
		agent: "codex",
		model: "gpt-5.6-sol",
		state: "ready",
		desiredState: "ready",
		runtimeState: "online",
		statusCode: "agent-running",
		startupPhase: "running",
		revision: 10,
		summaryRevision: 2,
		sessionHeadVersion: 0,
		unread: false,
		lastMessageAt: 1,
		createdAt: 1,
		updatedAt: 2,
	});
const folderId = FolderId.make("runtime-project");
const shellWith = (
	sessions: EnvironmentShellData["sessionsByProject"][string],
): EnvironmentShellData => ({
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: { [folderId]: sessions },
	creationOperationsByProject: {},
});

describe("cloud chat session recovery", () => {
	it.each([
		"box",
		"e2b",
	])("opens a retained %s session when the catalog active session is null", (provider) => {
		const cloud = summary(provider);
		const session = cloudSessionPlaceholder(cloud, folderId);
		const resolved = resolveCloudSession(cloud, shellWith([session]), null);
		expect(resolved).toBe(session);
		expect(
			selectChatSurface({
				hasSession: resolved !== null,
				hasPendingCreation: false,
				hasCloudSelection: true,
			}),
		).toBe("session");
	});
	it("keeps a cloud surface while the runtime shell has not hydrated", () => {
		expect(resolveCloudSession(summary("box"), null, null)).toBeNull();
		expect(
			selectChatSurface({
				hasSession: false,
				hasPendingCreation: false,
				hasCloudSelection: true,
			}),
		).toBe("cloud-pending");
		expect(
			selectChatSurface({ hasSession: false, hasPendingCreation: false }),
		).toBe("landing");
	});
	it("does not reopen archived sessions or select another chat's session", () => {
		const cloud = summary("box");
		const session = cloudSessionPlaceholder(cloud, folderId);
		expect(
			resolveCloudSession(
				cloud,
				shellWith([
					{ ...session, archivedAt: new Date() },
					{
						...session,
						id: SessionId.make("other-session"),
						chatId: ChatId.make("other-chat"),
					},
				]),
				session.id,
			),
		).toBeNull();
	});
	it("preserves a selected secondary session when the catalog head is missing", () => {
		const cloud = summary("box");
		const initial = cloudSessionPlaceholder(cloud, folderId);
		const secondary = { ...initial, id: SessionId.make("secondary") };
		expect(
			resolveCloudSession(cloud, shellWith([initial, secondary]), secondary.id),
		).toBe(secondary);
	});
});

describe("cloud transcript session before runtime publication", () => {
	it.each([
		"box",
		"e2b",
	])("reads the original %s session without waking its runtime", (provider) => {
		const cloud = {
			...summary(provider),
			summaryRevision: 0,
			activeSessionId: null,
		};
		expect(cloudSummaryActiveSessionId(cloud)).toBe(cloud.initialSessionId);
	});
	it("respects a published empty session after archiving", () => {
		expect(cloudSummaryActiveSessionId(summary("box"))).toBeNull();
	});
	it("preserves a published replacement session", () => {
		const id = SessionId.make("replacement");
		expect(
			cloudSummaryActiveSessionId({ ...summary("box"), activeSessionId: id }),
		).toBe(id);
	});
});
