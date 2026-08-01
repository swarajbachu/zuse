import type { LagKind, LagSample } from "@zuse/contracts";
import {
	createFallbackStallAttribution,
	createLongAnimationFrameSample,
	type LongAnimationFrameEntry,
} from "./stall-attribution.ts";
import type { StallContext } from "./stall-context.ts";

export interface RendererLagInput {
	readonly kind: LagKind;
	readonly durationMs: number;
	readonly visible: boolean;
	readonly name?: string;
	readonly now?: () => string;
	readonly id?: () => string;
}

export function createRendererLagSample(
	input: RendererLagInput,
	context?: StallContext,
): LagSample | null {
	if (!input.visible || !Number.isFinite(input.durationMs)) return null;
	if (input.durationMs < 100) return null;
	const durationMs = Math.min(
		60_000,
		Math.round(Math.max(0, input.durationMs) * 10) / 10,
	);
	return {
		id:
			input.id?.() ??
			`lag_${Date.now().toString(36)}_${crypto.randomUUID?.().slice(0, 8) ?? "renderer"}`,
		capturedAt: input.now?.() ?? new Date().toISOString(),
		kind: input.kind,
		durationMs,
		source: "renderer",
		name: `renderer.${input.kind}`,
		...(context === undefined
			? {}
			: {
					attribution: createFallbackStallAttribution(
						input.kind,
						input.name,
						context,
					),
				}),
	};
}

export function installRendererLagMonitor(
	report: (samples: ReadonlyArray<LagSample>) => void,
	readContext: () => StallContext,
): () => void {
	const observers: PerformanceObserver[] = [];
	const queued: LagSample[] = [];
	let flushTimer: number | null = null;
	let disposed = false;

	const flush = () => {
		flushTimer = null;
		if (queued.length === 0 || disposed) return;
		report(queued.splice(0, queued.length));
	};
	const enqueue = (sample: LagSample | null) => {
		if (sample === null || disposed) return;
		queued.push(sample);
		if (queued.length >= 20) {
			flush();
			return;
		}
		if (flushTimer === null) flushTimer = window.setTimeout(flush, 250);
	};
	const visible = () => document.visibilityState === "visible";
	let visibilityGeneration = 0;
	const onVisibilityChange = () => {
		visibilityGeneration += 1;
	};
	document.addEventListener("visibilitychange", onVisibilityChange);

	if (typeof PerformanceObserver !== "undefined") {
		const supported = PerformanceObserver.supportedEntryTypes ?? [];
		const supportsLongAnimationFrame = supported.includes(
			"long-animation-frame",
		);
		if (supportsLongAnimationFrame) {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					enqueue(
						createLongAnimationFrameSample(
							entry as unknown as LongAnimationFrameEntry,
							readContext(),
						),
					);
				}
			});
			observer.observe({ type: "long-animation-frame", buffered: true });
			observers.push(observer);
		}
		if (!supportsLongAnimationFrame && supported.includes("longtask")) {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					enqueue(
						createRendererLagSample(
							{
								kind: "long-task",
								durationMs: entry.duration,
								visible: visible(),
							},
							readContext(),
						),
					);
				}
			});
			observer.observe({ entryTypes: ["longtask"] });
			observers.push(observer);
		}
		if (supported.includes("event")) {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					enqueue(
						createRendererLagSample(
							{
								kind: "input-latency",
								durationMs: entry.duration,
								visible: visible(),
							},
							readContext(),
						),
					);
				}
			});
			observer.observe({ type: "event", buffered: true });
			observers.push(observer);
		}
	}

	const supportsLongAnimationFrame =
		typeof PerformanceObserver !== "undefined" &&
		(PerformanceObserver.supportedEntryTypes?.includes(
			"long-animation-frame",
		) ??
			false);
	let animationFrame: number | null = null;
	let animationProbeTimer: number | null = null;
	const scheduleAnimationProbe = () => {
		animationProbeTimer = window.setTimeout(() => {
			animationProbeTimer = null;
			if (disposed) return;
			if (!visible()) {
				scheduleAnimationProbe();
				return;
			}
			const requestedAt = performance.now();
			const requestedGeneration = visibilityGeneration;
			animationFrame = requestAnimationFrame((timestamp) => {
				animationFrame = null;
				enqueue(
					createRendererLagSample(
						{
							kind: "animation-stall",
							durationMs: timestamp - requestedAt,
							visible:
								visible() && requestedGeneration === visibilityGeneration,
						},
						readContext(),
					),
				);
				scheduleAnimationProbe();
			});
		}, 1_000);
	};
	if (!supportsLongAnimationFrame) scheduleAnimationProbe();

	return () => {
		disposed = true;
		if (flushTimer !== null) window.clearTimeout(flushTimer);
		if (animationProbeTimer !== null) window.clearTimeout(animationProbeTimer);
		if (animationFrame !== null) cancelAnimationFrame(animationFrame);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		for (const observer of observers) observer.disconnect();
	};
}
