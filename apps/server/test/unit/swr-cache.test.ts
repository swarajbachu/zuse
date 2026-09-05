import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Option, Schema, type Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeSwrCache, type SwrLoadResult } from "../../src/cache/swr-cache.ts";

const Doc = Schema.Struct({ n: Schema.Number });
type Doc = typeof Doc.Type;

const scoped = <A>(program: Effect.Effect<A, unknown, Scope.Scope>) =>
	Effect.runPromise(Effect.scoped(program) as Effect.Effect<A, unknown>);

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "swr-cache-"));
	tmpDirs.push(dir);
	return dir;
};

describe("makeSwrCache", () => {
	it("returns nothing before the first load and refreshes on demand", async () => {
		let now = 1_000;
		let loads = 0;
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "t",
					ttlMs: 100,
					now: () => now,
					load: () =>
						Effect.sync((): SwrLoadResult<Doc> => {
							loads += 1;
							return { _tag: "value", value: { n: loads } };
						}),
				});
				expect(Option.isNone(yield* cache.get())).toBe(true);
				const entry = yield* cache.refresh();
				expect(entry.value).toEqual({ n: 1 });
				expect(entry.storedAt).toBe(1_000);
				expect(yield* cache.isStale()).toBe(false);
				now = 1_050;
				expect(Option.getOrThrow(yield* cache.get()).value).toEqual({ n: 1 });
				now = 1_200;
				expect(yield* cache.isStale()).toBe(true);
				const refreshed = yield* cache.refresh();
				expect(refreshed.value).toEqual({ n: 2 });
			}),
		);
		expect(loads).toBe(2);
	});

	it("forks a background refresh when a read finds a stale entry", async () => {
		let now = 0;
		let loads = 0;
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "bg",
					ttlMs: 10,
					now: () => now,
					load: () =>
						Effect.sync((): SwrLoadResult<Doc> => {
							loads += 1;
							return { _tag: "value", value: { n: loads } };
						}),
				});
				yield* cache.refresh();
				now = 100;
				// Stale read: serves the old value immediately …
				expect(Option.getOrThrow(yield* cache.get()).value).toEqual({ n: 1 });
				// … and the forked refresh lands shortly after.
				yield* Effect.sleep("10 millis");
				expect(Option.getOrThrow(yield* cache.get()).value).toEqual({ n: 2 });
			}),
		);
		expect(loads).toBe(2);
	});

	it("marks entries stale when the fingerprint changes", async () => {
		await scoped(
			Effect.gen(function* () {
				let n = 0;
				const cache = yield* makeSwrCache<Doc, never>({
					name: "fp",
					ttlMs: 10_000,
					load: () =>
						Effect.sync(
							(): SwrLoadResult<Doc> => ({
								_tag: "value",
								value: { n: ++n },
							}),
						),
				});
				yield* cache.refresh("cli-1");
				expect(yield* cache.isStale("cli-1")).toBe(false);
				expect(yield* cache.isStale("cli-2")).toBe(true);
			}),
		);
	});

	it("keeps the last value on failure and remembers the error briefly", async () => {
		let now = 0;
		let fail = false;
		let loads = 0;
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, Error>({
					name: "err",
					ttlMs: 10,
					errorTtlMs: 100,
					now: () => now,
					load: () =>
						Effect.suspend(() => {
							loads += 1;
							return fail
								? Effect.fail(new Error("boom"))
								: Effect.succeed<SwrLoadResult<Doc>>({
										_tag: "value",
										value: { n: loads },
									});
						}),
				});
				yield* cache.refresh();
				fail = true;
				now = 50;
				const exit = yield* Effect.exit(cache.refresh());
				expect(Exit.isFailure(exit)).toBe(true);
				const state = yield* cache.state();
				expect(state.entry?.value).toEqual({ n: 1 });
				expect(state.lastError?.message).toBe("boom");
				// Stale + recent error: get() serves the old value and does not reload.
				const held = yield* cache.get();
				expect(Option.getOrThrow(held).value).toEqual({ n: 1 });
				yield* Effect.sleep("5 millis");
				expect(loads).toBe(2);
			}),
		);
	});

	it("shares one in-flight load between concurrent refreshes", async () => {
		let loads = 0;
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "single",
					ttlMs: 10_000,
					load: () =>
						Effect.sleep("20 millis").pipe(
							Effect.map((): SwrLoadResult<Doc> => {
								loads += 1;
								return { _tag: "value", value: { n: loads } };
							}),
						),
				});
				const [a, b] = yield* Effect.all([cache.refresh(), cache.refresh()], {
					concurrency: "unbounded",
				});
				expect(a.value).toEqual(b.value);
			}),
		);
		expect(loads).toBe(1);
	});

	it("persists to disk, restores on construction, and drops corrupt files", async () => {
		const dir = tmp();
		const path = join(dir, "doc.json");
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "disk",
					ttlMs: 10_000,
					persist: { path, schema: Doc },
					load: () =>
						Effect.succeed<SwrLoadResult<Doc>>({
							_tag: "value",
							value: { n: 7 },
							etag: 'W/"7"',
						}),
				});
				yield* cache.refresh("fp");
			}),
		);
		const envelope = JSON.parse(readFileSync(path, "utf8"));
		expect(envelope.value).toEqual({ n: 7 });
		expect(envelope.etag).toBe('W/"7"');
		expect(envelope.fingerprint).toBe("fp");

		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "disk",
					ttlMs: 10_000,
					persist: { path, schema: Doc },
					load: () => Effect.die("must not load"),
				});
				const held = yield* cache.get("fp");
				expect(Option.getOrThrow(held).value).toEqual({ n: 7 });
				expect(Option.getOrThrow(held).etag).toBe('W/"7"');
			}),
		);

		writeFileSync(path, "{not json");
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "disk",
					ttlMs: 10_000,
					persist: { path, schema: Doc },
					load: () =>
						Effect.succeed<SwrLoadResult<Doc>>({
							_tag: "value",
							value: { n: 1 },
						}),
				});
				expect(
					Option.isNone(
						yield* cache
							.state()
							.pipe(Effect.map((s) => Option.fromNullOr(s.entry))),
					),
				).toBe(true);
			}),
		);
	});

	it("honours notModified by keeping the value and bumping storedAt", async () => {
		let now = 0;
		let first = true;
		await scoped(
			Effect.gen(function* () {
				const cache = yield* makeSwrCache<Doc, never>({
					name: "304",
					ttlMs: 10,
					now: () => now,
					load: ({ previous }) =>
						Effect.sync((): SwrLoadResult<Doc> => {
							if (first) {
								first = false;
								return { _tag: "value", value: { n: 3 }, etag: "e" };
							}
							expect(previous?.etag).toBe("e");
							return { _tag: "notModified" };
						}),
				});
				yield* cache.refresh();
				now = 50;
				const entry = yield* cache.refresh();
				expect(entry.value).toEqual({ n: 3 });
				expect(entry.storedAt).toBe(50);
				expect(entry.etag).toBe("e");
			}),
		);
	});
});
