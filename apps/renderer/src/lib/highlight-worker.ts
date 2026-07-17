import type { BundledLanguage } from "shiki";

type WorkerReply = {
	readonly id: number;
	readonly html?: string;
	readonly error?: string;
};

type Pending = {
	readonly resolve: (html: string) => void;
	readonly reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

const getWorker = (): Worker => {
	if (worker !== null) return worker;
	worker = new Worker(new URL("./shiki.worker.ts", import.meta.url), {
		type: "module",
	});
	worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
		const request = pending.get(event.data.id);
		if (request === undefined) return;
		pending.delete(event.data.id);
		if (event.data.html !== undefined) request.resolve(event.data.html);
		else request.reject(new Error(event.data.error ?? "Highlighting failed"));
	});
	worker.addEventListener("error", (event) => {
		const error = new Error(event.message || "Highlight worker failed");
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		worker?.terminate();
		worker = null;
	});
	return worker;
};

export const highlightCode = (input: {
	readonly code: string;
	readonly lang: BundledLanguage;
	readonly theme: string;
}): Promise<string> =>
	new Promise((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		getWorker().postMessage({ id, ...input });
	});
