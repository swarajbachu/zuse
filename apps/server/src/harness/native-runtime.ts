import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "@zuse/agents/harness/cache";
import { HarnessEngine } from "@zuse/agents/harness/engine";
import type { HarnessHost } from "@zuse/agents/harness/types";
import { Effect } from "effect";
import { acquireProcessLock } from "../process/process-lock.ts";
import { NativeHarnessTools, type NativeToolOptions } from "./native-tools.ts";

export interface NativeRuntimeOptions {
	readonly rootId: string;
	readonly model: string;
	readonly dataDirectory: string;
	readonly host: Omit<
		HarnessHost,
		"tools" | "execute" | "close" | "interruptAgents"
	>;
	readonly appTools?: Pick<HarnessHost, "tools" | "execute">;
	readonly tools: Omit<
		NativeToolOptions,
		"rootId" | "directory" | "lockDirectory" | "notify"
	>;
}
type AppTools = Pick<HarnessHost, "tools" | "execute">;

/** Merges app tool sets; each tool name is routed to the set that defines it. */
export function combineAppTools(
	...sets: ReadonlyArray<AppTools | undefined>
): AppTools | undefined {
	const present = sets.filter((set) => set !== undefined);
	if (present.length <= 1) return present[0];
	return {
		tools: Object.assign({}, ...present.map((set) => set.tools)),
		execute: (name, input, context) => {
			const owner = present.find((set) => Object.hasOwn(set.tools, name));
			if (!owner) throw new Error(`Unknown app tool: ${name}`);
			return owner.execute(name, input, context);
		},
	};
}
/** Composition for server adapters. A root lease prevents two owners recovering the same processes. */
export async function createNativeHarness(
	options: NativeRuntimeOptions,
): Promise<HarnessEngine> {
	const rootKey = digest(options.rootId);
	const directory = join(options.dataDirectory, "harness", rootKey);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lease = await Effect.runPromise(
		acquireProcessLock(join(directory, "owner.sqlite"), 1),
	);
	let engine: HarnessEngine;
	const native = new NativeHarnessTools({
		...options.tools,
		rootId: options.rootId,
		directory: join(directory, "artifacts"),
		lockDirectory: join(options.dataDirectory, "harness", "file-locks"),
		notify: (notice) =>
			engine.enqueueNotification(
				notice.id,
				notice.agentId,
				JSON.stringify(notice),
			),
	});
	engine = new HarnessEngine(
		{
			...options.host,
			tools: { ...native.definitions, ...options.appTools?.tools },
			execute: (name, input, context) =>
				options.appTools && Object.hasOwn(options.appTools.tools, name)
					? options.appTools.execute(name, input, context)
					: native.execute(name, input, context),
			interruptAgents: (ids) => native.processes.interruptAgents(ids),
			close: async () => {
				try {
					await native.close();
				} finally {
					lease.close();
				}
			},
		},
		options.rootId,
		options.model,
	);
	try {
		await engine.initialize();
		await native.initialize();
		return engine;
	} catch (error) {
		await native.close().catch(() => {});
		lease.close();
		throw error;
	}
}
