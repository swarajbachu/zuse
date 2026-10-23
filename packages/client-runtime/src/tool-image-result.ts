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

/** Canonical tool name drivers use for model-generated images. */
export const GENERATE_IMAGE_TOOL = "GenerateImage";

export const isGenerateImageTool = (tool: string): boolean =>
	tool === GENERATE_IMAGE_TOOL;

/** The prompt a driver attached to a generated image result, if any. */
export const generatedImagePrompt = (output: unknown): string | null => {
	if (output === null || typeof output !== "object") return null;
	const prompt = (output as Record<string, unknown>).prompt;
	return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
};

/** The file a driver saved a generated image to, if any. */
export const generatedImagePath = (output: unknown): string | null => {
	if (output === null || typeof output !== "object") return null;
	const path = (output as Record<string, unknown>).path;
	return typeof path === "string" && path.length > 0 ? path : null;
};

/** Pixel size read from a base64 PNG header, without decoding the image. */
export const toolImageDimensions = (
	image: ToolImageResult,
): { readonly width: number; readonly height: number } | null => {
	if (image.mimeType !== "image/png") return null;
	let header: string;
	try {
		header = atob(image.data.slice(0, 32));
	} catch {
		return null;
	}
	if (header.length < 24 || header.slice(1, 4) !== "PNG") return null;
	const read = (offset: number) =>
		((header.charCodeAt(offset) << 24) |
			(header.charCodeAt(offset + 1) << 16) |
			(header.charCodeAt(offset + 2) << 8) |
			header.charCodeAt(offset + 3)) >>>
		0;
	const width = read(16);
	const height = read(20);
	return width > 0 && height > 0 ? { width, height } : null;
};
