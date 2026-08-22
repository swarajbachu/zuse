const SECRET_FIELD_PATTERN =
	/(?:token|authorization|password|secret|credential)/iu;

/** Removes secret-shaped fields before any value enters diagnostic JSON. */
export const redactDiagnosticValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(redactDiagnosticValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, field]) => [
			key,
			SECRET_FIELD_PATTERN.test(key)
				? "[redacted]"
				: redactDiagnosticValue(field),
		]),
	);
};
