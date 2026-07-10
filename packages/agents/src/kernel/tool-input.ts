const canonicalKey = (key: string): string =>
	key === "target_file" || key === "filePath" ? "file_path" : key;

/**
 * Normalize equivalent provider tool-input shapes before fingerprinting.
 * Object keys are sorted recursively so semantically identical inputs produce
 * one stable representation regardless of provider key order or path alias.
 */
export const canonicalizeToolInput = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalizeToolInput);
	if (value === null || typeof value !== "object") return value;

	const entries = Object.entries(value as Record<string, unknown>)
		.map(
			([key, item]) =>
				[canonicalKey(key), canonicalizeToolInput(item)] as const,
		)
		.sort(([left], [right]) => left.localeCompare(right));
	return Object.fromEntries(entries);
};
