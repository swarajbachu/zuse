import type { Message } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import { selectSessionMessages } from "../../../src/lib/session-messages";

describe("selectSessionMessages", () => {
	test("returns the same empty snapshot for a missing session", () => {
		const messagesBySession: Record<string, readonly Message[]> = {};

		expect(selectSessionMessages(messagesBySession, "missing")).toBe(
			selectSessionMessages(messagesBySession, "missing"),
		);
	});

	test("returns the stored session snapshot unchanged", () => {
		const messages = [] as readonly Message[];

		expect(selectSessionMessages({ present: messages }, "present")).toBe(
			messages,
		);
	});
});
