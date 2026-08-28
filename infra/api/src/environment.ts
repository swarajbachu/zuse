export const isConfigured = (value: string | undefined): value is string =>
	value !== undefined &&
	value.trim().length > 0 &&
	!value.trim().startsWith("REPLACE_WITH");
