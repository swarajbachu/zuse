import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiagnosticEvent } from "@zuse/contracts";
import { Cause, Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendApiDiagnostic } from "../../src/api/api-diagnostics.ts";
import { AppPaths } from "../../src/app-paths.ts";
import { TelemetryObservabilityLive } from "../../src/observability/telemetry-layer.ts";
import {
	legacyMigrationSource,
	shouldPersistOperationEvent,
	TelemetryStore,
	TelemetryStoreLive,
	telemetryFileIdentity,
} from "../../src/observability/telemetry-store.ts";

const event = (id: string): DiagnosticEvent => ({
	id,
	createdAt: new Date().toISOString(),
	severity: "error",
	source: "server.provider",
	category: "provider",
	message: "Authorization: Bearer secret-value",
	detail: "OPENAI_API_KEY=another-secret",
	fingerprint: "will-be-replaced",
	runId: "run-test",
	recoveryStatus: "unresolved",
});

const eventFile = (directory: string, kind = "desktop") =>
	join(
		directory,
		"logs",
		readdirSync(join(directory, "logs")).find((name) =>
			name.startsWith(`diagnostics.events.${kind}-`),
		) ?? "missing",
	);

afterEach(() => vi.useRealTimers());

describe("telemetry store", () => {
	it("serializes concurrent records, persists redacted data, and reloads it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-telemetry-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const snapshot = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						store.record(event("span-1"));
						store.recordMany([event("span-2"), event("span-3")]);
						yield* store.flush;
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);

			expect(snapshot).toHaveLength(3);
			const persisted = readFileSync(eventFile(directory), "utf8");
			expect(persisted).toContain("Bearer [REDACTED]");
			expect(persisted).toContain("OPENAI_API_KEY=[REDACTED]");
			expect(persisted).not.toContain("secret-value");
			expect(persisted).not.toContain("another-secret");

			const reloaded = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("50 millis");
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(reloaded).toHaveLength(3);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("aggregates fast successful spans without retaining individual events", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-tracer-"));
		const storeLayer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		const telemetryLayer = TelemetryObservabilityLive.pipe(
			Layer.provideMerge(storeLayer),
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Effect.succeed("ok").pipe(
							Effect.withSpan("provider.send", {
								attributes: {
									"provider.id": "codex",
									"session.id": "session-1",
									prompt: "private",
								},
							}),
						);
						const store = yield* TelemetryStore;
						yield* store.flush;
						return {
							events: store.snapshot(),
							operations: store.operationSummaries(),
						};
					}).pipe(Effect.provide(telemetryLayer)),
				),
			);

			expect(result.events).toHaveLength(0);
			expect(result.operations).toContainEqual(
				expect.objectContaining({ name: "provider.send", count: 1 }),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("treats Effect stream completion as a successful aggregate", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-done-span-"));
		const storeLayer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		const telemetryLayer = TelemetryObservabilityLive.pipe(
			Layer.provideMerge(storeLayer),
		);
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Cause.done().pipe(
							Effect.withSpan("provider.stream"),
							Effect.exit,
						);
						const store = yield* TelemetryStore;
						return {
							events: store.snapshot(),
							operations: store.operationSummaries(),
						};
					}).pipe(Effect.provide(telemetryLayer)),
				),
			);
			expect(result.events).toHaveLength(0);
			expect(result.operations).toContainEqual(
				expect.objectContaining({
					name: "provider.stream",
					count: 1,
					failureCount: 0,
				}),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retains failing and interrupted Effect spans as incidents", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-incident-span-"));
		const storeLayer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		const telemetryLayer = TelemetryObservabilityLive.pipe(
			Layer.provideMerge(storeLayer),
		);
		try {
			const events = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Effect.fail("unavailable").pipe(
							Effect.withSpan("provider.failure"),
							Effect.exit,
						);
						yield* Effect.interrupt.pipe(
							Effect.withSpan("provider.interrupted"),
							Effect.exit,
						);
						const store = yield* TelemetryStore;
						return store.snapshot();
					}).pipe(Effect.provide(telemetryLayer)),
				),
			);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						message: "provider.failure",
						severity: "error",
					}),
					expect.objectContaining({
						message: "provider.interrupted",
						severity: "warn",
					}),
				]),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("routes api diagnostics through the bounded store without sensitive fields", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-api-telemetry-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const events = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* appendApiDiagnostic(store, "link.environment.fail", {
							environmentId: "environment-1",
							reason: "Authorization: Bearer secret-value",
							apiUrl: "https://api.example.test?token=private",
							candidate: "/Users/private/bin",
						});
						yield* store.flush;
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				severity: "error",
				source: "server.api",
				category: "network",
				message: "api.link.environment.fail",
			});
			expect(events[0]?.detail).toContain("environment-1");
			expect(events[0]?.detail).not.toContain("secret-value");
			expect(events[0]?.detail).not.toContain("api.example.test");
			expect(events[0]?.detail).not.toContain("/Users/private");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recovers valid events when a persisted NDJSON line is corrupt", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-telemetry-recovery-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		writeFileSync(
			join(logsDirectory, "diagnostics.events.ndjson"),
			`${JSON.stringify(event("span-valid"))}\n{not-json}\n`,
		);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("50 millis");
						return {
							events: store.snapshot(),
							parseErrors: store.parseErrorCount,
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.id).toBe("span-valid");
			expect(result.parseErrors).toBe(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("imports offline desktop crashes into durable telemetry", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-offline-crash-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const offlinePath = join(logsDirectory, "diagnostics.offline.ndjson");
		writeFileSync(offlinePath, `${JSON.stringify(event("offline-crash"))}\n`);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const events = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("50 millis");
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(events.map((item) => item.id)).toContain("offline-crash");
			expect(() => readFileSync(offlinePath, "utf8")).toThrow();
			expect(readFileSync(eventFile(directory), "utf8")).toContain(
				"offline-crash",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("stream-migrates legacy logs without retaining routine trace noise", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-legacy-migration-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const routine = {
			...event("routine"),
			severity: "info" as const,
			message: "sql.execute",
			durationMs: 4,
		};
		writeFileSync(
			join(logsDirectory, "diagnostics.events.ndjson"),
			`${JSON.stringify(routine)}\n${JSON.stringify({
				...event("incident"),
				message: "provider.send",
				durationMs: 12,
			})}\n`,
		);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("100 millis");
						yield* store.flush;
						return {
							events: store.snapshot(),
							operations: store.operationSummaries(),
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(result.events.map((item) => item.id)).toEqual(["incident"]);
			expect(result.operations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "sql.execute", count: 1 }),
					expect.objectContaining({ name: "provider.send", count: 1 }),
				]),
			);
			expect(() =>
				readFileSync(join(logsDirectory, "diagnostics.events.ndjson"), "utf8"),
			).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("resumes legacy migration without duplicating persisted incidents or rollups", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-legacy-resume-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const createdAt = new Date().toISOString();
		const routine = {
			...event("routine-resume"),
			createdAt,
			severity: "info" as const,
			message: "sql.execute",
			durationMs: 4,
		};
		const incident = {
			...event("incident-resume"),
			createdAt,
			message: "provider.send",
			durationMs: 12,
		};
		const migratingPath = join(
			logsDirectory,
			"diagnostics.events.ndjson.migrating",
		);
		writeFileSync(
			migratingPath,
			`${JSON.stringify(routine)}\n${JSON.stringify(incident)}\n`,
		);
		const migratingStat = statSync(migratingPath);
		const migrationSource = legacyMigrationSource(
			migratingPath,
			migratingStat.size,
			migratingStat.mtimeMs,
		);
		const bucketStart =
			Math.floor(Date.parse(createdAt) / (5 * 60_000)) * (5 * 60_000);
		const operation = (durationMs: number) => ({
			count: 1,
			failureCount: 0,
			totalDurationMs: durationMs,
			maxDurationMs: durationMs,
			durationBuckets: [0, 1],
		});
		writeFileSync(
			join(
				logsDirectory,
				`diagnostics.rollups.${telemetryFileIdentity("desktop", "local")}.ndjson`,
			),
			`${JSON.stringify({
				bucketStart,
				migrationSource,
				operations: {
					"sql.execute": operation(4),
					"provider.send": operation(12),
				},
			})}\n`,
		);
		writeFileSync(
			join(
				logsDirectory,
				`diagnostics.events.${telemetryFileIdentity("desktop", "local")}.ndjson`,
			),
			[
				{
					...incident,
					runtimeKind: "desktop",
					captureMode: "incident",
				},
				...Array.from({ length: 5_001 }, (_, index) => ({
					...event(`persisted-${index}`),
					createdAt,
				})),
			]
				.map((item) => JSON.stringify(item))
				.join("\n"),
		);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						for (let attempt = 0; attempt < 150; attempt += 1) {
							if (!existsSync(migratingPath)) break;
							yield* Effect.sleep("20 millis");
						}
						yield* store.flush;
						return {
							events: store.snapshot(),
							exported: yield* store.exportEvents({}),
							operations: store.operationSummaries(),
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(
				result.exported.events.filter((item) => item.id === "incident-resume"),
			).toHaveLength(1);
			expect(result.events.some((item) => item.id === "incident-resume")).toBe(
				false,
			);
			expect(result.events.at(-1)?.id).toBe("persisted-5000");
			expect(result.operations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "sql.execute", count: 1 }),
					expect.objectContaining({ name: "provider.send", count: 1 }),
				]),
			);
			expect(existsSync(migratingPath)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("prunes identity-scoped incident files older than seven days", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-telemetry-retention-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const path = join(
			logsDirectory,
			`diagnostics.events.${telemetryFileIdentity("desktop", "local")}.ndjson`,
		);
		writeFileSync(path, `${JSON.stringify(event("expired"))}\n`);
		const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
		utimesSync(path, expiredAt, expiredAt);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			const events = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("10 millis");
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(events).toHaveLength(0);
			expect(existsSync(path)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("prunes expired events inside active incident and full-trace files", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-event-retention-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const suffix = telemetryFileIdentity("desktop", "local");
		const incidentPath = join(
			logsDirectory,
			`diagnostics.events.${suffix}.ndjson`,
		);
		const fullPath = join(
			logsDirectory,
			`diagnostics.full-trace.${suffix}.ndjson`,
		);
		const expired = {
			...event("expired-mixed"),
			createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
		};
		const recent = event("recent-mixed");
		writeFileSync(
			incidentPath,
			`${JSON.stringify(expired)}\n${JSON.stringify(recent)}\n`,
		);
		writeFileSync(fullPath, `${JSON.stringify(expired)}\n`);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* Effect.sleep("100 millis");
						yield* store.flush;
						return {
							events: store.snapshot(),
							exported: yield* store.exportEvents({}),
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(result.events.map((item) => item.id)).toEqual(["recent-mixed"]);
			expect(result.exported.events.map((item) => item.id)).toEqual([
				"recent-mixed",
			]);
			expect(readFileSync(incidentPath, "utf8")).not.toContain("expired-mixed");
			expect(existsSync(fullPath)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps policy incidents and ignores normal stream completion", () => {
		expect(
			shouldPersistOperationEvent(
				{ name: "fast", outcome: "success", durationMs: 20 },
				"incident",
			),
		).toBe(false);
		expect(
			shouldPersistOperationEvent(
				{ name: "slow", outcome: "success", durationMs: 1_000 },
				"incident",
			),
		).toBe(true);
		expect(
			shouldPersistOperationEvent(
				{ name: "failed", outcome: "failure", durationMs: 1 },
				"incident",
			),
		).toBe(true);
		expect(
			shouldPersistOperationEvent(
				{ name: "stream", outcome: "done", durationMs: 60_000 },
				"incident",
			),
		).toBe(false);
	});

	it("keeps long-operation p95 distinct from the maximum", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-long-p95-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			const summary = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						for (let index = 0; index < 95; index += 1) {
							store.recordOperation({
								name: "provider.long",
								outcome: "success",
								durationMs: 40_000,
							});
						}
						for (let index = 0; index < 5; index += 1) {
							store.recordOperation({
								name: "provider.long",
								outcome: "success",
								durationMs: 120_000,
							});
						}
						return store.operationSummaries()[0];
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(summary).toMatchObject({
				name: "provider.long",
				count: 100,
				p95DurationMs: 60_000,
				maxDurationMs: 120_000,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("bounds 100,000 routine operations in aggregate rollups", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-telemetry-stress-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						for (let index = 0; index < 100_000; index += 1) {
							store.recordOperation({
								name: "sql.execute",
								outcome: "success",
								durationMs: 2,
							});
						}
						return {
							events: store.snapshot(),
							operations: store.operationSummaries(),
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(result.events).toHaveLength(0);
			expect(result.operations[0]).toMatchObject({
				name: "sql.execute",
				count: 100_000,
			});
			const files = readdirSync(join(directory, "logs"));
			expect(files.some((name) => name.startsWith("diagnostics.events."))).toBe(
				false,
			);
			const rollup = files.find((name) =>
				name.startsWith("diagnostics.rollups."),
			);
			expect(rollup).toBeDefined();
			expect(
				statSync(join(directory, "logs", rollup ?? "missing")).size,
			).toBeLessThan(32 * 1024 * 1024);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("persists a completed five-minute rollup without a later operation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
		const directory = mkdtempSync(join(tmpdir(), "zuse-rollup-boundary-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						store.recordOperation({
							name: "session.reconcile",
							outcome: "success",
							durationMs: 8,
						});
						vi.advanceTimersByTime(5 * 60_000 + 1);
						yield* store.flush;
					}).pipe(Effect.provide(layer)),
				),
			);
			const rollup = readdirSync(join(directory, "logs")).find((name) =>
				name.startsWith("diagnostics.rollups.desktop-"),
			);
			expect(rollup).toBeDefined();
			expect(
				readFileSync(join(directory, "logs", rollup ?? "missing"), "utf8"),
			).toContain("session.reconcile");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("expires and overwrites a bounded full trace", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
		const directory = mkdtempSync(join(tmpdir(), "zuse-full-trace-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* store.setCapture({ mode: "full", durationMinutes: 5 });
						for (let index = 0; index < 21_000; index += 1) {
							store.record({
								...event(`routine-${index}`),
								severity: "info",
								durationMs: 5,
							});
						}
						yield* store.flush;
						const count = store.snapshot().length;
						vi.setSystemTime(new Date("2026-08-03T00:05:01.000Z"));
						return {
							count,
							capture: store.captureState(),
							dropped: store.droppedEventCount(),
							truncated: store.truncatedEventCount(),
						};
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(result.count).toBe(20_000);
			expect(result.capture.captureMode).toBe("incident");
			expect(result.dropped).toBeGreaterThan(0);
			expect(result.truncated).toBe(1_000);
			const fullFile = join(
				directory,
				"logs",
				readdirSync(join(directory, "logs")).find((name) =>
					name.startsWith("diagnostics.full-trace."),
				) ?? "missing",
			);
			expect(statSync(fullFile).size).toBeLessThanOrEqual(10 * 1024 * 1024);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses independent hashed files for desktop and Serve writers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-runtime-identity-"));
		try {
			await Promise.all(
				[
					{ kind: "desktop" as const, instance: "local" },
					{ kind: "serve" as const, instance: "127.0.0.1:4321" },
				].map((telemetryIdentity) => {
					const layer = TelemetryStoreLive.pipe(
						Layer.provide(
							Layer.succeed(AppPaths, {
								userData: directory,
								telemetryIdentity,
							}),
						),
					);
					return Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const store = yield* TelemetryStore;
								store.record(event(telemetryIdentity.kind));
								yield* store.flush;
							}).pipe(Effect.provide(layer)),
						),
					);
				}),
			);
			const names = readdirSync(join(directory, "logs"));
			expect(
				names.some((name) => name.startsWith("diagnostics.events.desktop-")),
			).toBe(true);
			expect(
				names.some((name) => name.startsWith("diagnostics.events.serve-")),
			).toBe(true);
			expect(names.join(" ")).not.toContain("127.0.0.1");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("exports only the 25,000 newest relevant events with truncation metadata", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-export-bound-"));
		const logsDirectory = join(directory, "logs");
		mkdirSync(logsDirectory, { recursive: true });
		const path = join(
			logsDirectory,
			`diagnostics.events.${telemetryFileIdentity("desktop", "local")}.ndjson`,
		);
		const start = Date.now() - 25_100;
		writeFileSync(
			path,
			Array.from({ length: 25_100 }, (_, index) =>
				JSON.stringify({
					...event(`export-${index}`),
					createdAt: new Date(start + index).toISOString(),
				}),
			).join("\n"),
		);
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);
		try {
			const exported = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						return yield* store.exportEvents({});
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(exported.events).toHaveLength(25_000);
			expect(exported.truncated).toBe(100);
			expect(exported.events[0]?.id).toBe("export-100");
			expect(exported.events.at(-1)?.id).toBe("export-25099");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
