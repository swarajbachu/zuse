import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createLocaleController,
	readLocalePreference,
	writeLocalePreference,
} from "../../src/locale-preference.ts";

const controller = (
	overrides: Partial<Parameters<typeof createLocaleController>[0]> = {},
) =>
	createLocaleController({
		preference: "system",
		languages: () => ["fr-FR"],
		preview: true,
		persist: async () => {},
		prepare: async () => {},
		publish: () => {},
		...overrides,
	});
describe("installation-local language preference", () => {
	it("round-trips an atomic preference and recovers from missing/corrupt files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-locale-"));
		try {
			expect(await readLocalePreference(directory)).toBe("system");
			await writeLocalePreference(directory, "zh-Hant");
			expect(await readLocalePreference(directory)).toBe("zh-Hant");
			expect(
				JSON.parse(await readFile(join(directory, "language.json"), "utf8")),
			).toEqual({ version: 1, preference: "zh-Hant" });
			await writeFile(join(directory, "language.json"), "{broken");
			expect(await readLocalePreference(directory)).toBe("system");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("serializes rapid edits and publishes only persisted changes", async () => {
		const order: string[] = [];
		const state = controller({
			persist: async (preference) => {
				await Promise.resolve();
				order.push(`save:${preference}`);
			},
			publish: (snapshot) => {
				order.push(`publish:${snapshot.locale}`);
			},
		});
		await Promise.all([state.set("de"), state.set("ja"), state.set("ko")]);
		expect(order).toEqual([
			"save:de",
			"publish:de",
			"save:ja",
			"publish:ja",
			"save:ko",
			"publish:ko",
		]);
		expect(state.get()).toMatchObject({
			preference: "ko",
			locale: "ko",
			revision: 3,
		});
	});
	it("retains the previous snapshot on disk failure and allows retry", async () => {
		const persist = vi
			.fn()
			.mockRejectedValueOnce(new Error("disk full"))
			.mockResolvedValue(undefined);
		const publish = vi.fn();
		const state = controller({ persist, publish });
		const previous = state.get();
		await expect(state.set("de")).rejects.toThrow("disk full");
		expect(state.get()).toBe(previous);
		expect(publish).not.toHaveBeenCalled();
		await state.set("ja");
		expect(state.get().locale).toBe("ja");
	});
	it("does not persist when catalog preparation fails", async () => {
		const persist = vi.fn();
		const state = controller({
			persist,
			prepare: async () => {
				throw new Error("missing chunk");
			},
		});
		await expect(state.set("de")).rejects.toThrow("missing chunk");
		expect(persist).not.toHaveBeenCalled();
		expect(state.get().locale).toBe("fr");
	});
	it("re-resolves System while retaining explicit overrides", async () => {
		let languages = ["fr-FR"];
		const state = controller({ languages: () => languages });
		languages = ["de-DE"];
		await state.refresh();
		expect(state.get().locale).toBe("de");
		await state.set("ja");
		languages = ["ko-KR"];
		await state.refresh();
		expect(state.get().locale).toBe("ja");
	});
	it("rejects unreviewed and malformed IPC values", async () => {
		const state = controller({ preview: false });
		await expect(state.set("en-XA")).rejects.toThrow("Unsupported");
		await expect(state.set({ locale: "en" })).rejects.toThrow("Unsupported");
	});
	it("does not let activation refresh overwrite a concurrently selected language", async () => {
		const state = controller();
		await Promise.all([state.refresh(), state.set("ja")]);
		expect(state.get().preference).toBe("ja");
		await Promise.all([state.set("ko"), state.refresh()]);
		expect(state.get().preference).toBe("ko");
	});
	it("falls back to System if a preview language was disabled", () => {
		expect(
			controller({ preference: "en-XA", preview: false }).get(),
		).toMatchObject({ preference: "system", locale: "en" });
	});
});
