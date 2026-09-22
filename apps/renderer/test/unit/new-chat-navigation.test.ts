import { ChatId, FolderId, SessionId } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureNewChatLanding,
	openNewChatLanding,
} from "../../src/lib/open-new-chat-landing.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useUiStore } from "../../src/store/ui.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

vi.mock(
	"../../src/lib/environment-shell-client-bus.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/environment-shell-client-bus.ts")
		>()),
		// Selection persistence can be stalled for the entire interaction.
		dispatchEnvironmentShellCommand: vi.fn(() => new Promise(() => {})),
	}),
);

const first = FolderId.make("first");
const second = FolderId.make("second");
const firstChat = ChatId.make("first-chat");
const secondChat = ChatId.make("second-chat");
const firstSession = SessionId.make("first-session");
const secondSession = SessionId.make("second-session");
const beginDraft = (projectId = first) => {
	useSessionsStore.getState().beginDraft({
		projectId,
		providerId: "codex",
		model: "test-model",
		runtimeMode: "approval-required",
	});
	return useSessionsStore.getState().draftRevision;
};

beforeEach(() => {
	vi.stubGlobal("location", new URL("http://localhost"));
	useWorkspaceStore.setState({ selectedFolderId: first });
	useChatsStore.setState({
		selectedChatId: firstChat,
		selectedChatByProject: { [first]: firstChat, [second]: secondChat },
	});
	useSessionsStore.setState({
		selectedSessionId: firstSession,
		selectedSessionByProject: {
			[first]: firstSession,
			[second]: secondSession,
		},
		draftSession: null,
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("New Chat navigation", () => {
	it("opens another project's landing immediately without waiting for persistence", async () => {
		const observed: Array<[ChatId | null, SessionId | null]> = [];
		const observe = () => {
			if (useWorkspaceStore.getState().selectedFolderId === second) {
				observed.push([
					useChatsStore.getState().selectedChatId,
					useSessionsStore.getState().selectedSessionId,
				]);
			}
		};
		const unsubscribe = [
			useWorkspaceStore.subscribe(observe),
			useChatsStore.subscribe(observe),
			useSessionsStore.subscribe(observe),
		];
		try {
			openNewChatLanding(second);
			await Promise.resolve();
		} finally {
			for (const stop of unsubscribe) stop();
		}
		expect(observed.length).toBeGreaterThan(0);
		expect(
			observed.every(([chat, session]) => chat === null && session === null),
		).toBe(true);
		expect(useWorkspaceStore.getState().selectedFolderId).toBe(second);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useSessionsStore.getState().selectedSessionId).toBeNull();
		expect(useChatsStore.getState().selectedChatByProject).toEqual({
			[first]: firstChat,
			[second]: null,
		});
		expect(useSessionsStore.getState().selectedSessionByProject).toEqual({
			[first]: firstSession,
			[second]: null,
		});
	});

	it("gives three consecutive requests distinct landings before a launch completes", () => {
		const revisions: number[] = [];
		const owners: Array<() => boolean> = [];
		for (let i = 0; i < 3; i++) {
			openNewChatLanding(first);
			revisions.push(useChatsStore.getState().landingRevision);
			owners.push(captureNewChatLanding());
		}
		expect(new Set(revisions).size).toBe(3);
		expect(owners.map((owns) => owns())).toEqual([false, false, true]);
	});

	it("does not let a delayed cloud launch navigate away from a newer draft", async () => {
		openNewChatLanding(first);
		const revision = beginDraft();
		const ownsLanding = captureNewChatLanding();
		let complete!: () => void;
		const launch = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const result = launch.then(() => {
			if (ownsLanding()) useChatsStore.setState({ selectedChatId: firstChat });
			useSessionsStore.getState().clearDraft(revision);
		});
		openNewChatLanding(first);
		beginDraft();
		const newerDraft = useSessionsStore.getState().draftSession;
		complete();
		await result;
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useSessionsStore.getState().draftSession).toBe(newerDraft);
	});

	it("releases launch focus when navigating to another project", () => {
		openNewChatLanding(first);
		const ownsLanding = captureNewChatLanding();
		expect(ownsLanding()).toBe(true);
		void useWorkspaceStore.getState().select(second);
		expect(ownsLanding()).toBe(false);
	});

	it("does not pull the user out of another main tab", () => {
		openNewChatLanding(first);
		const ownsLanding = captureNewChatLanding();
		useUiStore.getState().setActiveMainTab("usage");
		expect(ownsLanding()).toBe(false);
	});

	it("clears its own draft but leaves a replacement draft intact", () => {
		const original = beginDraft();
		useSessionsStore.getState().clearDraft(original);
		expect(useSessionsStore.getState().draftSession).toBeNull();
		const replacement = beginDraft();
		useSessionsStore.getState().clearDraft(original);
		expect(useSessionsStore.getState().draftSession).not.toBeNull();
		useSessionsStore.getState().clearDraft(replacement);
		expect(useSessionsStore.getState().draftSession).toBeNull();
	});
});
