import { beforeEach, describe, expect, it } from "vitest";

import {
	ENVIRONMENT_SUMMARY_STORAGE_KEY,
	useUiStore,
} from "../src/store/ui.ts";

const values = new Map<string, string>();
const localStorage = {
	clear: () => values.clear(),
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => values.set(key, value),
};

Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { localStorage },
});

describe("environment summary preference", () => {
	beforeEach(() => {
		localStorage.clear();
		useUiStore.setState({ environmentSummaryOpen: true });
	});

	it("defaults to open", () => {
		expect(useUiStore.getState().environmentSummaryOpen).toBe(true);
	});

	it("persists explicit visibility changes", () => {
		useUiStore.getState().setEnvironmentSummaryOpen(false);

		expect(useUiStore.getState().environmentSummaryOpen).toBe(false);
		expect(localStorage.getItem(ENVIRONMENT_SUMMARY_STORAGE_KEY)).toBe("false");
	});

	it("toggles and persists the next value", () => {
		useUiStore.getState().toggleEnvironmentSummary();

		expect(useUiStore.getState().environmentSummaryOpen).toBe(false);
		expect(localStorage.getItem(ENVIRONMENT_SUMMARY_STORAGE_KEY)).toBe("false");
	});
});
