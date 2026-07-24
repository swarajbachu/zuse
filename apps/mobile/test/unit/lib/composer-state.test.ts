import { describe, expect, test } from "vitest";

import {
	composerExpanded,
	isFreshChat,
	isInterruptVisible,
	type ModelModeSelection,
	nextModelChangeActions,
	summarizeComposerActivity,
} from "../../../src/lib/composer-state";

const base: ModelModeSelection = {
	providerId: "grok",
	model: "grok-4",
	runtimeMode: "approval-required",
	permissionMode: "default",
};

describe("composer state helpers", () => {
	test("shows interrupt only for active statuses", () => {
		expect(isInterruptVisible("running")).toBe(true);
		expect(isInterruptVisible("booting")).toBe(true);
		expect(isInterruptVisible("idle")).toBe(false);
		expect(isInterruptVisible("error")).toBe(false);
	});

	test("detects fresh chats by user messages", () => {
		expect(isFreshChat([])).toBe(true);
		expect(isFreshChat([{ content: { _tag: "assistant" } }])).toBe(true);
		expect(isFreshChat([{ content: { _tag: "user" } }])).toBe(false);
	});
});

describe("nextModelChangeActions", () => {
	test("switches provider on a fresh chat (grok → claude)", () => {
		const next: ModelModeSelection = {
			...base,
			providerId: "claude",
			model: "opus",
		};
		expect(nextModelChangeActions(base, next, true)).toEqual([
			{ type: "setProvider", providerId: "claude", model: "opus" },
		]);
	});

	test("ignores a provider change mid-chat", () => {
		const next: ModelModeSelection = {
			...base,
			providerId: "claude",
			model: "opus",
		};
		expect(nextModelChangeActions(base, next, false)).toEqual([]);
	});

	test("allows a model-only change mid-chat", () => {
		const next: ModelModeSelection = { ...base, model: "grok-4-fast" };
		expect(nextModelChangeActions(base, next, false)).toEqual([
			{ type: "setModel", model: "grok-4-fast" },
		]);
	});

	test("issues runtime and permission changes when they differ", () => {
		const next: ModelModeSelection = {
			...base,
			runtimeMode: "full-access",
			permissionMode: "plan",
		};
		expect(nextModelChangeActions(base, next, false)).toEqual([
			{ type: "setRuntimeMode", runtimeMode: "full-access" },
			{ type: "setPermissionMode", permissionMode: "plan" },
		]);
	});

	test("returns nothing when the selection is unchanged", () => {
		expect(nextModelChangeActions(base, { ...base }, true)).toEqual([]);
		expect(nextModelChangeActions(base, { ...base }, false)).toEqual([]);
	});
});

describe("composerExpanded", () => {
	const collapsed = {
		focused: false,
		hasText: false,
		hasAttachments: false,
		sheetOpen: false,
	};

	test("stays collapsed with no editor activity", () => {
		expect(composerExpanded(collapsed)).toBe(false);
	});

	test.each([
		["focused", { ...collapsed, focused: true }],
		["hasText", { ...collapsed, hasText: true }],
		["hasAttachments", { ...collapsed, hasAttachments: true }],
		["sheetOpen", { ...collapsed, sheetOpen: true }],
	] as const)("expands on %s", (_label, options) => {
		expect(composerExpanded(options)).toBe(true);
	});
});

describe("summarizeComposerActivity", () => {
	test("returns null with no turn", () => {
		expect(summarizeComposerActivity(undefined)).toBeNull();
	});

	test("finds the first agent tool item id", () => {
		const now = new Date();
		const message = (tool: string, itemId: string) =>
			({
				id: itemId,
				sessionId: "s",
				role: "assistant",
				content: { _tag: "tool_use", tool, itemId, input: "" },
				createdAt: now,
			}) as never;
		const turn = {
			id: "turn",
			user: null,
			body: [message("Read", "i1"), message("Task", "i2")],
			startedAt: now,
			endedAt: now,
			durationMs: 0,
		} as never;
		expect(summarizeComposerActivity(turn)?.agentItemId).toBe("i2");
	});
});
