import type {
	Chat,
	Folder,
	Message,
	PermissionRequest,
	Session,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	buildNotchItems,
	deriveRunningSessions,
	NOTCH_COMPLETION_TTL_MS,
	noteCompletedSessions,
} from "../../src/lib/notch-items.ts";
import type { SessionRuntimeState } from "../../src/lib/session-runtime-state.ts";

const now = 1_000_000;

const folder = {
	id: "project-1",
	name: "Osaka",
	path: "/repo",
} as Folder;

const chat = {
	id: "chat-1",
	projectId: "project-1",
	title: "Implement notch tray",
	archivedAt: null,
	activeSessionId: "session-1",
	lastMessageAt: null,
	lastReadAt: null,
	worktreeId: null,
} as Chat;

const session = (status: Session["status"] = "idle") =>
	({
		id: "session-1",
		chatId: "chat-1",
		projectId: "project-1",
		title: "Implement notch tray",
		providerId: "codex",
		model: "gpt-5.3-codex",
		status,
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: "approval-required",
		worktreeId: null,
	}) as Session;

const userQuestion = {
	content: {
		_tag: "user_question",
		itemId: "q1",
		questions: [{ question: "Which behavior?", options: ["A"] }],
	},
} as unknown as Message;

const exitPlan = {
	content: {
		_tag: "tool_use",
		itemId: "p1",
		tool: "ExitPlanMode",
		input: { plan: "Do the work" },
	},
} as unknown as Message;

const permission = {
	id: "perm-1",
	sessionId: "session-1",
	kind: { _tag: "Bash", command: "bun test" },
	requestedAt: new Date(now),
	forcePrompt: false,
} as PermissionRequest;

const runtimeProjection = (state: SessionRuntimeState): SessionRuntimeState =>
	state;

const baseInput = {
	folders: [folder],
	chatsByProject: { "project-1": [chat] },
	sessionsByProject: { "project-1": [session()] },
	messagesBySession: {},
	runtimeBySession: { "session-1": runtimeProjection("idle") },
	permissionRequests: [],
	recentCompletions: {},
	now,
};

describe("buildNotchItems", () => {
	it("shows running sessions", () => {
		const items = buildNotchItems({
			...baseInput,
			sessionsByProject: { "project-1": [session("running")] },
			runtimeBySession: { "session-1": runtimeProjection("running") },
		});

		expect(items).toHaveLength(1);
		expect(items[0]?.state).toBe("running");
	});

	it("uses the shared runtime projection for completion", () => {
		const items = buildNotchItems({
			...baseInput,
			runtimeBySession: {
				"session-1": runtimeProjection("idle"),
			},
		});

		expect(items).toHaveLength(0);
		expect(
			deriveRunningSessions(baseInput.sessionsByProject, {
				"session-1": runtimeProjection("idle"),
			}),
		).toEqual({ "session-1": false });
	});

	it("surfaces provider startup through the same runtime selector", () => {
		const items = buildNotchItems({
			...baseInput,
			sessionsByProject: { "project-1": [session("booting")] },
			runtimeBySession: { "session-1": runtimeProjection("starting") },
		});

		expect(items[0]?.state).toBe("running");
	});

	it("prioritizes permission over question and plan states", () => {
		const items = buildNotchItems({
			...baseInput,
			messagesBySession: { "session-1": [exitPlan, userQuestion] },
			runtimeBySession: {
				"session-1": runtimeProjection("running"),
			},
			permissionRequests: [permission],
		});

		expect(items[0]?.state).toBe("permission");
	});

	it("keeps recent completions for the TTL", () => {
		const recentCompletions = noteCompletedSessions(
			{ "session-1": true },
			{ "session-1": false },
			{},
			now,
		);
		const fresh = buildNotchItems({
			...baseInput,
			recentCompletions,
			now: now + NOTCH_COMPLETION_TTL_MS - 1,
		});
		const expired = buildNotchItems({
			...baseInput,
			recentCompletions,
			now: now + NOTCH_COMPLETION_TTL_MS + 1,
		});

		expect(fresh[0]?.state).toBe("completed");
		expect(expired).toHaveLength(0);
	});

	it("shows failed sessions above completed sessions", () => {
		const failed = { ...session("error"), id: "failed-session" } as Session;
		const completed = {
			...session("idle"),
			id: "completed-session",
		} as Session;
		const items = buildNotchItems({
			...baseInput,
			sessionsByProject: { "project-1": [completed, failed] },
			runtimeBySession: {
				"completed-session": runtimeProjection("idle"),
				"failed-session": runtimeProjection("failed"),
			},
			recentCompletions: {
				"completed-session": { completedAt: now },
			},
		});

		expect(items.map((item) => item.state)).toEqual(["failed", "completed"]);
	});
});
