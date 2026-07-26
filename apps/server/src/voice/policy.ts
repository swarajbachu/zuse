export const MAX_VOICE_DURATION_MS = 150_000;
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

export const classifyVoiceFallback = (
	status: number,
	body: string,
): "unsupported" | "blocked" | "authentication-rejected" | null => {
	if (status === 401) return "authentication-rejected";
	if (
		status === 403 &&
		/(?:cloudflare|challenge|blocked|forbidden)/iu.test(body)
	)
		return "blocked";
	if (status === 403) return "authentication-rejected";
	if (status === 404 || status === 405 || status === 415) return "unsupported";
	return null;
};

export const voiceValidationReason = (
	bytes: Uint8Array,
	mimeType: string,
	durationMs: number,
): string | null => {
	if (bytes.byteLength === 0) return "Recording is empty.";
	if (bytes.byteLength > MAX_VOICE_BYTES)
		return "Recording exceeds the 10 MB limit.";
	if (durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS)
		return "Recording exceeds the 150 second limit.";
	if (
		!/^(?:audio\/mp4|audio\/m4a|audio\/mpeg|audio\/wav|audio\/webm)$/iu.test(
			mimeType,
		)
	)
		return "Recording format is not supported.";
	return null;
};
