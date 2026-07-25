import type {
	BrowserCommandRequest,
	ChatId,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import {
	browserChatIdForSession,
	registerBrowserController,
	waitForBrowserController,
} from "../../src/lib/browser-controller-registry.ts";

const chatA = "chat-a" as ChatId;
const chatB = "chat-b" as ChatId;
const sessionA = "session-a" as SessionId;
const sessionB = "session-b" as SessionId;
const projectId = "project" as FolderId;

const session = (id: SessionId, chatId: ChatId): Session =>
	({ id, chatId, projectId }) as Session;

describe("browser controller routing", () => {
	it("resolves a browser request to the session's owning chat", () => {
		const sessions = {
			[projectId]: [session(sessionA, chatA), session(sessionB, chatB)],
		};

		expect(browserChatIdForSession(sessions, sessionB)).toBe(chatB);
		expect(
			browserChatIdForSession(sessions, "missing" as SessionId),
		).toBeNull();
	});

	it("returns only the controller registered for the requested chat", async () => {
		const controllerA = vi.fn(async (_request: BrowserCommandRequest) => {});
		const controllerB = vi.fn(async (_request: BrowserCommandRequest) => {});
		const unregisterA = registerBrowserController(chatA, controllerA);
		const unregisterB = registerBrowserController(chatB, controllerB);

		expect(await waitForBrowserController(chatB)).toBe(controllerB);
		expect(await waitForBrowserController(chatA)).toBe(controllerA);

		unregisterA();
		unregisterB();
	});

	it("wakes a pending request when its chat controller mounts", async () => {
		const pending = waitForBrowserController(chatB, 100);
		const controller = vi.fn(async (_request: BrowserCommandRequest) => {});
		const unregister = registerBrowserController(chatB, controller);

		expect(await pending).toBe(controller);
		unregister();
	});
});
