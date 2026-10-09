import { FolderId, GitPrInfo } from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { Effect, Fiber, Layer, Stream } from "effect";
import { expect, test } from "vitest";
import {
	emptyPrSnapshot,
	GitPrMonitor,
	GitPrMonitorLive,
	prMonitorDelay,
} from "../../src/git/pr-monitor.ts";

const folder = FolderId.make("repo");
const pr = GitPrInfo.make({
	...emptyPrSnapshot("feature"),
	state: "open",
	number: 1,
	url: "https://github.com/acme/app/pull/1",
	mergeable: "clean",
	checks: "success",
	stale: false,
});
const layer = (prState: GitService["Service"]["prState"]) =>
	GitPrMonitorLive.pipe(
		Layer.provide(
			Layer.succeed(GitService, {
				prState,
				workspaceChanges: () => Stream.never,
			} as unknown as GitService["Service"]),
		),
	);

test("uses background and visible refresh intervals", () => {
	expect(prMonitorDelay(pr, false)).toBe(120_000);
	expect(prMonitorDelay(pr, true)).toBe(60_000);
	expect(prMonitorDelay({ ...pr, checks: "pending" }, true)).toBe(45_000);
	expect(prMonitorDelay({ ...pr, mergeable: "unknown" }, true)).toBe(45_000);
});

test("rate-limit pauses never count toward eight read failures; explicit refresh recovers", async () => {
	let value: GitPrInfo = {
		...pr,
		prCapability: "offline" as GitPrInfo["prCapability"],
		stale: true,
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			for (let i = 0; i < 7; i++) yield* monitor.refresh(folder, null);
			expect(monitor.snapshot(folder, null, "feature").monitoringPaused).toBe(
				false,
			);
			value = { ...value, prCapability: "rate_limited" };
			for (let i = 0; i < 3; i++) yield* monitor.refresh(folder, null);
			expect(monitor.snapshot(folder, null, "feature").monitoringPaused).toBe(
				false,
			);
			value = { ...value, prCapability: "offline" };
			yield* monitor.refresh(folder, null);
			expect(monitor.snapshot(folder, null, "feature").monitoringPaused).toBe(
				true,
			);
			value = { ...pr, prCapability: "available" };
			yield* monitor.refresh(folder, null, true);
			expect(monitor.snapshot(folder, null, "feature").monitoringPaused).toBe(
				false,
			);
			expect(monitor.snapshot(folder, null, "feature").stale).toBe(false);
		}).pipe(
			Effect.provide(layer(() => Effect.sync(() => GitPrInfo.make(value)))),
		),
	);
});

test("branch changes revoke a delayed observation's authority", async () => {
	let finish: (() => void) | undefined;
	let started = false;
	let value = pr;
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			yield* monitor.refresh(folder, null);
			const pending = yield* Effect.forkScoped(monitor.refresh(folder, null));
			while (!started) yield* Effect.yieldNow;
			expect(monitor.snapshot(folder, null, "other")).toMatchObject({
				state: "none",
				branch: "other",
				stale: true,
			});
			finish?.();
			yield* Fiber.join(pending);
			expect(monitor.snapshot(folder, null, "other").state).toBe("none");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				layer(() =>
					Effect.promise(async () => {
						if (value.state === "open") {
							value = { ...value, state: "closed" };
							return pr;
						}
						started = true;
						await new Promise<void>((resolve) => {
							finish = resolve;
						});
						return pr;
					}),
				),
			),
		),
	);
});

test("snapshot reads never perform GitHub polling", async () => {
	let reads = 0;
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			for (let i = 0; i < 100; i++) monitor.snapshot(folder, null, "feature");
			expect(reads).toBe(0);
			yield* monitor.refresh(folder, null);
			expect(reads).toBe(1);
		}).pipe(
			Effect.provide(
				layer(() =>
					Effect.sync(() => {
						reads++;
						return pr;
					}),
				),
			),
		),
	);
});

test("duplicate subscribers share observation and shutdown interrupts the active read", async () => {
	let reads = 0;
	let stopped = false;
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			yield* Effect.forkScoped(
				Stream.runDrain(monitor.changes(folder, null, true)),
			);
			yield* Effect.forkScoped(
				Stream.runDrain(monitor.changes(folder, null, true)),
			);
			while (!reads) yield* Effect.yieldNow;
			yield* Effect.sleep("20 millis");
			expect(reads).toBe(1);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				layer(() =>
					Effect.sync(() => {
						reads++;
					}).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(
							Effect.sync(() => {
								stopped = true;
							}),
						),
					),
				),
			),
		),
	);
	expect(stopped).toBe(true);
});

test("members monitoring the same checkout have independent status authority", async () => {
	const { GitHubRequestScope } = await import("@zuse/git/github-client");
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			yield* monitor.refresh(folder, null).pipe(
				Effect.provideService(GitHubRequestScope, {
					key: "member-a",
					body: "{}",
				}),
			);
			expect(monitor.snapshot(folder, null, "feature", "member-a").state).toBe(
				"open",
			);
			expect(monitor.snapshot(folder, null, "feature", "member-b").state).toBe(
				"none",
			);
		}).pipe(Effect.provide(layer(() => Effect.succeed(pr)))),
	);
});

test("initial thrown errors survive snapshot reads and pause after eight failures", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const monitor = yield* GitPrMonitor;
			for (let i = 0; i < 8; i++) {
				yield* monitor.refresh(folder, null);
				expect(monitor.snapshot(folder, null, "feature")).toMatchObject({
					branch: "feature",
					prCapability: "unknown",
					stale: true,
					monitoringPaused: i === 7,
				});
			}
			expect(monitor.snapshot(folder, null, "other")).toMatchObject({
				branch: "other",
				prCapability: "available",
			});
		}).pipe(
			Effect.provide(
				layer(
					() =>
						Effect.fail(new Error("Git failed")) as unknown as ReturnType<
							GitService["Service"]["prState"]
						>,
				),
			),
		),
	);
});
