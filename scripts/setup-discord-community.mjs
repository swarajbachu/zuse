import {
	assertDiscordGuildId,
	createDiscordClient,
	requireEnvironmentVariable,
} from "./discord-api.mjs";
import {
	buildCommunityPlan,
	DISCORD_CHANNEL_TYPES,
	normalizeDiscordChannelName,
} from "./discord-community-plan.mjs";

const token = requireEnvironmentVariable("DISCORD_BOT_TOKEN");
const guildId = requireEnvironmentVariable("DISCORD_GUILD_ID");
const dryRun = process.argv.includes("--dry-run");
assertDiscordGuildId(guildId);
const discord = createDiscordClient({ token });

const createGuildChannel = (body) =>
	discord.requestJson(`/guilds/${guildId}/channels`, "POST", body);

const existingChannels = await discord.request(`/guilds/${guildId}/channels`);
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
		await discord.requestJson(`/channels/${operation.channelId}`, "PATCH", {
			parent_id: parentId,
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
