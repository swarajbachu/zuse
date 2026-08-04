import type { AgentAvailability } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import {
	availableProviderIds,
	RUNTIME_OPTIONS,
	reasoningValueForModel,
	runtimeOptionFor,
	runtimeOptionsForProvider,
} from "../../../src/lib/model-options";

const entry = (
	providerId: AgentAvailability["providerId"],
	overrides: Partial<AgentAvailability> = {},
): AgentAvailability => ({
	providerId,
	displayName: providerId,
	cliInstalled: true,
	cliLoggedIn: true,
	hasApiKey: false,
	...overrides,
});

describe("availableProviderIds", () => {
	test("returns null (no filtering) for null/undefined availability", () => {
		expect(availableProviderIds(null)).toBeNull();
		expect(availableProviderIds(undefined)).toBeNull();
	});

	test("keeps ready and warning providers, drops error/disabled", () => {
		const availability: AgentAvailability[] = [
			entry("codex", { status: "ready" }),
			entry("claude", { status: "warning" }),
			entry("grok", { status: "error" }),
			entry("gemini", { status: "disabled" }),
		];
		expect(availableProviderIds(availability)).toEqual(["codex", "claude"]);
	});

	test("falls back to cliInstalled when status is missing", () => {
		const availability: AgentAvailability[] = [
			entry("codex", { cliInstalled: true }),
			entry("claude", { cliInstalled: false }),
		];
		expect(availableProviderIds(availability)).toEqual(["codex"]);
	});

	test("returns an empty list when nothing is available", () => {
		expect(availableProviderIds([entry("codex", { status: "error" })])).toEqual(
			[],
		);
	});
});

describe("reasoningValueForModel", () => {
	test("falls back to the model default when a stored effort is unsupported", () => {
		expect(
			reasoningValueForModel("codex", "gpt-5.5", { reasoning: "ultra" }),
		).toMatchObject({ value: "medium", label: "Medium" });
	});
});

describe("runtimeOptionFor", () => {
	test("gives every permission level a distinct icon and risk color", () => {
		const options = [
			runtimeOptionFor("approval-required"),
			runtimeOptionFor("auto-accept-edits"),
			runtimeOptionFor("auto"),
			runtimeOptionFor("full-access"),
		];

		expect(new Set(options.map((option) => option.systemImage)).size).toBe(4);
		expect(new Set(options.map((option) => option.tint)).size).toBe(4);
		expect(runtimeOptionFor("auto-accept-edits").tint).toBe("#0A84FF");
		expect(runtimeOptionFor("full-access").tint).toBe("#FF453A");
	});

	test("shows approve for me only for Codex while retaining every existing mode", () => {
		expect(runtimeOptionFor("auto").label).toBe("Approve for me");
		expect(RUNTIME_OPTIONS.map((option) => option.value)).toEqual([
			"approval-required",
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
			"full-access",
		]);
		expect(
			runtimeOptionsForProvider("codex").map((option) => option.value),
		).toEqual([
			"approval-required",
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
			"auto",
			"full-access",
		]);
		expect(runtimeOptionsForProvider("claude")).toEqual(RUNTIME_OPTIONS);
	});
});
