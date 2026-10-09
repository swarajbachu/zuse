import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type {
	AgentOptions,
	LocalSendOptions,
	Run,
	SDKMessage,
	SDKUserMessage,
} from "@cursor/sdk";

export type CursorRun = Pick<Run, "stream" | "wait" | "cancel">;
export interface CursorAgent {
	readonly agentId: string;
	readonly send: (
		message: string | SDKUserMessage,
		options?: LocalSendOptions,
	) => Promise<CursorRun>;
	readonly close: () => void;
}

// Cursor's local SDK has no per-session shell environment option. Keep its
// entire executor in a worker with a private environment, including resumed
// sessions and nested shells. Never mutate the server's process.env.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
 const { Agent, JsonlLocalAgentStore } = await import(workerData.sdkPath);
 const options = { ...workerData.options, local: { ...workerData.options.local, store: new JsonlLocalAgentStore(workerData.storePath) } };
 let agent;
 if (workerData.resumeCursor) {
  try { agent = await Agent.resume(workerData.resumeCursor, options); }
  catch (error) { if (!/(?:stale|corrupt|not found|unknown agent)/i.test(error.message)) throw error; }
 }
 const resumed = Boolean(agent);
 agent ??= await Agent.create(options);
 let run;
 parentPort.on("message", async ({ id, method, args }) => {
  try {
   if (method === "send") { run = await agent.send(...args); parentPort.postMessage({ id, value: null }); }
   else if (method === "next") { const value = await iterator.next(); parentPort.postMessage({ id, value }); }
   else if (method === "stream") { iterator = run.stream(); parentPort.postMessage({ id, value: null }); }
   else if (method === "wait") { parentPort.postMessage({ id, value: await run.wait() }); }
   else if (method === "cancel") { await run?.cancel(); parentPort.postMessage({ id, value: null }); }
   else if (method === "close") { await run?.cancel().catch(() => {}); agent.close(); parentPort.close(); }
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
 });
 let iterator;
 parentPort.postMessage({ id: 0, value: { agentId: agent.agentId, resumed } });
})().catch(error => { parentPort.postMessage({ id: 0, error: error.message }); parentPort.close(); });
`;

export const startIsolatedCursorAgent = async (
	options: AgentOptions,
	storePath: string,
	resumeCursor: string | null,
	env: Readonly<Record<string, string>>,
	sdkPath?: string,
): Promise<{ agent: CursorAgent; resumed: boolean }> => {
	const require = createRequire(
		typeof __filename === "string" ? __filename : import.meta.url,
	);
	const worker = new Worker(workerSource, {
		eval: true,
		env: { ...process.env, ...env },
		workerData: {
			options: { ...options, local: { ...options.local, store: undefined } },
			storePath,
			resumeCursor,
			sdkPath: sdkPath ?? require.resolve("@cursor/sdk"),
		},
	});
	let nextId = 1;
	let failure: Error | undefined;
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const fail = (error: Error) => {
		failure = error;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	worker.on("error", fail);
	worker.on("exit", () => fail(new Error("Cursor executor closed")));
	worker.on(
		"message",
		(message: { id: number; value?: unknown; error?: string }) => {
			const request = pending.get(message.id);
			if (request === undefined) return;
			pending.delete(message.id);
			if (message.error !== undefined) request.reject(new Error(message.error));
			else request.resolve(message.value);
		},
	);
	const request = <A>(
		method: string,
		args: unknown[] = [],
		id = nextId++,
	): Promise<A> => {
		if (failure !== undefined) return Promise.reject(failure);
		return new Promise<A>((resolve, reject) => {
			pending.set(id, { resolve: (value) => resolve(value as A), reject });
			if (id !== 0) worker.postMessage({ id, method, args });
		});
	};
	const close = () => {
		worker.postMessage({ method: "close" });
		const timer = setTimeout(() => void worker.terminate(), 5_000);
		timer.unref();
		worker.once("exit", () => clearTimeout(timer));
	};
	const startupTimeout = setTimeout(() => {
		fail(new Error("Cursor executor startup timed out"));
		void worker.terminate();
	}, 30_000);
	try {
		const ready = await request<{ agentId: string; resumed: boolean }>(
			"ready",
			[],
			0,
		);
		return {
			resumed: ready.resumed,
			agent: {
				agentId: ready.agentId,
				close,
				send: async (...args) => {
					await request("send", args);
					return {
						cancel: () => request<void>("cancel"),
						wait: () => request<Awaited<ReturnType<Run["wait"]>>>("wait"),
						stream: async function* () {
							await request("stream");
							while (true) {
								const next =
									await request<IteratorResult<SDKMessage, void>>("next");
								if (next.done) return;
								yield next.value;
							}
						},
					};
				},
			},
		};
	} catch (error) {
		await worker.terminate();
		throw error;
	} finally {
		clearTimeout(startupTimeout);
	}
};
