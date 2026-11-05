import { describe, expect, test } from "vitest";
import { matchAlerts, parseAlertRules } from "../src/automation.ts";

const human = {
	id: "support",
	channelId: "C123",
	projectId: "project_123",
	mode: "live",
	trigger: "message",
	keywords: ["bug", "broken"],
};
const event = {
	type: "message",
	channel: "C123",
	ts: "1.0",
	user: "U123",
	text: "This is BROKEN",
};

describe("Slack automation rules", () => {
	test("matches multiple independent workflows in the selected channel", () => {
		const rules = parseAlertRules(
			JSON.stringify([human, { ...human, id: "triage" }]),
		);
		expect(matchAlerts(rules, event).map((rule) => rule.id)).toEqual([
			"support",
			"triage",
		]);
		expect(matchAlerts(rules, { ...event, channel: "COTHER" })).toEqual([]);
		expect(matchAlerts(rules, { ...event, text: "hello" })).toEqual([]);
	});
	test("requires explicit opt-in for bot messages and ignores own bot and replies", () => {
		const rules = parseAlertRules(
			JSON.stringify([
				human,
				{ ...human, id: "bot", trigger: "bot-message", botId: "B123" },
			]),
		);
		expect(
			matchAlerts(rules, {
				...event,
				bot_id: "B123",
				subtype: "bot_message",
			}).map((rule) => rule.id),
		).toEqual(["bot"]);
		expect(matchAlerts(rules, event, "U123")).toEqual([]);
		expect(matchAlerts(rules, { ...event, thread_ts: "0.0" })).toEqual([]);
		expect(
			matchAlerts(rules, { ...event, subtype: "message_changed" }),
		).toEqual([]);
	});
	test("preserves Better Stack incident matching and excludes recovery", () => {
		const rules = parseAlertRules(
			JSON.stringify([
				{
					id: "alerts",
					channelId: "C123",
					botId: "B123",
					projectId: "project_123",
					mode: "dry-run",
				},
			]),
		);
		expect(
			matchAlerts(rules, {
				...event,
				bot_id: "B123",
				text: "Error detected in production: failure",
			}),
		).toHaveLength(1);
		expect(
			matchAlerts(rules, {
				...event,
				bot_id: "B123",
				text: "Error detected in production: failure\nResolved",
			}),
		).toHaveLength(0);
	});
	test("validates optional configuration without widening legacy bot rules", () => {
		for (const rule of [
			{ ...human, trigger: "unknown" },
			{ ...human, keywords: [""] },
			{ ...human, trigger: "bot-message" },
			{ ...human, prompt: "" },
		]) {
			expect(() => parseAlertRules(JSON.stringify([rule]))).toThrow(
				"invalid_alert_rule",
			);
		}
		expect(() => parseAlertRules(JSON.stringify([human, human]))).toThrow(
			"invalid_alert_rule",
		);
	});
});
