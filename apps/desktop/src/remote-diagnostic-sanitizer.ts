const REDACTED = "[REDACTED]";

const isSensitiveKey = (key: string): boolean =>
	/^(?:authorization|cookie|set-cookie|token|ticket|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|credential|dpop|api[_-]?key)$/i.test(
		key,
	);

const sanitizeString = (value: string): string =>
	value
		.replace(
			/([?&](?:authorization|token|ticket|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|credential|dpop|api[_-]?key)=)[^&#\s"']+/gi,
			`$1${REDACTED}`,
		)
		.replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
		.replace(
			/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
			REDACTED,
		);

export const sanitizeRemoteDiagnosticValue = (
	value: unknown,
	key?: string,
): unknown => {
	if (key !== undefined && isSensitiveKey(key)) return REDACTED;
	if (typeof value === "string") return sanitizeString(value);
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeRemoteDiagnosticValue(item));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => [
				childKey,
				sanitizeRemoteDiagnosticValue(childValue, childKey),
			]),
		);
	}
	return value;
};

export const sanitizeRemoteConnectionLog = (contents: string): string => {
	const hadTrailingNewline = contents.endsWith("\n");
	const sanitized = contents
		.split("\n")
		.filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
		.map((line) => {
			try {
				return JSON.stringify(
					sanitizeRemoteDiagnosticValue(JSON.parse(line) as unknown),
				);
			} catch {
				return sanitizeString(line);
			}
		})
		.join("\n");
	return hadTrailingNewline && sanitized.length > 0
		? `${sanitized}\n`
		: sanitized;
};
