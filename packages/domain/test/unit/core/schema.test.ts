import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { SessionCommand } from "../../../src/core/commands.js";
import { SessionEvent } from "../../../src/core/events.js";

describe("session domain schemas", () => {
	test("decode valid commands and events", () => {
		expect(
			Schema.decodeUnknownSync(SessionCommand)({
				_tag: "SetTitle",
				title: "Clean foundation",
				updatedAt: 1,
			}),
		).toEqual({ _tag: "SetTitle", title: "Clean foundation", updatedAt: 1 });
		expect(
			Schema.decodeUnknownSync(SessionEvent)({
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 1,
			}),
		).toMatchObject({ _tag: "TurnSettled", outcome: "completed" });
	});

	test("rejects invalid settlement outcomes", () => {
		expect(() =>
			Schema.decodeUnknownSync(SessionEvent)({
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "stuck",
				settledAt: 1,
			}),
		).toThrow();
	});
});
