import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ReviewSnapshot } from "@zuse/contracts";
import { closeIndexDb, openIndexDb, runMigrations } from "@zuse/index";
import {
	createGitReviewSource,
	type ReviewRelatedFile,
	type ReviewSearchHit,
	type ReviewSource,
	withIndexedReviewSource,
} from "@zuse/review";
import { Effect } from "effect";
import { z } from "zod";

const MAX_FRAME = 8_000_000;
const SearchHits = z
	.array(
		z.object({
			location: z.object({
				path: z.string().max(4096),
				side: z.enum(["LEFT", "RIGHT"]),
				startLine: z.number().int().positive(),
				endLine: z.number().int().positive(),
			}),
			text: z.string().max(16000),
		}),
	)
	.max(30);
const Request = z
	.object({
		op: z.enum(["read", "search"]),
		limit: z.number().int().min(1).max(30).optional(),
		id: z.number().int().positive(),
		side: z.enum(["LEFT", "RIGHT"]),
		path: z.string().min(1).max(4096),
	})
	.strict();
/** Executes only in uid1001, without native auth access or inherited control environment. */
export async function serveReviewReader(
	root: string,
	snapshot: ReviewSnapshot,
): Promise<void> {
	const base = await createGitReviewSource(
		root,
		snapshot,
		new AbortController().signal,
	);
	const db = await Effect.runPromise(openIndexDb(":memory:"));
	await Effect.runPromise(runMigrations(db));
	const source = await withIndexedReviewSource(
		base,
		db,
		new AbortController().signal,
	);
	const relations: Record<string, readonly ReviewRelatedFile[]> = {};
	for (const side of ["LEFT", "RIGHT"] as const) {
		for (const path of source.files[side].slice(0, 5000)) {
			const related = source.relatedFiles?.(path, side) ?? [];
			if (related.length) relations[`${side}:${path}`] = related.slice(0, 100);
		}
	}
	process.stdout.write(
		`${JSON.stringify({ ready: { snapshot: source.snapshot, changes: source.changes, files: source.files, contextLimited: source.contextLimited || source.files.LEFT.length > 5000 || source.files.RIGHT.length > 5000, relations } })}\n`,
	);
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		if (Buffer.byteLength(line) > 16_000)
			throw new Error("Reader input exceeds limit");
		const request = Request.parse(JSON.parse(line));
		if (
			request.op === "read" &&
			!source.files[request.side].includes(request.path)
		)
			throw new Error("Reader path outside snapshot");
		const text =
			request.op === "read"
				? await source.readFile(
						request.side,
						request.path,
						new AbortController().signal,
					)
				: ((await source.search?.(
						request.path,
						request.side,
						request.limit ?? 30,
					)) ?? []);
		const output = JSON.stringify({ id: request.id, text });
		if (Buffer.byteLength(output) > MAX_FRAME)
			throw new Error("Reader response exceeds limit");
		process.stdout.write(`${output}\n`);
	}
	await Effect.runPromise(closeIndexDb(db));
}

export async function openReviewReader(input: {
	readonly root: string;
	readonly snapshot: ReviewSnapshot;
	readonly executable: string;
	readonly signal: AbortSignal;
	readonly uid: number;
}): Promise<{
	readonly source: ReviewSource;
	readonly close: () => Promise<void>;
}> {
	input.signal.throwIfAborted();
	const child = spawn(
		process.execPath,
		[
			input.executable,
			"reader",
			"--root",
			input.root,
			"--snapshot",
			JSON.stringify(input.snapshot),
		],
		{
			uid: input.uid,
			gid: input.uid,
			cwd: input.root,
			env: { PATH: "/usr/bin:/bin", HOME: input.root, LANG: "C.UTF-8" },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		},
	);
	child.stderr.resume();
	let stopped = false;
	let sequence = 0;
	const pending = new Map<
		number,
		{ resolve: (text: unknown) => void; reject: (error: Error) => void }
	>();
	let resolveReady: (value: ReviewSource) => void = () => {};
	let rejectReady: (error: Error) => void = () => {};
	const ready = new Promise<ReviewSource>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	void ready.catch(() => {});
	let exitedResolve: () => void = () => {};
	const exited = new Promise<void>((resolve) => {
		exitedResolve = resolve;
	});
	const fail = () => {
		stopped = true;
		const error = new Error("Review reader stopped");
		rejectReady(error);
		for (const value of pending.values()) value.reject(error);
		pending.clear();
	};
	let closing: Promise<void> | undefined;
	const close = () =>
		(closing ??= (async () => {
			fail();
			input.signal.removeEventListener("abort", onAbort);
			if (child.pid)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ESRCH"
						)
					)
						throw error;
				}
			await exited;
		})());
	const onAbort = () => {
		void close().catch(() => {});
	};
	child.once("exit", () => {
		fail();
		exitedResolve();
	});
	child.once("error", () => {
		fail();
		exitedResolve();
	});
	input.signal.addEventListener("abort", onAbort, { once: true });
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdin.on("error", fail);
	child.stdout.on("data", (chunk: string) => {
		try {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_FRAME * 2)
				throw new Error("Reader frame too large");
			let offset = buffer.indexOf("\n");
			while (offset >= 0) {
				const line = buffer.slice(0, offset);
				buffer = buffer.slice(offset + 1);
				if (Buffer.byteLength(line) > MAX_FRAME)
					throw new Error("Reader frame too large");
				const message = JSON.parse(line);
				if (message.ready) {
					const request = (
						op: "read" | "search",
						side: "LEFT" | "RIGHT",
						path: string,
						limit?: number,
					): Promise<unknown> => {
						if (stopped || pending.size >= 8)
							return Promise.reject(new Error("Reader unavailable"));
						const id = ++sequence;
						return new Promise((resolve, reject) => {
							pending.set(id, { resolve, reject });
							child.stdin.write(
								`${JSON.stringify({ id, op, side, path, limit })}\n`,
							);
						});
					};
					const source: ReviewSource = {
						...message.ready,
						relatedFiles: (path, side) =>
							message.ready.relations[`${side}:${path}`] ?? [],
						search: async (
							query,
							side,
							limit,
						): Promise<readonly ReviewSearchHit[]> =>
							SearchHits.parse(await request("search", side, query, limit)),
						readFile: async (side, path, signal) => {
							signal.throwIfAborted();
							const text = await request("read", side, path);
							if (text !== null && typeof text !== "string")
								throw new Error("Invalid reader text");
							return text;
						},
					};
					resolveReady(source);
				} else {
					const callback = pending.get(message.id);
					if (!callback) throw new Error("Reader protocol violation");
					pending.delete(message.id);
					callback.resolve(message.text);
				}
				offset = buffer.indexOf("\n");
			}
		} catch {
			onAbort();
		}
	});
	const timer = setTimeout(onAbort, 60_000);
	try {
		if (input.signal.aborted) onAbort();
		return { source: await ready, close };
	} catch (error) {
		await close();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
