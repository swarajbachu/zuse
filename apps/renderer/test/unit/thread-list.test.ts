import { Chat, ChatId, type CloudChatSummary, FolderId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import type { LogicalChatRef } from "../../src/lib/project-groups.ts";
import { buildThreadList } from "../../src/lib/thread-list.ts";

const chat = (
	id: string,
	projectId: string,
	createdAt: number,
	overrides: Partial<Chat> = {},
) =>
	Chat.make({
		id: ChatId.make(id),
		projectId: FolderId.make(projectId),
		title: id,
		titleProvenance: "manual",
		worktreeId: null,
		activeSessionId: null,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt: null,
		lastReadAt: null,
		createdAt: new Date(createdAt),
		updatedAt: new Date(createdAt),
		...overrides,
	});

// Only the fields the thread list reads; the rest of the summary is irrelevant.
const cloud = (
	chatId: string,
	createdAt: number,
	overrides: Partial<CloudChatSummary> = {},
) =>
	({
		chatId: ChatId.make(chatId),
		createdAt,
		lastUserMessageAt: null,
		state: "ready",
		desiredState: "ready",
		repositoryIdentity: "github.com/acme/web",
		...overrides,
	}) as unknown as CloudChatSummary;

const remote = (chatValue: Chat, environmentId = "laptop") => ({
	ref: {
		chat: chatValue,
		environmentId,
		environmentLabel: "Laptop",
		remote: true,
		live: false,
	} as unknown as LogicalChatRef,
	connected: true,
	repositoryName: "web",
});

const folders = [
	{ id: FolderId.make("web"), name: "web", path: "/code/web" },
	{ id: FolderId.make("api"), name: "api", path: "/code/api" },
];

const ids = (entries: ReturnType<typeof buildThreadList>) =>
	entries.map((entry) => `${entry.kind}:${entry.id}`);

describe("buildThreadList", () => {
	it("merges every project's chats, newest user activity first", () => {
		const list = buildThreadList({
			chatsByProject: {
				web: [chat("web-old", "web", 1), chat("web-new", "web", 30)],
				api: [
					chat("api-mid", "api", 10),
					chat("api-active", "api", 2, { lastUserMessageAt: new Date(40) }),
				],
			},
			folders,
		});

		expect(ids(list)).toEqual([
			"local:api-active",
			"local:web-new",
			"local:api-mid",
			"local:web-old",
		]);
		expect(list[0]).toMatchObject({
			projectName: "api",
			projectRoot: "/code/api",
		});
	});

	it("interleaves chats from other computers and the cloud by recency", () => {
		const list = buildThreadList({
			chatsByProject: { web: [chat("here", "web", 20)] },
			folders,
			remoteChats: [remote(chat("there", "web", 30))],
			cloudChats: [cloud("cloud", 25)],
		});

		expect(ids(list)).toEqual([
			"remote:laptop:there",
			"cloud:cloud",
			"local:here",
		]);
	});

	it("renders a cloud-backed local chat once, as its cloud row", () => {
		const list = buildThreadList({
			chatsByProject: { web: [chat("shared", "web", 5)] },
			folders,
			cloudChats: [cloud("shared", 5)],
		});

		expect(ids(list)).toEqual(["cloud:shared"]);
	});

	it("skips archived, hidden, and orphan chats", () => {
		const list = buildThreadList({
			chatsByProject: {
				web: [
					chat("kept", "web", 1),
					chat("archived", "web", 2, { archivedAt: new Date(3) }),
					chat("hidden", "web", 4),
				],
				orphan: [chat("orphan", "orphan", 5)],
			},
			folders,
			remoteChats: [
				remote(chat("remote-archived", "web", 6, { archivedAt: new Date(7) })),
			],
			cloudChats: [
				cloud("cloud-archived", 8, { archivedAt: 9 }),
				cloud("cloud-deleted", 8, { state: "deleted" }),
				cloud("cloud-archiving", 8, { desiredState: "archived" }),
			],
			hiddenChatIds: new Set(["hidden"]),
		});

		expect(ids(list)).toEqual(["local:kept"]);
	});

	it("breaks recency ties by id so rows stay stable during updates", () => {
		const list = buildThreadList({
			chatsByProject: { web: [chat("b", "web", 5), chat("a", "web", 5)] },
			folders,
		});

		expect(ids(list)).toEqual(["local:a", "local:b"]);
	});
});
