import type { LocaleSnapshot } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ prepare: vi.fn(), activate: vi.fn() }));
vi.mock("@zuse/i18n", () => ({
	prepareLocale: runtime.prepare,
	activateLocale: runtime.activate,
	availableLocales: () => ["en", "fr", "de"],
	resolveLocale: (preference: string) =>
		preference === "system" ? "en" : preference,
	i18n: { store: { data: { en: { common: {} } } } },
}));
const initial: LocaleSnapshot = {
	version: 1,
	revision: 0,
	preference: "system",
	locale: "en",
	available: ["en", "fr", "de"],
};
const next = (locale: "fr" | "de", revision: number): LocaleSnapshot => ({
	...initial,
	revision,
	locale,
	preference: locale,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let emit: (snapshot: LocaleSnapshot) => void;
let get: ReturnType<typeof vi.fn>;
let set: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.resetModules();
	runtime.prepare.mockReset().mockResolvedValue(undefined);
	runtime.activate.mockReset().mockResolvedValue(undefined);
	get = vi.fn().mockResolvedValue(initial);
	set = vi.fn();
	vi.stubGlobal("window", {
		zuse: {
			locale: {
				get,
				set,
				onChange: (listener: typeof emit) => {
					emit = listener;
					return () => {};
				},
			},
		},
	});
	vi.stubGlobal("document", { documentElement: { lang: "", dir: "" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("renderer locale revisions", () => {
	it("waits for a newer event when the initial read is stale", async () => {
		const read = deferred<LocaleSnapshot>();
		const prepare = deferred<void>();
		get.mockReturnValue(read.promise);
		runtime.prepare.mockImplementation((locale: string) =>
			locale === "fr" ? prepare.promise : Promise.resolve(),
		);
		const module = await import("../../src/lib/localization.ts");
		let ready = false;
		const start = module.initializeLocalization().then(() => {
			ready = true;
		});
		emit(next("fr", 1));
		read.resolve(initial);
		await tick();
		expect(ready).toBe(false);
		prepare.resolve();
		await start;
		expect(document.documentElement.lang).toBe("fr");
	});
	it("ignores an older catalog that finishes loading last", async () => {
		const module = await import("../../src/lib/localization.ts");
		await module.initializeLocalization();
		const slow = deferred<void>();
		runtime.prepare.mockImplementation((locale: string) =>
			locale === "fr" ? slow.promise : Promise.resolve(),
		);
		emit(next("fr", 1));
		emit(next("de", 2));
		await tick();
		slow.resolve();
		await tick();
		expect(document.documentElement.lang).toBe("de");
		expect(runtime.activate.mock.calls.map((call) => call[0])).toEqual([
			"en",
			"de",
		]);
	});
	it("awaits preparation when the broadcast precedes the set response", async () => {
		const module = await import("../../src/lib/localization.ts");
		await module.initializeLocalization();
		const slow = deferred<void>();
		runtime.prepare.mockReturnValue(slow.promise);
		set.mockImplementation(async () => {
			const value = next("fr", 1);
			emit(value);
			return value;
		});
		let done = false;
		const operation = module.setLanguage("fr").then(() => {
			done = true;
		});
		await tick();
		expect(done).toBe(false);
		slow.resolve();
		await operation;
		expect(document.documentElement.lang).toBe("fr");
	});
	it("retains the working UI and distinguishes save failure from load failure", async () => {
		const module = await import("../../src/lib/localization.ts");
		await module.initializeLocalization();
		set.mockRejectedValueOnce(new Error("disk full"));
		await expect(module.setLanguage("fr")).rejects.toMatchObject({
			kind: "save",
		});
		set.mockResolvedValue(next("fr", 1));
		runtime.prepare.mockRejectedValueOnce(new Error("missing chunk"));
		await expect(module.setLanguage("fr")).rejects.toMatchObject({
			kind: "load",
		});
		expect(document.documentElement.lang).toBe("en");
		runtime.prepare.mockResolvedValue(undefined);
		await module.setLanguage("fr");
		expect(document.documentElement.lang).toBe("fr");
	});
});
