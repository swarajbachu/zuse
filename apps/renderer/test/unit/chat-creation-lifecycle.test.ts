import type { ChatCreationPhase } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	chatCreationIsInProgress,
	worktreeSetupIsActive,
} from "../../src/lib/chat-creation-lifecycle.ts";

describe("chat creation lifecycle", () => {
	it.each<readonly [ChatCreationPhase, boolean]>([
		["persisted", true],
		["creating_workspace", true],
		["running_setup", true],
		["starting_agent", true],
		["cancelling", true],
		["running", false],
		["failed", false],
		["cancelled", false],
	])("reports %s in-progress=%s", (phase, expected) => {
		expect(chatCreationIsInProgress(phase)).toBe(expected);
	});

	it.each([
		["pending", true],
		["running", true],
		["succeeded", false],
		["failed", false],
		["skipped", false],
		[null, false],
	] as const)("reports setup %s active=%s", (status, expected) => {
		expect(worktreeSetupIsActive(status)).toBe(expected);
	});
});
