import { Cause, Duration, Effect, Exit, Layer, Option, Tracer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
	OtlpExporter,
	OtlpMetrics,
	OtlpSerialization,
	OtlpTracer,
} from "effect/unstable/observability";
import { sanitizeDiagnosticText } from "../diagnostics/diagnostics-model.ts";
import { recordOperationMetrics } from "./telemetry-metrics.ts";
import {
	filterTelemetryAttributes,
	telemetryCategoryForSpan,
	telemetryCauseSummary,
	telemetryEventFromSpan,
} from "./telemetry-model.ts";
import { TelemetryStore } from "./telemetry-store.ts";

const TRACE_URL = (process.env.ZUSE_OTLP_TRACES_URL ?? "").trim();
const METRICS_URL = (process.env.ZUSE_OTLP_METRICS_URL ?? "").trim();
const SERVICE_NAME =
	(process.env.ZUSE_OTLP_SERVICE_NAME ?? "").trim() || "zuse-server";
const EXPORT_INTERVAL_MS = Math.max(
	1_000,
	Number(process.env.ZUSE_OTLP_EXPORT_INTERVAL_MS) || 10_000,
);

const shouldRecordLocally = (name: string): boolean =>
	!name.startsWith("RpcServer.diagnostics.") &&
	!name.startsWith("RpcClient.diagnostics.");

class TelemetrySpan implements Tracer.Span {
	readonly _tag = "Span";
	readonly name: string;
	readonly spanId: string;
	readonly traceId: string;
	readonly parent: Option.Option<Tracer.AnySpan>;
	readonly annotations: Tracer.Span["annotations"];
	readonly links: Array<Tracer.SpanLink>;
	readonly sampled: boolean;
	readonly kind: Tracer.SpanKind;

	status: Tracer.SpanStatus;
	attributes = new Map<string, unknown>();
	events: Array<readonly [string, bigint, Record<string, unknown>]> = [];

	constructor(
		private readonly options: Parameters<Tracer.Tracer["span"]>[0],
		private readonly delegate: Tracer.Span,
		private readonly store: TelemetryStore["Service"],
	) {
		this.name = delegate.name;
		this.spanId = delegate.spanId;
		this.traceId = delegate.traceId;
		this.parent = options.parent;
		this.annotations = options.annotations;
		this.links = [...options.links];
		this.sampled = delegate.sampled;
		this.kind = delegate.kind;
		this.status = { _tag: "Started", startTime: options.startTime };
	}

	end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
		const failure = Exit.isFailure(exit)
			? Cause.findErrorOption(exit.cause)
			: undefined;
		const normalStreamCompletion =
			failure !== undefined &&
			Option.isSome(failure) &&
			Cause.isDone(failure.value);
		const diagnosticExit = normalStreamCompletion
			? Exit.succeed(undefined)
			: exit;
		this.status = {
			_tag: "Ended",
			startTime: this.options.startTime,
			endTime,
			exit: diagnosticExit,
		};
		this.delegate.end(
			endTime,
			Exit.isSuccess(diagnosticExit)
				? diagnosticExit
				: Exit.fail(telemetryCauseSummary(diagnosticExit.cause).type),
		);
		const durationMs =
			Number(
				endTime > this.options.startTime
					? endTime - this.options.startTime
					: 0n,
			) / 1_000_000;
		const outcome = normalStreamCompletion
			? "done"
			: Exit.isSuccess(exit)
				? "success"
				: Cause.hasInterruptsOnly(exit.cause)
					? "interrupted"
					: "failure";
		recordOperationMetrics({
			operation: this.name,
			category: telemetryCategoryForSpan(this.name),
			outcome: outcome === "done" ? "success" : outcome,
			durationMs,
			context: this.annotations,
		});
		const operation = { name: this.name, outcome, durationMs } as const;
		this.store.recordOperation(operation);
		if (!this.sampled || !shouldRecordLocally(this.name)) return;
		if (!this.store.shouldRecordOperation(operation)) return;
		this.store.record(
			telemetryEventFromSpan({
				name: this.name,
				traceId: this.traceId,
				spanId: this.spanId,
				startTime: this.options.startTime,
				endTime,
				exit: diagnosticExit,
				attributes: this.attributes,
				runId: this.store.runId,
			}),
		);
	}

	attribute(key: string, value: unknown): void {
		const allowed = filterTelemetryAttributes({ [key]: value });
		if (!(key in allowed)) return;
		this.attributes.set(key, allowed[key]);
		this.delegate.attribute(key, allowed[key]);
	}

	event(
		name: string,
		startTime: bigint,
		attributes: Record<string, unknown> = {},
	): void {
		const safeName = sanitizeDiagnosticText(name);
		const safeAttributes = filterTelemetryAttributes(attributes);
		this.events.push([safeName, startTime, safeAttributes]);
		this.delegate.event(safeName, startTime, safeAttributes);
	}

	addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
		const safeLinks = links.map((link) => ({
			...link,
			attributes: filterTelemetryAttributes(link.attributes),
		}));
		this.links.push(...safeLinks);
		this.delegate.addLinks(safeLinks);
	}
}

const makeRecordingTracer = (
	store: TelemetryStore["Service"],
	delegate: Tracer.Tracer,
): Tracer.Tracer =>
	Tracer.make({
		span: (options) => {
			const safeOptions = {
				...options,
				links: options.links.map((link) => ({
					...link,
					attributes: filterTelemetryAttributes(link.attributes),
				})),
			};
			return new TelemetrySpan(safeOptions, delegate.span(safeOptions), store);
		},
		...(delegate.context === undefined ? {} : { context: delegate.context }),
	});

export const TelemetryObservabilityLive = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* TelemetryStore;
		const delegate =
			TRACE_URL.length === 0
				? Tracer.make({
						span: (options) => new Tracer.NativeSpan(options),
					})
				: yield* OtlpTracer.make({
						url: TRACE_URL,
						exportInterval: Duration.millis(EXPORT_INTERVAL_MS),
						resource: {
							serviceName: SERVICE_NAME,
							serviceVersion: process.env.ZUSE_APP_VERSION ?? "unknown",
							attributes: {
								"service.runtime": "server",
								"service.environment": process.env.NODE_ENV ?? "development",
							},
						},
					});
		const tracerLayer = Layer.succeed(
			Tracer.Tracer,
			makeRecordingTracer(store, delegate),
		);
		const metricsLayer =
			METRICS_URL.length === 0
				? Layer.empty
				: OtlpMetrics.layer({
						url: METRICS_URL,
						exportInterval: Duration.millis(EXPORT_INTERVAL_MS),
						resource: {
							serviceName: SERVICE_NAME,
							serviceVersion: process.env.ZUSE_APP_VERSION ?? "unknown",
							attributes: {
								"service.runtime": "server",
								"service.environment": process.env.NODE_ENV ?? "development",
							},
						},
					});
		return Layer.merge(tracerLayer, metricsLayer);
	}),
).pipe(
	Layer.provideMerge(OtlpExporter.layerFlusher),
	Layer.provideMerge(OtlpSerialization.layerJson),
	Layer.provideMerge(FetchHttpClient.layer),
);
