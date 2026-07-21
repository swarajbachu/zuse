import type { SessionId } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import {
	activeThreadSelection,
	shouldRestoreThreadPosition,
	switchToThread,
} from "../../../src/lib/thread-switching";

const first = "session-one" as SessionId;
const second = "session-two" as SessionId;

describe("mobile thread switching", () => {
	it("uses the canonical active thread instead of the sheet-opening route", () => {
		expect(activeThreadSelection(second, first)).toBe(second);
		expect(activeThreadSelection(null, first)).toBe(first);
	});

	it("opens explicit thread switches at the latest message", () => {
		expect(shouldRestoreThreadPosition("1")).toBe(false);
		expect(shouldRestoreThreadPosition(undefined)).toBe(true);
	});

	it("navigates immediately while activation continues in the background", () => {
		const order: string[] = [];
		const showLoading = vi.fn(() => {
			order.push("loading");
		});
		const activate = vi.fn(() => {
			order.push("activate");
			return new Promise<void>(() => {});
		});
		const navigate = vi.fn(() => {
			order.push("navigate");
		});

		switchToThread(second, showLoading, activate, navigate);

		expect(order).toEqual(["loading", "activate", "navigate"]);
		expect(activate).toHaveBeenCalledWith(second);
		expect(navigate).toHaveBeenCalledWith(second);
	});

	it("activation failure cannot block navigation", async () => {
		const navigate = vi.fn();
		switchToThread(
			second,
			() => {},
			async () => Promise.reject(new Error("offline")),
			navigate,
		);
		await Promise.resolve();

		expect(navigate).toHaveBeenCalledWith(second);
	});
});
