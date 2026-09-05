import { Chat, ChatId, FolderId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	type ChatSwitcherChatRow,
	chatSwitcherSections,
} from "../../src/lib/chat-switcher-items.ts";
import { SETTINGS_NAVIGATION } from "../../src/lib/settings-navigation.ts";

const chatRow = (
	index: number,
	overrides: Partial<Chat> = {},
): ChatSwitcherChatRow => {
	const chat = Chat.make({
		id: ChatId.make(`chat-${index}`),
		projectId: FolderId.make("project-1"),
		title: `Conversation ${index}`,
		titleProvenance: "manual",
		worktreeId: null,
		activeSessionId: null,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt: null,
		lastReadAt: null,
		createdAt: new Date(index),
		updatedAt: new Date(index),
		...overrides,
	});
	return { kind: "chat", chat, title: chat.title, projectName: "Workspace" };
};

describe("quick open sections", () => {
	it("shows only the five most recent chats without mutating its input", () => {
		const chats = Array.from({ length: 12 }, (_, index) => chatRow(index));
		const originalOrder = [...chats];
		expect(chatSwitcherSections(chats, "")[0]?.rows).toEqual(
			chats.slice(7).reverse(),
		);
		expect(chats).toEqual(originalOrder);
	});

	it("uses last-message activity before update time and excludes archived chats", () => {
		const active = chatRow(1, { lastMessageAt: new Date(100) });
		const updated = chatRow(5);
		const archived = chatRow(200, { archivedAt: new Date() });
		expect(
			chatSwitcherSections([updated, archived, active], "")[0]?.rows,
		).toEqual([active, updated]);
		expect(chatSwitcherSections([archived], "Conversation")[0]?.rows).toEqual(
			[],
		);
	});

	it("finds older chats outside the recent limit and searches project names", () => {
		const old = chatRow(0, { title: "Release checklist" });
		const chats = [
			old,
			...Array.from({ length: 10 }, (_, index) => chatRow(index + 1)),
		];
		expect(chatSwitcherSections(chats, "Release")[0]?.rows).toEqual([old]);
		expect(chatSwitcherSections([old], "Workspace")[0]?.rows).toEqual([old]);
	});

	it("shows both matching chats and commands without requiring a prefix", () => {
		const chat = chatRow(0, { title: "Terminal fixes" });
		const sections = chatSwitcherSections([chat], "terminal");
		expect(sections[0]?.rows).toEqual([chat]);
		expect(sections[1]?.rows[0]).toMatchObject({ command: "toggle-terminal" });
	});

	it("keeps the explicit command-only mode", () => {
		const sections = chatSwitcherSections(
			[chatRow(0, { title: "Settings" })],
			" > settings ",
		);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.rows[0]).toMatchObject({
			kind: "command",
			command: "settings",
		});
		expect(sections[0]?.rows.every((row) => row.kind === "command")).toBe(true);
	});

	it("offers real quick actions and settings even with no chats", () => {
		const sections = chatSwitcherSections([], "   ");
		expect(sections.map((section) => section.label)).toEqual([
			"Recent chats",
			"Quick actions",
			"Settings",
			"Workspace",
			"Navigation",
		]);
		expect(
			sections[1]?.rows.map((row) => row.kind === "command" && row.command),
		).toEqual([
			"new-chat",
			"open-project",
			"search-files",
			"toggle-terminal",
			"new-tab",
		]);
		expect(
			sections[2]?.rows.map((row) => row.kind === "settings" && row.section),
		).toEqual(SETTINGS_NAVIGATION.map((item) => item.section));
		expect(sections[3]?.rows.length).toBeGreaterThan(1);
		expect(sections[4]?.rows.length).toBeGreaterThan(1);
	});

	it("finds settings destinations without loading the settings page", () => {
		expect(
			chatSwitcherSections([], "Keyboard shortcuts").flatMap(
				(section) => section.rows,
			),
		).toContainEqual(
			expect.objectContaining({
				kind: "settings",
				section: { kind: "shortcuts" },
			}),
		);
	});

	it("bounds chat search results and returns no matches for an unknown query", () => {
		const chats = Array.from({ length: 100 }, (_, index) => chatRow(index));
		expect(chatSwitcherSections(chats, "Conversation")[0]?.rows).toHaveLength(
			20,
		);
		expect(
			chatSwitcherSections(chats, "zzzzzzzz").flatMap(
				(section) => section.rows,
			),
		).toEqual([]);
	});
});
