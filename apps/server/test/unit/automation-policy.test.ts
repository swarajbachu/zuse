import type {
	AutomationDispatchInput,
	AutomationTrigger,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { matchesAutomationTrigger } from "../../src/automation/policy.ts";

const trigger: AutomationTrigger = {
	_tag: "slack",
	events: ["message"],
	channelIds: ["channel"],
	keywords: ["help"],
	includeBotMessages: false,
};
const event: AutomationDispatchInput = {
	automationId: "a",
	eventId: "e",
	source: "slack",
	prompt: "HELP with the build",
	context: { event: "message", channelId: "channel" },
};
describe("automation event matching", () => {
	it("combines all configured filters", () => {
		expect(matchesAutomationTrigger(trigger, event)).toBe(true);
		expect(
			matchesAutomationTrigger(trigger, {
				...event,
				context: { ...event.context, channelId: "other" },
			}),
		).toBe(false);
		expect(
			matchesAutomationTrigger(trigger, { ...event, prompt: "unrelated" }),
		).toBe(false);
	});
	it("rejects bot loops and mismatched source", () => {
		expect(
			matchesAutomationTrigger(trigger, {
				...event,
				context: { ...event.context, botId: "B123" },
			}),
		).toBe(false);
		expect(
			matchesAutomationTrigger(trigger, { ...event, source: "github" }),
		).toBe(false);
	});
	it("matches GitHub repository, action and event together", () => {
		const github: AutomationTrigger = {
			_tag: "github",
			events: ["issues"],
			repositories: ["org/repo"],
			actions: ["opened"],
		};
		const delivery: AutomationDispatchInput = {
			...event,
			source: "github",
			context: { event: "issues", repository: "org/repo", action: "opened" },
		};
		expect(matchesAutomationTrigger(github, delivery)).toBe(true);
		expect(
			matchesAutomationTrigger(github, {
				...delivery,
				context: { ...delivery.context, action: "closed" },
			}),
		).toBe(false);
	});
});
