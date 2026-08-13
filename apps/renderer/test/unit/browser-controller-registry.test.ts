import {
	type BrowserCommandRequest,
	type ChatId,
	EnvironmentId,
	type FolderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import {
	browserChatIdForSession,
	registerBrowserController,
	waitForBrowserController,
} from "../../src/lib/browser-controller-registry.ts";

const chatA = "chat-a" as ChatId;
const chatB = "chat-b" as ChatId;
const environmentId = EnvironmentId.make("computer-a");
const refA = { environmentId, chatId: chatA };
const refB = { environmentId, chatId: chatB };
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
		const unregisterA = registerBrowserController(refA, controllerA);
		const unregisterB = registerBrowserController(refB, controllerB);

		expect(await waitForBrowserController(refB)).toBe(controllerB);
		expect(await waitForBrowserController(refA)).toBe(controllerA);

		unregisterA();
		unregisterB();
	});

	it("isolates equal chat ids across environments", async () => {
		const chatId = "same-chat" as ChatId;
		const first = { environmentId: EnvironmentId.make("computer-a"), chatId };
		const second = { environmentId: EnvironmentId.make("computer-b"), chatId };
		const controllerA = vi.fn(async (_request: BrowserCommandRequest) => {});
		const controllerB = vi.fn(async (_request: BrowserCommandRequest) => {});
		const unregisterA = registerBrowserController(first, controllerA);
		const unregisterB = registerBrowserController(second, controllerB);

		expect(await waitForBrowserController(first)).toBe(controllerA);
		expect(await waitForBrowserController(second)).toBe(controllerB);
		unregisterA();
		unregisterB();
	});

	it("wakes a pending request when its chat controller mounts", async () => {
		const pending = waitForBrowserController(refB, 100);
		const controller = vi.fn(async (_request: BrowserCommandRequest) => {});
		const unregister = registerBrowserController(refB, controller);

		expect(await pending).toBe(controller);
		unregister();
	});
});
