import { beforeEach, describe, expect, test } from "vitest";
import { appAtomRegistry } from "../../../src/store/registry";
import {
	markSessionTurnStartFailed,
	markSessionTurnStarting,
	resetSessionTurnActivity,
	resolveSessionStatus,
	sessionTurnActivityBySessionAtom,
	syncSessionTurnActivity,
} from "../../../src/store/session-turn-activity";

describe("session turn activity", () => {
	beforeEach(() => resetSessionTurnActivity());

	test("covers the submit-to-first-stream-frame gap optimistically", () => {
		markSessionTurnStarting("connection:session");

		expect(
			appAtomRegistry.get(sessionTurnActivityBySessionAtom)[
				"connection:session"
			],
		).toBe("starting");
	});

	test("the authoritative timeline owns running and settled state", () => {
		markSessionTurnStarting("connection:session");
		syncSessionTurnActivity("connection:session", false);
		expect(
			appAtomRegistry.get(sessionTurnActivityBySessionAtom)[
				"connection:session"
			],
		).toBe("starting");

		syncSessionTurnActivity("connection:session", true);
		expect(
			appAtomRegistry.get(sessionTurnActivityBySessionAtom)[
				"connection:session"
			],
		).toBe("running");

		syncSessionTurnActivity("connection:session", false);
		expect(
			appAtomRegistry.get(sessionTurnActivityBySessionAtom)[
				"connection:session"
			],
		).toBe("idle");
	});

	test("failed append clears optimistic activity", () => {
		markSessionTurnStarting("connection:session");
		markSessionTurnStartFailed("connection:session");

		expect(
			appAtomRegistry.get(sessionTurnActivityBySessionAtom)[
				"connection:session"
			],
		).toBe("idle");
	});

	test("timeline activity takes precedence over a lagging summary status", () => {
		expect(resolveSessionStatus("idle", "starting")).toBe("booting");
		expect(resolveSessionStatus("idle", "running")).toBe("running");
		expect(resolveSessionStatus("running", "idle")).toBe("idle");
		expect(resolveSessionStatus("error", "idle")).toBe("error");
		expect(resolveSessionStatus("running", undefined)).toBe("running");
	});
});
