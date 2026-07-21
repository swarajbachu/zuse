import {
	buildCommunityPlan,
	DISCORD_CHANNEL_TYPES,
	normalizeDiscordChannelName,
} from "./discord-community-plan.mjs";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_ATTEMPTS = 4;

const requireEnvironmentVariable = (name) => {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
};

const token = requireEnvironmentVariable("DISCORD_BOT_TOKEN");
const guildId = requireEnvironmentVariable("DISCORD_GUILD_ID");
const dryRun = process.argv.includes("--dry-run");

if (!/^\d+$/.test(guildId)) {
	throw new Error("DISCORD_GUILD_ID must contain only digits.");
}

const sleep = (durationMs) =>
	new Promise((resolve) => setTimeout(resolve, durationMs));

const discordRequest = async (path, init = {}) => {
	for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt += 1) {
		const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
			...init,
			headers: {
				Authorization: `Bot ${token}`,
				"Content-Type": "application/json",
				...init.headers,
			},
			signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
		});

		if (response.status === 429 && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
			const rateLimit = await response.json();
			const retryAfterMs = Math.max(100, Number(rateLimit.retry_after) * 1_000);
			await sleep(retryAfterMs);
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

const createGuildChannel = (body) =>
	discordRequest(`/guilds/${guildId}/channels`, {
		method: "POST",
		body: JSON.stringify(body),
	});

const existingChannels = await discordRequest(`/guilds/${guildId}/channels`);
const plan = buildCommunityPlan(existingChannels);

if (plan.length === 0) {
	console.log("Discord community layout is already configured.");
	process.exit(0);
}

if (dryRun) {
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}

const categoryIds = new Map(
	existingChannels
		.filter((channel) => channel.type === DISCORD_CHANNEL_TYPES.category)
		.map((channel) => [normalizeDiscordChannelName(channel.name), channel.id]),
);

for (const operation of plan) {
	if (operation.type !== "create-category") {
		continue;
	}

	const category = await createGuildChannel({
		name: operation.name,
		type: DISCORD_CHANNEL_TYPES.category,
	});
	categoryIds.set(normalizeDiscordChannelName(operation.name), category.id);
	console.log(`Created category: ${operation.name}`);
}

for (const operation of plan) {
	if (
		operation.type !== "create-text-channel" &&
		operation.type !== "move-text-channel"
	) {
		continue;
	}

	const parentId = categoryIds.get(
		normalizeDiscordChannelName(operation.categoryName),
	);
	if (!parentId) {
		throw new Error(`Could not resolve category: ${operation.categoryName}`);
	}

	if (operation.type === "move-text-channel") {
		await discordRequest(`/channels/${operation.channelId}`, {
			method: "PATCH",
			body: JSON.stringify({ parent_id: parentId }),
		});
		console.log(`Moved channel: #${operation.name}`);
		continue;
	}

	await createGuildChannel({
		name: operation.name,
		parent_id: parentId,
		topic: operation.topic,
		type: DISCORD_CHANNEL_TYPES.text,
	});
	console.log(`Created channel: #${operation.name}`);
}

console.log("Discord community layout configured successfully.");
