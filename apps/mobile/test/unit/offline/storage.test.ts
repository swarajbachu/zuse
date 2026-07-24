import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	clearDownloadedCache,
	downloadedCacheSize,
} from "../../../src/offline/cache";

const { deleteAsync, readDirectoryAsync, getInfoAsync } = vi.hoisted(() => ({
	deleteAsync: vi.fn(async (_path: string, _options?: unknown) => {}),
	readDirectoryAsync: vi.fn(async (path: string) => {
		if (path === "file:///documents/zuse-cache") return ["computer"];
		if (path.endsWith("/messages")) return ["message.json"];
		return [];
	}),
	getInfoAsync: vi.fn(async (path: string) => {
		if (path === "file:///documents/zuse-cache" || path.endsWith("/messages")) {
			return { exists: true, isDirectory: true };
		}
		if (path.endsWith("sessions.json")) {
			return { exists: true, isDirectory: false, size: 20 };
		}
		if (path.endsWith("message.json")) {
			return { exists: true, isDirectory: false, size: 30 };
		}
		return { exists: false, isDirectory: false, size: 0 };
	}),
}));

vi.mock("expo-file-system/legacy", () => ({
	documentDirectory: "file:///documents/",
	deleteAsync,
	readDirectoryAsync,
	getInfoAsync,
	makeDirectoryAsync: vi.fn(),
	readAsStringAsync: vi.fn(),
	writeAsStringAsync: vi.fn(),
}));

describe("mobile downloaded storage", () => {
	beforeEach(() => {
		deleteAsync.mockClear();
		readDirectoryAsync.mockClear();
		getInfoAsync.mockClear();
	});

	test("counts sessions and messages without counting the outbox", async () => {
		await expect(downloadedCacheSize()).resolves.toBe(50);
		expect(getInfoAsync).not.toHaveBeenCalledWith(
			expect.stringContaining("/outbox"),
		);
	});

	test("clears downloaded snapshots while preserving unsent outbox files", async () => {
		await Effect.runPromise(clearDownloadedCache());
		const paths = deleteAsync.mock.calls.map(([path]) => path);
		expect(paths).toEqual([
			"file:///documents/zuse-cache/computer/sessions.json",
			"file:///documents/zuse-cache/computer/messages",
		]);
		expect(paths.join(" ")).not.toContain("outbox");
	});
});
