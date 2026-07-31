import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiagnosticEvent } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { AppPaths } from "../../src/app-paths.ts";
import { TelemetryObservabilityLive } from "../../src/observability/telemetry-layer.ts";
import {
	TelemetryStore,
	TelemetryStoreLive,
} from "../../src/observability/telemetry-store.ts";
import { appendRelayDiagnostic } from "../../src/relay/relay-diagnostics.ts";

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
			const persisted = readFileSync(
				join(directory, "logs", "diagnostics.events.ndjson"),
				"utf8",
			);
			expect(persisted).toContain("Bearer [REDACTED]");
			expect(persisted).toContain("OPENAI_API_KEY=[REDACTED]");
			expect(persisted).not.toContain("secret-value");
			expect(persisted).not.toContain("another-secret");

			const reloaded = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(reloaded).toHaveLength(3);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("records completed Effect spans through the runtime tracer", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-tracer-"));
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
						return store.snapshot();
					}).pipe(Effect.provide(telemetryLayer)),
				),
			);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				message: "provider.send",
				category: "provider",
				providerId: "codex",
				sessionId: "session-1",
				severity: "info",
			});
			expect(events[0]?.detail).not.toContain("private");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("routes relay diagnostics through the bounded store without sensitive fields", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-relay-telemetry-"));
		const layer = TelemetryStoreLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
		);

		try {
			const events = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* TelemetryStore;
						yield* appendRelayDiagnostic(store, "link.environment.fail", {
							environmentId: "environment-1",
							reason: "Authorization: Bearer secret-value",
							relayUrl: "https://relay.example.test?token=private",
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
				source: "server.relay",
				category: "network",
				message: "relay.link.environment.fail",
			});
			expect(events[0]?.detail).toContain("environment-1");
			expect(events[0]?.detail).not.toContain("secret-value");
			expect(events[0]?.detail).not.toContain("relay.example.test");
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
						return store.snapshot();
					}).pipe(Effect.provide(layer)),
				),
			);
			expect(events.map((item) => item.id)).toContain("offline-crash");
			expect(() => readFileSync(offlinePath, "utf8")).toThrow();
			expect(
				readFileSync(join(logsDirectory, "diagnostics.events.ndjson"), "utf8"),
			).toContain("offline-crash");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
