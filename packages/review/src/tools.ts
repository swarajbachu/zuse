import type { ReviewLocation } from "@zuse/contracts";
import type { ReviewLimits, ReviewSource, ReviewTools } from "./types.ts";

export function isRepositoryPath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!Array.from(path).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export function validateLocation(location: ReviewLocation): void {
	if (
		!isRepositoryPath(location.path) ||
		!["LEFT", "RIGHT"].includes(location.side) ||
		!Number.isSafeInteger(location.startLine) ||
		!Number.isSafeInteger(location.endLine) ||
		location.startLine < 1 ||
		location.endLine < location.startLine
	) {
		throw new Error("Invalid repository location");
	}
}

export function createReviewTools(
	source: ReviewSource,
	limits: ReviewLimits,
	signal: AbortSignal,
	onLimited: () => void,
): ReviewTools {
	const files = {
		LEFT: new Set(source.files.LEFT),
		RIGHT: new Set(source.files.RIGHT),
	};
	let calls = 0;
	const admit = () => {
		signal.throwIfAborted();
		if (++calls > limits.maxToolCalls) {
			onLimited();
			throw new Error("Review tool budget exceeded");
		}
	};
	const readFile = async (side: "LEFT" | "RIGHT", path: string) => {
		if (!isRepositoryPath(path) || !files[side].has(path))
			throw new Error("File is outside review snapshot");
		const content = await source.readFile(side, path, signal);
		signal.throwIfAborted();
		if (
			content === null ||
			Buffer.byteLength(content) > limits.maxFileBytes ||
			content.includes("\0")
		) {
			onLimited();
			throw new Error("File unavailable within review limits");
		}
		return content;
	};
	return {
		relatedFiles: async (path, side = "RIGHT") => {
			admit();
			if (
				!isRepositoryPath(path) ||
				!["LEFT", "RIGHT"].includes(side) ||
				!files[side].has(path)
			)
				throw new Error("File is outside review snapshot");
			const related = source.relatedFiles?.(path, side) ?? [];
			if (related.length > limits.maxSearchResults) onLimited();
			return related
				.filter(
					(item) => isRepositoryPath(item.path) && files[side].has(item.path),
				)
				.slice(0, limits.maxSearchResults);
		},
		read: async (location) => {
			admit();
			validateLocation(location);
			if (location.endLine - location.startLine + 1 > limits.maxReadLines)
				throw new Error("Read exceeds line limit");
			const lines = (await readFile(location.side, location.path)).split("\n");
			if (location.endLine > lines.length)
				throw new Error("Location exceeds file length");
			return lines.slice(location.startLine - 1, location.endLine).join("\n");
		},
		search: async (query, side = "RIGHT") => {
			admit();
			if (
				!query.trim() ||
				query.length > 256 ||
				query.includes("\n") ||
				!["LEFT", "RIGHT"].includes(side)
			)
				throw new Error("Invalid search query");
			if (source.search) {
				const found = await source.search(
					query,
					side,
					limits.maxSearchResults + 1,
				);
				signal.throwIfAborted();
				if (found.length > limits.maxSearchResults) onLimited();
				return found
					.slice(0, limits.maxSearchResults)
					.filter((hit) => {
						validateLocation(hit.location);
						return (
							hit.location.side === side && files[side].has(hit.location.path)
						);
					})
					.map((hit) => ({ ...hit, text: hit.text.slice(0, 2000) }));
			}
			const paths = [...files[side]].sort();
			if (paths.length > limits.maxSearchFiles) onLimited();
			const hits: { location: ReviewLocation; text: string }[] = [];
			for (const path of paths.slice(0, limits.maxSearchFiles)) {
				let content: string;
				try {
					content = await readFile(side, path);
				} catch {
					signal.throwIfAborted();
					onLimited();
					continue;
				}
				const lines = content.split("\n");
				for (let line = 0; line < lines.length; line++) {
					const text = lines[line];
					if (text?.includes(query)) {
						hits.push({
							location: { path, side, startLine: line + 1, endLine: line + 1 },
							text: text.slice(0, 2000),
						});
						if (hits.length >= limits.maxSearchResults) {
							onLimited();
							return hits;
						}
					}
				}
			}
			return hits;
		},
	};
}
