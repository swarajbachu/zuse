export const DISCORD_CHANNEL_TYPES = {
	text: 0,
	category: 4,
};

export const COMMUNITY_LAYOUT = [
	{
		name: "COMMUNITY",
		channels: [
			{
				adoptExistingUncategorized: true,
				name: "general",
				topic: "General conversation for the community.",
			},
			{
				name: "vibe-coders",
				topic:
					"Share builds, prompts, experiments, and lessons from vibe coding.",
			},
			{
				name: "token-maxers",
				topic:
					"For heavy token users comparing workflows, tools, and techniques.",
			},
			{
				name: "vibe-scientists",
				topic:
					"A hangout for systematic experiments and deeper technical discussion.",
			},
		],
	},
	{
		name: "HELP & RESOURCES",
		channels: [
			{
				name: "resources",
				topic: "Guides, links, tools, and other useful community resources.",
			},
			{
				name: "bug-reports",
				topic:
					"Report bugs with reproduction steps, expected behavior, and screenshots when possible.",
			},
		],
	},
];

export const normalizeDiscordChannelName = (name) => name.trim().toLowerCase();

export function buildCommunityPlan(
	existingChannels,
	layout = COMMUNITY_LAYOUT,
) {
	const categoriesByName = new Map();
	for (const channel of existingChannels) {
		if (channel.type !== DISCORD_CHANNEL_TYPES.category) {
			continue;
		}
		const normalizedName = normalizeDiscordChannelName(channel.name);
		const matches = categoriesByName.get(normalizedName) ?? [];
		matches.push(channel);
		categoriesByName.set(normalizedName, matches);
	}

	const existingCategories = new Map();
	for (const category of layout) {
		const normalizedName = normalizeDiscordChannelName(category.name);
		const matches = categoriesByName.get(normalizedName) ?? [];
		if (matches.length > 1) {
			throw new Error(
				`Multiple Discord categories match the desired name: ${category.name}`,
			);
		}
		if (matches.length === 1) {
			existingCategories.set(normalizedName, matches[0]);
		}
	}
	const existingTextChannels = existingChannels.filter(
		(channel) => channel.type === DISCORD_CHANNEL_TYPES.text,
	);

	const operations = [];

	for (const category of layout) {
		if (!existingCategories.has(normalizeDiscordChannelName(category.name))) {
			operations.push({
				type: "create-category",
				name: category.name,
			});
		}
	}

	for (const category of layout) {
		const existingCategory = existingCategories.get(
			normalizeDiscordChannelName(category.name),
		);

		for (const channel of category.channels) {
			const matchingChannels = existingTextChannels.filter(
				(existingChannel) =>
					normalizeDiscordChannelName(existingChannel.name) ===
					normalizeDiscordChannelName(channel.name),
			);
			const channelInTargetCategory = matchingChannels.some(
				(existingChannel) => existingChannel.parent_id === existingCategory?.id,
			);

			if (channelInTargetCategory) {
				continue;
			}

			if (
				matchingChannels.length === 1 &&
				channel.adoptExistingUncategorized === true &&
				matchingChannels[0].parent_id == null
			) {
				operations.push({
					type: "move-text-channel",
					categoryName: category.name,
					channelId: matchingChannels[0].id,
					name: channel.name,
				});
				continue;
			}

			operations.push({
				type: "create-text-channel",
				categoryName: category.name,
				name: channel.name,
				topic: channel.topic,
			});
		}
	}

	return operations;
}
