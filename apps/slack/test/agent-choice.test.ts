import {
	BUNDLED_MODEL_CATALOG,
	CloudAuthProvider,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { agentOptions, resolveAgentChoice } from "../src/agent-choice.ts";

describe("Slack agent choices", () => {
	it("uses supported cloud agents and the shared visible model catalog", () => {
		const options = agentOptions();
		expect(options.length).toBeGreaterThan(0);
		expect(options.length).toBeLessThanOrEqual(100);
		expect(new Set(options.map((option) => option.value)).size).toBe(
			options.length,
		);
		for (const option of options) {
			const choice = resolveAgentChoice(option.value);
			if (!choice) throw new Error("Expected resolvable catalog option");
			expect(CloudAuthProvider.literals).toContain(choice.agent);
			expect(
				visibleModelsForProvider(BUNDLED_MODEL_CATALOG, choice.agent).some(
					(model) => model.id === choice.model,
				),
			).toBe(true);
			expect(option.text.text.length).toBeLessThanOrEqual(75);
			expect(option.value.length).toBeLessThanOrEqual(150);
		}
	});
	it.each([
		undefined,
		"",
		"forged:model",
		"codex:claude-fable-5-1",
		"claude:gpt-6-astra",
	])("rejects unknown or mismatched choices: %s", (value) => {
		expect(resolveAgentChoice(value)).toBeUndefined();
	});
});
