import { Chat, ChatId, FolderId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
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

const folders = [
	{ id: FolderId.make("web"), name: "web", path: "/code/web" },
	{ id: FolderId.make("api"), name: "api", path: "/code/api" },
];

describe("buildThreadList", () => {
	it("merges every project's chats, newest user activity first", () => {
		const list = buildThreadList(
			{
				web: [chat("web-old", "web", 1), chat("web-new", "web", 30)],
				api: [
					chat("api-mid", "api", 10),
					chat("api-active", "api", 2, { lastUserMessageAt: new Date(40) }),
				],
			},
			folders,
		);

		expect(list.map((entry) => entry.chat.id)).toEqual([
			"api-active",
			"web-new",
			"api-mid",
			"web-old",
		]);
		expect(list[0]).toMatchObject({
			projectName: "api",
			projectRoot: "/code/api",
		});
	});

	it("skips archived chats and chats outside the sidebar's projects", () => {
		const list = buildThreadList(
			{
				web: [
					chat("kept", "web", 1),
					chat("archived", "web", 2, { archivedAt: new Date(3) }),
				],
				hidden: [chat("orphan", "hidden", 5)],
			},
			folders,
		);

		expect(list.map((entry) => entry.chat.id)).toEqual(["kept"]);
	});

	it("breaks recency ties by id so rows stay stable during updates", () => {
		const list = buildThreadList(
			{ web: [chat("b", "web", 5), chat("a", "web", 5)] },
			folders,
		);

		expect(list.map((entry) => entry.chat.id)).toEqual(["a", "b"]);
	});
});
