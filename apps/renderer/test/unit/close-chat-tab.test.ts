import type { ChatId, FolderId, Session, SessionId } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	closeActiveChatTab,
	closeChatTab,
} from "../../src/lib/close-chat-tab.ts";
import { useProvidersStore } from "../../src/store/providers.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useSettingsStore } from "../../src/store/settings.ts";

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
const initialSettingsState = useSettingsStore.getInitialState();

describe("closing chat tabs", () => {
	beforeEach(() => {
		useSessionsStore.setState(initialSessionsState, true);
		useProvidersStore.setState(initialProvidersState, true);
		useSettingsStore.setState(initialSettingsState, true);
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
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [right, active, left] },
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
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [active] },
			archive,
			create,
		});
		useProvidersStore.setState({ refresh });
		useSettingsStore.setState({
			defaultProviderId: "codex",
			defaultModelByProvider: {
				...initialSettingsState.defaultModelByProvider,
				codex: "gpt-5.4",
			},
			defaultRuntimeMode: "full-access",
		});

		await closeChatTab(active.id);

		expect(refresh).toHaveBeenCalledOnce();
		expect(archive).toHaveBeenCalledExactlyOnceWith(active.id);
		expect(create).toHaveBeenCalledExactlyOnceWith(chatId, "codex", "gpt-5.4", {
			runtimeMode: "full-access",
		});
	});
});
