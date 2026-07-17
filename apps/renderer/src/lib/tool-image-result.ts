export interface ToolImageResult {
	readonly data: string;
	readonly mimeType: string;
}

const findImage = (value: unknown, depth: number): ToolImageResult | null => {
	if (depth > 4 || value === null || value === undefined) return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findImage(item, depth + 1);
			if (found !== null) return found;
		}
		return null;
	}
	if (typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.type === "image" &&
		typeof record.data === "string" &&
		record.data.length > 0 &&
		typeof record.mimeType === "string" &&
		record.mimeType.startsWith("image/")
	) {
		return { data: record.data, mimeType: record.mimeType };
	}
	for (const key of ["content", "output", "result", "rawOutput"] as const) {
		const found = findImage(record[key], depth + 1);
		if (found !== null) return found;
	}
	return null;
};

export const toolImageResult = (value: unknown): ToolImageResult | null =>
	findImage(value, 0);

export const toolImageDataUrl = (image: ToolImageResult): string =>
	`data:${image.mimeType};base64,${image.data}`;
