import { ChatId, CloudProject, FolderId, SessionId } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeCloudProjectFolders } from "../../src/lib/cloud-project-folders.ts";
import {
	captureNewChatLanding,
	openNewChatLanding,
	resetCompletedChatDraft,
} from "../../src/lib/open-new-chat-landing.ts";
import {
	buildLogicalProjectGroups,
	landingDefaultProject,
	preferredGroupMember,
} from "../../src/lib/project-groups.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
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
	observeRendererAccount("navigation-user");
	selectRendererWorkspace({ kind: "personal" });
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
	it("opens an organization cloud repository arriving after New Chat without a local checkout", () => {
		selectRendererWorkspace({ kind: "organization", organizationId: "legion" });
		useWorkspaceStore.setState({ selectedFolderId: null, folders: [] });
		openNewChatLanding(null);
		const projected = mergeCloudProjectFolders([], {}, [
			CloudProject.make({
				projectId: "legion-repo",
				repositoryIdentity: "github.com/legion-team/legion",
				repositoryUrl: "https://github.com/legion-team/legion.git",
				displayName: "legion",
				defaultBranch: "master",
				visibility: "private",
				state: "ready",
				activeBuilds: {},
				latestBuilds: {},
				createdAt: 1,
				updatedAt: 1,
			}),
		]);
		const groups = buildLogicalProjectGroups({
			entries: [],
			activeEnvironmentId: "local",
			localEnvironmentId: "local",
			activeFolders: projected.folders,
			activeOrigins: projected.originsByFolder,
			activeChatsByProject: {},
			shellsByEnvironment: {},
		});
		const group = landingDefaultProject(
			groups,
			null,
			null,
			useChatsStore.getState().landingRevision > 0,
		);
		expect(group).not.toBeNull();
		if (group === null) throw new Error("Expected cloud repository");
		const member = preferredGroupMember(group);
		expect(member?.isActive).toBe(true);
		if (member === null) throw new Error("Expected selectable repository");
		openNewChatLanding(member.folderId);
		expect(useWorkspaceStore.getState().selectedFolderId).toBe(
			"cloud-project:legion-repo",
		);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useWorkspaceStore.getState().folders).toEqual([]);
	});

	it("dispatches New Chat with no selected repository instead of doing nothing", async () => {
		vi.stubGlobal("document", { body: { dataset: {} } });
		useWorkspaceStore.setState({ selectedFolderId: null });
		useChatsStore.setState({ selectedChatId: null });
		useUiStore.getState().setView("settings");
		const { dispatchCommand } = await import(
			"../../src/lib/command-handlers.ts"
		);
		dispatchCommand("new-chat");
		expect(useUiStore.getState().view).toBe("chat");
	});
	it("opens the landing from settings even before cloud repositories have loaded", () => {
		useWorkspaceStore.setState({ selectedFolderId: null });
		useUiStore.getState().setView("settings");
		useUiStore.getState().setActiveMainTab("plugins");
		openNewChatLanding(null);
		expect(useUiStore.getState().view).toBe("chat");
		expect(useUiStore.getState().activeMainTab).toBe("chat");
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useWorkspaceStore.getState().selectedFolderId).toBeNull();
	});
	it("does not let a late launch reclaim navigation after switching workspaces and back", () => {
		openNewChatLanding(first);
		const personal = captureNewChatLanding();
		expect(personal()).toBe(true);
		selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
		expect(personal()).toBe(false);
		const organization = captureNewChatLanding();
		selectRendererWorkspace({ kind: "personal" });
		expect(personal()).toBe(false);
		expect(organization()).toBe(false);
		expect(captureNewChatLanding()()).toBe(true);
	});
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

	it("recreates a hidden landing after a completed launch", () => {
		openNewChatLanding(first);
		const revision = beginDraft();
		useUiStore.getState().setActiveMainTab("usage");
		const reset = vi.fn(() => beginDraft());
		resetCompletedChatDraft(revision, reset);
		expect(reset).toHaveBeenCalledOnce();
		expect(useSessionsStore.getState().draftSession).not.toBeNull();
		expect(useSessionsStore.getState().draftRevision).toBeGreaterThan(revision);
	});

	it("does not reset a newer draft or a selected launch", () => {
		openNewChatLanding(first);
		const revision = beginDraft();
		beginDraft();
		const reset = vi.fn();
		resetCompletedChatDraft(revision, reset);
		expect(reset).not.toHaveBeenCalled();
		useChatsStore.setState({ selectedChatId: firstChat });
		resetCompletedChatDraft(useSessionsStore.getState().draftRevision, reset);
		expect(reset).not.toHaveBeenCalled();
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
