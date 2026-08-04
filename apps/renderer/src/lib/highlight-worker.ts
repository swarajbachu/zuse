import type { BundledLanguage } from "shiki";
import {
	codeHighlightKey,
	normalizeHighlightedCodeHtml,
} from "./code-block-highlight.ts";

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
const pendingBySource = new Map<string, Promise<string>>();
const completed = new Map<
	string,
	{ readonly html: string; readonly bytes: number }
>();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
let completedBytes = 0;

export interface HighlightCodeInput {
	readonly code: string;
	readonly lang: BundledLanguage;
	readonly theme: string;
}

const sourceKey = (input: HighlightCodeInput): string =>
	`${input.theme}\0${codeHighlightKey(input)}`;

const readCompleted = (key: string): string | null => {
	const entry = completed.get(key);
	return entry?.html ?? null;
};

const writeCompleted = (key: string, html: string): void => {
	const bytes = (key.length + html.length) * 2;
	if (bytes > MAX_CACHE_BYTES) return;
	const previous = completed.get(key);
	if (previous !== undefined) {
		completedBytes -= previous.bytes;
		completed.delete(key);
	}
	completed.set(key, { html, bytes });
	completedBytes += bytes;
	while (completedBytes > MAX_CACHE_BYTES) {
		const oldestKey = completed.keys().next().value;
		if (typeof oldestKey !== "string") break;
		const oldest = completed.get(oldestKey);
		completed.delete(oldestKey);
		if (oldest !== undefined) completedBytes -= oldest.bytes;
	}
};

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

export const readCachedHighlightedCode = (
	input: HighlightCodeInput,
): string | null => readCompleted(sourceKey(input));

export const highlightCode = (input: HighlightCodeInput): Promise<string> => {
	const key = sourceKey(input);
	const cached = readCompleted(key);
	if (cached !== null) return Promise.resolve(cached);
	const existing = pendingBySource.get(key);
	if (existing !== undefined) return existing;

	const request = new Promise<string>((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		getWorker().postMessage({ id, ...input });
	});
	const shared = request
		.then((rawHtml) => {
			const html = normalizeHighlightedCodeHtml(rawHtml);
			writeCompleted(key, html);
			return html;
		})
		.finally(() => {
			pendingBySource.delete(key);
		});
	pendingBySource.set(key, shared);
	return shared;
};
