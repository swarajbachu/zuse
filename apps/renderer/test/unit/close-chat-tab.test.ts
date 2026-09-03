import type { ChatId, FolderId, Session, SessionId } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canonical = vi.hoisted(() => ({
	sessionsByProject: {} as Record<string, ReadonlyArray<Session>>,
}));

vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: {
		getState: () => ({
			defaultProviderId: "codex",
			defaultModelByProvider: { codex: "gpt-5.4" },
			defaultRuntimeMode: "full-access",
		}),
	},
}));

vi.mock("../../src/lib/environment-entities.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../src/lib/environment-entities.ts")
	>()),
	activeSessionsByProject: () => canonical.sessionsByProject,
}));

import {
	closeActiveChatTab,
	closeChatTab,
} from "../../src/lib/close-chat-tab.ts";
import {
	chatRecoveryIsCurrentSelection,
	resolveChatSessionSelection,
} from "../../src/store/chats.ts";
import { useProvidersStore } from "../../src/store/providers.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";

const projectId = "project-close-tabs" as FolderId;
const chatId = "chat-close-tabs" as ChatId;
const now = new Date("2026-08-01T00:00:00.000Z");

const session = (id: string, minute: number): Session => ({
	id: id as SessionId,
	projectId,
	chatId,
	title: id,
	titleProvenance: "manual",
	providerId: "codex",
	model: "gpt-5.4",
	status: "idle",
	archivedAt: null,
	cursor: null,
	resumeStrategy: "none",
	runtimeMode: "approval-required",
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: new Date(now.getTime() + minute * 60_000),
	updatedAt: now,
});

const initialSessionsState = useSessionsStore.getInitialState();
const initialProvidersState = useProvidersStore.getInitialState();

describe("closing chat tabs", () => {
	beforeEach(() => {
		canonical.sessionsByProject = {};
		useSessionsStore.setState(initialSessionsState, true);
		useProvidersStore.setState(initialProvidersState, true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("archives the active tab and selects its right-hand neighbor", async () => {
		const left = session("session-left", 0);
		const active = session("session-active", 1);
		const right = session("session-right", 2);
		const archive = vi.fn(async () => undefined);
		const select = vi.fn();
		canonical.sessionsByProject = { [projectId]: [right, active, left] };
		useSessionsStore.setState({
			selectedSessionId: active.id,
			archive,
			select,
		});

		await closeActiveChatTab();

		expect(archive).toHaveBeenCalledExactlyOnceWith(active.id);
		expect(select).toHaveBeenCalledExactlyOnceWith(right.id);
	});

	it("replaces the last tab using the configured provider defaults", async () => {
		const active = session("session-only", 0);
		const archive = vi.fn(async () => undefined);
		const create = vi.fn(async () => null);
		const refresh = vi.fn(async () => undefined);
		canonical.sessionsByProject = { [projectId]: [active] };
		useSessionsStore.setState({
			archive,
			create,
		});
		useProvidersStore.setState({ refresh });

		await closeChatTab(active.id);

		expect(refresh).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledExactlyOnceWith(chatId, "codex", "gpt-5.4", {
			runtimeMode: "full-access",
		});
		expect(archive).not.toHaveBeenCalled();
	});

	it("archives the final tab only after its replacement exists", async () => {
		const active = session("session-only", 0);
		const replacementId = "session-replacement" as SessionId;
		const archive = vi.fn(async () => undefined);
		const create = vi.fn(async () => replacementId);
		const select = vi.fn();
		canonical.sessionsByProject = { [projectId]: [active] };
		useSessionsStore.setState({ archive, create, select });
		useProvidersStore.setState({ refresh: vi.fn(async () => undefined) });

		await closeChatTab(active.id);

		expect(create.mock.invocationCallOrder[0]).toBeLessThan(
			archive.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(archive).toHaveBeenCalledExactlyOnceWith(active.id);
		expect(select).toHaveBeenCalledExactlyOnceWith(replacementId);
	});

	it("recovers the archived active tab when an active chat has no live tab", () => {
		const archivedActiveId = "session-archived" as SessionId;

		expect(resolveChatSessionSelection(archivedActiveId, [])).toEqual({
			sessionId: null,
			recoverArchivedSessionId: archivedActiveId,
		});
	});

	it("does not report a stale recovery failure after opening new chat", () => {
		expect(
			chatRecoveryIsCurrentSelection({
				chatId,
				projectId,
				selectedChatId: null,
				selectedProjectId: projectId,
			}),
		).toBe(false);
	});
});
