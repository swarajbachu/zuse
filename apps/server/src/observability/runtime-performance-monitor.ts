import {
	monitorEventLoopDelay,
	type PerformanceEntry,
	PerformanceObserver,
} from "node:perf_hooks";
import { Effect, Layer } from "effect";

import { diagnosticFingerprint } from "../diagnostics/diagnostics-model.ts";
import { TelemetryStore } from "./telemetry-store.ts";

const event = (
	store: TelemetryStore["Service"],
	input: {
		readonly kind: "event-loop" | "gc";
		readonly durationMs: number;
		readonly severity: "warn" | "error";
	},
) => {
	const source = "server.performance";
	const message =
		input.kind === "event-loop"
			? "Sustained server event-loop lag"
			: "Long server garbage-collection pause";
	store.record({
		id: `server_perf_${input.kind}_${Date.now().toString(36)}`,
		createdAt: new Date().toISOString(),
		severity: input.severity,
		source,
		category: "performance",
		message,
		detail: `kind=${input.kind} durationMs=${input.durationMs.toFixed(1)}`,
		fingerprint: diagnosticFingerprint({
			source,
			category: "performance",
			message,
		}),
		runId: store.runId,
		recoveryStatus: "unresolved",
		durationMs: input.durationMs,
	});
};

export const RuntimePerformanceMonitorLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const telemetry = yield* TelemetryStore;
		const delay = monitorEventLoopDelay({ resolution: 20 });
		delay.enable();
		let consecutiveLagSamples = 0;
		const timer = setInterval(() => {
			const p99Ms = delay.percentile(99) / 1_000_000;
			delay.reset();
			consecutiveLagSamples = p99Ms >= 100 ? consecutiveLagSamples + 1 : 0;
			if (consecutiveLagSamples < 3) return;
			event(telemetry, {
				kind: "event-loop",
				durationMs: p99Ms,
				severity: p99Ms >= 500 ? "error" : "warn",
			});
			consecutiveLagSamples = 0;
		}, 5_000);
		timer.unref?.();

		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as PerformanceEntry[]) {
				if (entry.duration < 100) continue;
				event(telemetry, {
					kind: "gc",
					durationMs: entry.duration,
					severity: entry.duration >= 500 ? "error" : "warn",
				});
			}
		});
		try {
			observer.observe({ entryTypes: ["gc"] });
		} catch {
			// Older runtimes may not expose GC performance entries.
		}

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				clearInterval(timer);
				delay.disable();
				observer.disconnect();
			}),
		);
	}),
);
