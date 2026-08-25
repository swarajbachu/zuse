import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	readComputerAwakePreference,
	writeComputerAwakePreference,
} from "../../src/computer-awake-preference.ts";

describe("computer awake preference", () => {
	it("defaults missing and malformed preferences to auto", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-awake-pref-"));
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");

		await writeFile(join(directory, "computer-awake.json"), "not json", "utf8");
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");

		await writeFile(
			join(directory, "computer-awake.json"),
			JSON.stringify({ mode: "timed" }),
			"utf8",
		);
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");
	});

	it("persists a validated host mode atomically", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-awake-pref-"));
		await writeComputerAwakePreference(directory, "always");

		await expect(readComputerAwakePreference(directory)).resolves.toBe(
			"always",
		);
		await expect(
			readFile(join(directory, "computer-awake.json"), "utf8"),
		).resolves.toContain('"mode": "always"');
		await expect(readdir(directory)).resolves.toEqual(["computer-awake.json"]);
	});
});
