import { Context, Duration, Metric } from "effect";

export const operationsTotal = Metric.counter("zuse_operations_total", {
	description: "Completed application operations grouped by stable boundary.",
	incremental: true,
});

export const operationDuration = Metric.timer("zuse_operation_duration", {
	description: "Application operation duration grouped by stable boundary.",
});

export const failuresTotal = Metric.counter("zuse_failures_total", {
	description: "Failed application operations grouped by stable boundary.",
	incremental: true,
});

const labels = (input: {
	readonly operation: string;
	readonly category: string;
	readonly outcome: string;
}): ReadonlyArray<[string, string]> => [
	["operation", input.operation],
	["category", input.category],
	["outcome", input.outcome],
];

export const recordOperationMetrics = (input: {
	readonly operation: string;
	readonly category: string;
	readonly outcome: "success" | "failure" | "interrupted";
	readonly durationMs: number;
	readonly context?: Context.Context<never>;
}): void => {
	try {
		const context = input.context ?? Context.empty();
		const attributes = labels(input);
		Metric.withAttributes(operationsTotal, attributes).updateUnsafe(1, context);
		Metric.withAttributes(operationDuration, attributes).updateUnsafe(
			Duration.millis(input.durationMs),
			context,
		);
		if (input.outcome === "failure") {
			Metric.withAttributes(failuresTotal, attributes).updateUnsafe(1, context);
		}
	} catch {
		// Metric collection is observational and must remain failure-isolated.
	}
};
