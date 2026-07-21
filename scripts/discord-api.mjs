const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_ATTEMPTS = 4;

const defaultSleep = (durationMs) =>
	new Promise((resolve) => setTimeout(resolve, durationMs));

export const requireEnvironmentVariable = (name) => {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
};

export const assertDiscordGuildId = (guildId) => {
	if (!/^\d+$/.test(guildId)) {
		throw new Error("DISCORD_GUILD_ID must contain only digits.");
	}
};

export function createDiscordClient({
	fetchImpl = fetch,
	maxRateLimitAttempts = MAX_RATE_LIMIT_ATTEMPTS,
	sleepImpl = defaultSleep,
	timeoutMs = DISCORD_REQUEST_TIMEOUT_MS,
	token,
}) {
	const request = async (path, init = {}) => {
		for (let attempt = 1; attempt <= maxRateLimitAttempts; attempt += 1) {
			const response = await fetchImpl(`${DISCORD_API_BASE_URL}${path}`, {
				...init,
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
					"X-Audit-Log-Reason": "Zuse community setup",
					...init.headers,
				},
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (response.status === 429 && attempt < maxRateLimitAttempts) {
				const rateLimit = await response.json();
				const retryAfterMs = Math.max(
					100,
					Number(rateLimit.retry_after) * 1_000,
				);
				await sleepImpl(retryAfterMs);
				continue;
			}

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`Discord API request failed (${response.status}): ${errorBody}`,
				);
			}

			if (response.status === 204) {
				return undefined;
			}

			return response.json();
		}

		throw new Error("Discord API request exhausted its rate-limit retries.");
	};

	return {
		request,
		requestJson: (path, method, body) =>
			request(path, {
				method,
				body: JSON.stringify(body),
			}),
	};
}
