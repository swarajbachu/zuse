import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReviewSnapshot } from "@zuse/contracts";
import { Schema } from "effect";
import { isRepositoryPath } from "./tools.ts";
import {
	DEFAULT_REVIEW_LIMITS,
	type ReviewChange,
	type ReviewSource,
} from "./types.ts";

const exec = promisify(execFile);
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 250_000_000;
interface Blob {
	readonly oid: string;
	readonly bytes: number;
}

/** Reads Git objects only: no checkout, hook, filter, textconv, external diff or repository code execution. */
export async function createGitReviewSource(
	root: string,
	input: ReviewSnapshot,
	signal: AbortSignal,
): Promise<ReviewSource> {
	const snapshot = Schema.decodeUnknownSync(ReviewSnapshot)(input);
	const git = async (args: readonly string[], maxBuffer = 16_000_000) => {
		const result = await exec(
			"git",
			[
				"--no-pager",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-C",
				root,
				...args,
			],
			{
				signal,
				maxBuffer,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_NO_REPLACE_OBJECTS: "1",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
				},
			},
		);
		return result.stdout;
	};
	for (const sha of [
		snapshot.baseSha,
		snapshot.headSha,
		snapshot.mergeBaseSha,
	]) {
		if (
			(await git(["rev-parse", "--verify", `${sha}^{commit}`])).trim() !== sha
		)
			throw new Error("Snapshot commit unavailable");
	}
	const mergeBases = (
		await git(["merge-base", "--all", snapshot.baseSha, snapshot.headSha])
	)
		.trim()
		.split("\n");
	if (mergeBases.length !== 1 || mergeBases[0] !== snapshot.mergeBaseSha)
		throw new Error("Snapshot merge base changed or ambiguous");
	let contextLimited = false;
	const readTree = async (sha: string) => {
		const tree = new Map<string, Blob>();
		const entries = (
			await git(["ls-tree", "-r", "-l", "-z", sha], 32_000_000)
		).split("\0");
		let total = 0;
		for (const entry of entries) {
			if (!entry) continue;
			const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/u.exec(entry);
			if (!match) continue;
			const [, mode, oid, size, path] = match;
			if (
				!oid ||
				!path ||
				!["100644", "100755"].includes(mode ?? "") ||
				!isRepositoryPath(path)
			)
				continue;
			const bytes = Number(size);
			if (
				bytes > DEFAULT_REVIEW_LIMITS.maxFileBytes ||
				tree.size >= MAX_TREE_FILES ||
				total + bytes > MAX_TREE_BYTES
			) {
				contextLimited = true;
				continue;
			}
			tree.set(path, { oid, bytes });
			total += bytes;
		}
		return tree;
	};
	const left = await readTree(snapshot.mergeBaseSha);
	const right = await readTree(snapshot.headSha);
	const names = (
		await git([
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--name-status",
			"-z",
			snapshot.mergeBaseSha,
			snapshot.headSha,
			"--",
		])
	).split("\0");
	const changes: ReviewChange[] = [];
	for (let index = 0; index < names.length - 1; index += 2) {
		const statusCode = names[index];
		const path = names[index + 1];
		if (!statusCode || !path || !isRepositoryPath(path))
			throw new Error("Unsupported changed path");
		const status =
			statusCode === "A"
				? "added"
				: statusCode === "D"
					? "deleted"
					: "modified";
		let excluded = status === "deleted" ? !left.has(path) : !right.has(path);
		const addedLines: { start: number; end: number }[] = [];
		const deletedLines: { start: number; end: number }[] = [];
		if (!excluded) {
			const patch = await git(
				[
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--no-renames",
					"--unified=0",
					snapshot.mergeBaseSha,
					snapshot.headSha,
					"--",
					`:(literal)${path}`,
				],
				4_000_000,
			);
			excluded = /^Binary files /mu.test(patch);
			for (const match of patch.matchAll(
				/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu,
			)) {
				const oldStart = Number(match[1]);
				const oldCount = match[2] === undefined ? 1 : Number(match[2]);
				const newStart = Number(match[3]);
				const newCount = match[4] === undefined ? 1 : Number(match[4]);
				if (oldCount > 0)
					deletedLines.push({ start: oldStart, end: oldStart + oldCount - 1 });
				if (newCount > 0)
					addedLines.push({ start: newStart, end: newStart + newCount - 1 });
			}
		}
		changes.push({ path, status, excluded, addedLines, deletedLines });
	}
	return {
		snapshot,
		changes,
		files: { LEFT: [...left.keys()], RIGHT: [...right.keys()] },
		contextLimited,
		readFile: async (side, path, readSignal) => {
			const blob = (side === "LEFT" ? left : right).get(path);
			if (!blob) return null;
			readSignal.throwIfAborted();
			const result = await exec(
				"git",
				["--no-pager", "-C", root, "cat-file", "blob", blob.oid],
				{
					signal: readSignal,
					maxBuffer: DEFAULT_REVIEW_LIMITS.maxFileBytes + 1,
					encoding: "utf8",
					timeout: 30_000,
					env: {
						...process.env,
						GIT_NO_REPLACE_OBJECTS: "1",
						GIT_OPTIONAL_LOCKS: "0",
						GIT_TERMINAL_PROMPT: "0",
					},
				},
			);
			return result.stdout;
		},
	};
}
