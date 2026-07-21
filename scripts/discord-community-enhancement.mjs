import {
	DISCORD_CHANNEL_TYPES,
	normalizeDiscordChannelName,
} from "./discord-community-plan.mjs";

export const ENHANCEMENT_ROLES = [
	{ color: 0x5865f2, name: "Vibe Coder" },
	{ color: 0x9b59b6, name: "Token Maxer" },
	{ color: 0x2ecc71, name: "Vibe Scientist" },
	{ color: 0xe67e22, name: "Bug Hunter" },
	{ color: 0xf1c40f, name: "Product Updates" },
];

export const ENHANCEMENT_CHANNELS = [
	{
		name: "welcome",
		topic:
			"Start here: learn the server, choose your roles, and find your people.",
		visibility: "read-only",
	},
	{
		name: "announcements",
		topic: "Important Zuse news, releases, and community updates.",
		visibility: "read-only",
	},
	{
		name: "community-updates",
		topic: "Private Discord community and safety notices for administrators.",
		visibility: "private",
	},
];

const normalizeRoleName = (name) => name.trim().toLowerCase();

export function createDiscordSnowflakeGenerator(now = () => Date.now()) {
	const discordEpochMs = 1_420_070_400_000n;
	let sequence = 0n;

	return () => {
		const timestamp = BigInt(now()) - discordEpochMs;
		if (timestamp < 0n) {
			throw new Error("Cannot generate a Discord snowflake before its epoch.");
		}
		const snowflake = (timestamp << 22n) | (sequence & 0xfffn);
		sequence += 1n;
		return snowflake.toString();
	};
}

export function buildEnhancementPlan({ channels, guild, roles }) {
	const operations = [];
	const categoryChannels = channels.filter(
		(channel) => channel.type === DISCORD_CHANNEL_TYPES.category,
	);
	const categoryByName = new Map(
		categoryChannels.map((channel) => [
			normalizeDiscordChannelName(channel.name),
			channel,
		]),
	);

	const startHere = categoryByName.get("start here");
	const defaultTextCategory = categoryByName.get("text channels");
	if (!startHere) {
		operations.push(
			defaultTextCategory
				? {
						type: "rename-channel",
						channelId: defaultTextCategory.id,
						from: defaultTextCategory.name,
						name: "START HERE",
					}
				: { type: "create-category", name: "START HERE" },
		);
	}

	const hangout = categoryByName.get("hangout");
	const defaultVoiceCategory = categoryByName.get("voice channels");
	if (!hangout) {
		operations.push(
			defaultVoiceCategory
				? {
						type: "rename-channel",
						channelId: defaultVoiceCategory.id,
						from: defaultVoiceCategory.name,
						name: "HANGOUT",
					}
				: { type: "create-category", name: "HANGOUT" },
		);
	}

	const voiceCategoryId = hangout?.id ?? defaultVoiceCategory?.id;
	const defaultVoiceChannel = channels.find(
		(channel) =>
			channel.type === 2 &&
			channel.parent_id === voiceCategoryId &&
			normalizeDiscordChannelName(channel.name) === "general",
	);
	if (defaultVoiceChannel) {
		operations.push({
			type: "rename-channel",
			channelId: defaultVoiceChannel.id,
			from: defaultVoiceChannel.name,
			name: "vibe-lounge",
		});
	}

	const existingRoleNames = new Set(
		roles.map((role) => normalizeRoleName(role.name)),
	);
	for (const role of ENHANCEMENT_ROLES) {
		if (!existingRoleNames.has(normalizeRoleName(role.name))) {
			operations.push({ type: "create-role", ...role });
		}
	}

	const startHereId = startHere?.id ?? defaultTextCategory?.id;
	for (const channel of ENHANCEMENT_CHANNELS) {
		const exists = channels.some(
			(existingChannel) =>
				existingChannel.type === DISCORD_CHANNEL_TYPES.text &&
				existingChannel.parent_id === startHereId &&
				normalizeDiscordChannelName(existingChannel.name) === channel.name,
		);
		if (!exists) {
			operations.push({
				type: "create-text-channel",
				categoryName: "START HERE",
				...channel,
			});
		}
	}

	if (!guild.features.includes("COMMUNITY")) {
		operations.push({ type: "enable-community" });
	}

	return operations;
}
