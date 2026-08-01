import { Effect } from "effect";

import { beginStallOperation } from "./stall-context.ts";

type RpcLagReporter = (name: string, durationMs: number) => void;

let reportRpcLag: RpcLagReporter | null = null;
const pendingReports: Array<{
	readonly name: string;
	readonly durationMs: number;
}> = [];

export const setRendererRpcLagReporter = (
	reporter: RpcLagReporter | null,
): void => {
	reportRpcLag = reporter;
	if (reporter === null) return;
	for (const item of pendingReports.splice(0, pendingReports.length)) {
		reporter(item.name, item.durationMs);
	}
};

const isSafeRpcName = (value: string): boolean =>
	/^[a-z0-9._-]{1,100}$/i.test(value);

export const instrumentRendererRpcClient = <Client extends object>(
	client: Client,
): Client => {
	const wrappers = new Map<PropertyKey, unknown>();
	return new Proxy(client, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (
				typeof property !== "string" ||
				!isSafeRpcName(property) ||
				typeof value !== "function"
			) {
				return value;
			}
			const cached = wrappers.get(property);
			if (cached !== undefined) return cached;
			const wrapped = (...args: ReadonlyArray<unknown>) => {
				const result = Reflect.apply(value, target, args);
				if (!Effect.isEffect(result)) return result;
				return Effect.suspend(() => {
					const startedAt = performance.now();
					const finishOperation = beginStallOperation(`rpc:${property}`);
					return result.pipe(
						Effect.ensuring(
							Effect.sync(() => {
								finishOperation();
								const durationMs = performance.now() - startedAt;
								if (durationMs < 100) return;
								if (reportRpcLag !== null) {
									reportRpcLag(property, durationMs);
									return;
								}
								pendingReports.push({ name: property, durationMs });
								if (pendingReports.length > 20) pendingReports.shift();
							}),
						),
					);
				});
			};
			wrappers.set(property, wrapped);
			return wrapped;
		},
	});
};
