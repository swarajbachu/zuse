import {
	assertDiscordGuildId,
	createDiscordClient,
	requireEnvironmentVariable,
} from "./discord-api.mjs";
import {
	buildEnhancementPlan,
	createDiscordSnowflakeGenerator,
	ENHANCEMENT_CHANNELS,
	ENHANCEMENT_FORUMS,
	ENHANCEMENT_ROLES,
} from "./discord-community-enhancement.mjs";
import {
	DISCORD_CHANNEL_TYPES,
	normalizeDiscordChannelName,
} from "./discord-community-plan.mjs";

const PERMISSIONS = {
	viewChannel: 1_024n,
	sendMessages: 2_048n,
};

const token = requireEnvironmentVariable("DISCORD_BOT_TOKEN");
const guildId = requireEnvironmentVariable("DISCORD_GUILD_ID");
assertDiscordGuildId(guildId);

const dryRun = process.argv.includes("--dry-run");
const discord = createDiscordClient({ token });

const getServerState = async () => {
	const [guild, roles, channels] = await Promise.all([
		discord.request(`/guilds/${guildId}`),
		discord.request(`/guilds/${guildId}/roles`),
		discord.request(`/guilds/${guildId}/channels`),
	]);
	return { channels, guild, roles };
};

const initialState = await getServerState();
const initialPlan = buildEnhancementPlan(initialState);

if (dryRun) {
	console.log(
		JSON.stringify(
			{
				alwaysEnsuredOnApply: [
					"managed channel topics and permissions",
					"Community safety settings",
					"welcome screen",
					"native onboarding choices",
					"pinned starter guides",
				],
				structuralChanges: initialPlan,
			},
			null,
			2,
		),
	);
	process.exit(0);
}

const createChannel = (body) =>
	discord.requestJson(`/guilds/${guildId}/channels`, "POST", body);

const initialChannelsMatching = ({ name, parentId, type }) =>
	initialState.channels.filter(
		(channel) =>
			channel.type === type &&
			(parentId === undefined || channel.parent_id === parentId) &&
			normalizeDiscordChannelName(channel.name) ===
				normalizeDiscordChannelName(name),
	);

const assertAtMostOneInitialChannel = (query) => {
	const matches = initialChannelsMatching(query);
	if (matches.length > 1) {
		throw new Error(
			`Refusing to modify an ambiguous Discord layout: found ${matches.length} channels named ${query.name}`,
		);
	}
	return matches[0];
};

const assertExactlyOneInitialChannel = (query) => {
	const match = assertAtMostOneInitialChannel(query);
	if (!match) {
		throw new Error(
			`Missing required Discord channel or category: ${query.name}. Run discord:setup first.`,
		);
	}
	return match;
};

const preflightStartHere =
	assertAtMostOneInitialChannel({
		name: "START HERE",
		type: DISCORD_CHANNEL_TYPES.category,
	}) ??
	assertAtMostOneInitialChannel({
		name: "Text Channels",
		type: DISCORD_CHANNEL_TYPES.category,
	});
const preflightHangout =
	assertAtMostOneInitialChannel({
		name: "HANGOUT",
		type: DISCORD_CHANNEL_TYPES.category,
	}) ??
	assertAtMostOneInitialChannel({
		name: "Voice Channels",
		type: DISCORD_CHANNEL_TYPES.category,
	});
const preflightCommunity = assertExactlyOneInitialChannel({
	name: "COMMUNITY",
	type: DISCORD_CHANNEL_TYPES.category,
});
const preflightHelp = assertExactlyOneInitialChannel({
	name: "HELP & RESOURCES",
	type: DISCORD_CHANNEL_TYPES.category,
});
for (const desiredRole of ENHANCEMENT_ROLES) {
	const matches = initialState.roles.filter(
		(role) =>
			role.name.trim().toLowerCase() === desiredRole.name.trim().toLowerCase(),
	);
	if (matches.length > 1) {
		throw new Error(
			`Refusing to use an ambiguous self-assignable role: found ${matches.length} roles named ${desiredRole.name}`,
		);
	}
	if (matches[0] && BigInt(matches[0].permissions) !== 0n) {
		throw new Error(
			`Refusing to make ${desiredRole.name} self-assignable because it has elevated permissions`,
		);
	}
	if (matches[0]?.managed) {
		throw new Error(
			`Refusing to adopt the integration-managed role ${desiredRole.name}`,
		);
	}
	const privilegedChannelOverwrite = matches[0]
		? initialState.channels.find((channel) =>
				channel.permission_overwrites?.some(
					(overwrite) =>
						overwrite.id === matches[0].id && BigInt(overwrite.allow) !== 0n,
				),
			)
		: undefined;
	if (privilegedChannelOverwrite) {
		throw new Error(
			`Refusing to make ${desiredRole.name} self-assignable because it has elevated access in #${privilegedChannelOverwrite.name}`,
		);
	}
}

for (const desiredChannel of ENHANCEMENT_CHANNELS) {
	assertAtMostOneInitialChannel({
		name: desiredChannel.name,
		parentId: preflightStartHere?.id,
		type: DISCORD_CHANNEL_TYPES.text,
	});
}
assertAtMostOneInitialChannel({
	name: "general",
	parentId: preflightHangout?.id,
	type: 2,
});
for (const name of [
	"general",
	"vibe-coders",
	"token-maxers",
	"vibe-scientists",
]) {
	assertExactlyOneInitialChannel({
		name,
		parentId: preflightCommunity.id,
		type: DISCORD_CHANNEL_TYPES.text,
	});
}
for (const name of ["resources", "bug-reports"]) {
	assertExactlyOneInitialChannel({
		name,
		parentId: preflightHelp.id,
		type: DISCORD_CHANNEL_TYPES.text,
	});
}
for (const desiredForum of ENHANCEMENT_FORUMS) {
	assertAtMostOneInitialChannel({
		name: desiredForum.name,
		parentId: preflightHelp.id,
		type: DISCORD_CHANNEL_TYPES.forum,
	});
}

const ensureCategory = async (targetName, fallbackName) => {
	const channels = await discord.request(`/guilds/${guildId}/channels`);
	const target = channels.find(
		(channel) =>
			channel.type === DISCORD_CHANNEL_TYPES.category &&
			normalizeDiscordChannelName(channel.name) ===
				normalizeDiscordChannelName(targetName),
	);
	if (target) {
		return target;
	}

	const fallback = channels.find(
		(channel) =>
			channel.type === DISCORD_CHANNEL_TYPES.category &&
			normalizeDiscordChannelName(channel.name) ===
				normalizeDiscordChannelName(fallbackName),
	);
	if (fallback) {
		const renamed = await discord.requestJson(
			`/channels/${fallback.id}`,
			"PATCH",
			{ name: targetName },
		);
		console.log(`Renamed category: ${fallback.name} → ${targetName}`);
		return renamed;
	}

	const created = await createChannel({
		name: targetName,
		type: DISCORD_CHANNEL_TYPES.category,
	});
	console.log(`Created category: ${targetName}`);
	return created;
};

const startHere = await ensureCategory("START HERE", "Text Channels");
const hangout = await ensureCategory("HANGOUT", "Voice Channels");

const channelsAfterCategories = await discord.request(
	`/guilds/${guildId}/channels`,
);
const defaultVoiceChannel = channelsAfterCategories.find(
	(channel) =>
		channel.type === 2 &&
		channel.parent_id === hangout.id &&
		normalizeDiscordChannelName(channel.name) === "general",
);
if (defaultVoiceChannel) {
	await discord.requestJson(`/channels/${defaultVoiceChannel.id}`, "PATCH", {
		name: "vibe-lounge",
	});
	console.log("Renamed voice channel: General → vibe-lounge");
}

const rolesByName = new Map(
	initialState.roles.map((role) => [role.name.trim().toLowerCase(), role]),
);
for (const desiredRole of ENHANCEMENT_ROLES) {
	const normalizedName = desiredRole.name.toLowerCase();
	if (rolesByName.has(normalizedName)) {
		continue;
	}
	const role = await discord.requestJson(`/guilds/${guildId}/roles`, "POST", {
		colors: {
			primary_color: desiredRole.color,
			secondary_color: null,
			tertiary_color: null,
		},
		hoist: false,
		mentionable: false,
		name: desiredRole.name,
		permissions: "0",
	});
	rolesByName.set(normalizedName, role);
	console.log(`Created role: ${desiredRole.name}`);
}

const permissionOverwritesFor = (visibility, existingOverwrites = []) => {
	const preservedOverwrites = existingOverwrites.filter(
		(overwrite) => overwrite.id !== guildId,
	);
	const everyoneOverwrite = existingOverwrites.find(
		(overwrite) => overwrite.id === guildId,
	);
	const existingAllow = BigInt(everyoneOverwrite?.allow ?? "0");
	const existingDeny = BigInt(everyoneOverwrite?.deny ?? "0");
	const managedMask =
		visibility === "private"
			? PERMISSIONS.viewChannel
			: PERMISSIONS.viewChannel | PERMISSIONS.sendMessages;
	const desiredAllow = visibility === "private" ? 0n : PERMISSIONS.viewChannel;
	const desiredDeny =
		visibility === "private"
			? PERMISSIONS.viewChannel
			: PERMISSIONS.sendMessages;
	const allow = (existingAllow & ~managedMask) | desiredAllow;
	const deny = (existingDeny & ~managedMask) | desiredDeny;

	return [
		...preservedOverwrites,
		{
			id: guildId,
			type: 0,
			allow: allow.toString(),
			deny: deny.toString(),
		},
	];
};

const enhancedChannels = new Map();
for (const desiredChannel of ENHANCEMENT_CHANNELS) {
	const currentChannels = await discord.request(`/guilds/${guildId}/channels`);
	let channel = currentChannels.find(
		(existingChannel) =>
			existingChannel.type === DISCORD_CHANNEL_TYPES.text &&
			existingChannel.parent_id === startHere.id &&
			normalizeDiscordChannelName(existingChannel.name) === desiredChannel.name,
	);
	if (!channel) {
		channel = await createChannel({
			name: desiredChannel.name,
			parent_id: startHere.id,
			permission_overwrites: permissionOverwritesFor(desiredChannel.visibility),
			topic: desiredChannel.topic,
			type: DISCORD_CHANNEL_TYPES.text,
		});
		console.log(`Created channel: #${desiredChannel.name}`);
	} else {
		channel = await discord.requestJson(`/channels/${channel.id}`, "PATCH", {
			parent_id: startHere.id,
			permission_overwrites: permissionOverwritesFor(
				desiredChannel.visibility,
				channel.permission_overwrites,
			),
			topic: desiredChannel.topic,
		});
	}
	enhancedChannels.set(desiredChannel.name, channel);
}

const bugForumDefinition = ENHANCEMENT_FORUMS[0];
const channelsBeforeForum = await discord.request(
	`/guilds/${guildId}/channels`,
);
let bugForum = channelsBeforeForum.find(
	(channel) =>
		channel.type === DISCORD_CHANNEL_TYPES.forum &&
		channel.parent_id === preflightHelp.id &&
		normalizeDiscordChannelName(channel.name) === bugForumDefinition.name,
);
if (!bugForum) {
	bugForum = await createChannel({
		available_tags: [
			{ emoji_name: "🆕", moderated: false, name: "New" },
			{ emoji_name: "🔎", moderated: false, name: "Investigating" },
			{ emoji_name: "❓", moderated: false, name: "Needs info" },
			{ emoji_name: "✅", moderated: true, name: "Resolved" },
			{ emoji_name: "⛔", moderated: true, name: "Won't fix" },
		],
		default_auto_archive_duration: 10_080,
		default_forum_layout: 1,
		default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
		default_sort_order: 0,
		name: bugForumDefinition.name,
		parent_id: preflightHelp.id,
		topic: bugForumDefinition.topic,
		type: DISCORD_CHANNEL_TYPES.forum,
	});
	console.log(`Created forum channel: #${bugForumDefinition.name}`);
}

const refreshedChannels = await discord.request(`/guilds/${guildId}/channels`);
const requireUniqueChannel = ({ name, parentId, type }) => {
	const matches = refreshedChannels.filter(
		(channel) =>
			channel.type === type &&
			(parentId === undefined || channel.parent_id === parentId) &&
			normalizeDiscordChannelName(channel.name) ===
				normalizeDiscordChannelName(name),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one Discord channel named ${name}, found ${matches.length}`,
		);
	}
	return matches[0];
};

const communityCategory = requireUniqueChannel({
	name: "COMMUNITY",
	type: DISCORD_CHANNEL_TYPES.category,
});
const helpCategory = requireUniqueChannel({
	name: "HELP & RESOURCES",
	type: DISCORD_CHANNEL_TYPES.category,
});

const welcome = enhancedChannels.get("welcome");
const announcements = enhancedChannels.get("announcements");
const communityUpdates = enhancedChannels.get("community-updates");
const general = requireUniqueChannel({
	name: "general",
	parentId: communityCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
const vibeCoders = requireUniqueChannel({
	name: "vibe-coders",
	parentId: communityCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
const tokenMaxers = requireUniqueChannel({
	name: "token-maxers",
	parentId: communityCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
const vibeScientists = requireUniqueChannel({
	name: "vibe-scientists",
	parentId: communityCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
const resources = requireUniqueChannel({
	name: "resources",
	parentId: helpCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
const bugReports = requireUniqueChannel({
	name: "bug-reports",
	parentId: helpCategory.id,
	type: DISCORD_CHANNEL_TYPES.text,
});
bugForum = requireUniqueChannel({
	name: bugForumDefinition.name,
	parentId: helpCategory.id,
	type: DISCORD_CHANNEL_TYPES.forum,
});

const requiredChannels = {
	announcements,
	bugReports,
	bugForum,
	communityUpdates,
	general,
	resources,
	tokenMaxers,
	vibeCoders,
	vibeScientists,
	welcome,
};
for (const [name, channel] of Object.entries(requiredChannels)) {
	if (!channel) {
		throw new Error(`Missing required Discord channel: ${name}`);
	}
}

const latestGuild = await discord.request(`/guilds/${guildId}`);
const communityFeatures = Array.from(
	new Set([...latestGuild.features, "COMMUNITY"]),
);
await discord.requestJson(`/guilds/${guildId}`, "PATCH", {
	description:
		"A practical community for people building, experimenting, and shipping with AI.",
	default_message_notifications: 1,
	explicit_content_filter: 2,
	features: communityFeatures,
	preferred_locale: "en-US",
	public_updates_channel_id: communityUpdates.id,
	rules_channel_id: welcome.id,
	safety_alerts_channel_id: communityUpdates.id,
	verification_level: 1,
});
console.log("Enabled and configured Discord Community mode");

await discord.requestJson(`/guilds/${guildId}/welcome-screen`, "PATCH", {
	description:
		"Build with AI, share what works, and help make the tools better.",
	enabled: true,
	welcome_channels: [
		{
			channel_id: general.id,
			description: "Meet the community and start a conversation",
			emoji_id: null,
			emoji_name: "👋",
		},
		{
			channel_id: vibeCoders.id,
			description: "Share builds, prompts, and experiments",
			emoji_id: null,
			emoji_name: "🛠️",
		},
		{
			channel_id: resources.id,
			description: "Find useful guides, links, and tools",
			emoji_id: null,
			emoji_name: "📚",
		},
		{
			channel_id: bugForum.id,
			description: "Open one trackable post for each bug",
			emoji_id: null,
			emoji_name: "🐛",
		},
	],
});
console.log("Configured the server welcome screen");

const roleId = (name) => {
	const role = rolesByName.get(name.toLowerCase());
	if (!role) {
		throw new Error(`Missing required Discord role: ${name}`);
	}
	return role.id;
};

const existingOnboarding = await discord.request(
	`/guilds/${guildId}/onboarding`,
);
const existingInterestPrompt = existingOnboarding.prompts.find(
	(prompt) => prompt.title === "What are you here for?",
);
const nextSnowflake = createDiscordSnowflakeGenerator();
const promptId = existingInterestPrompt?.id ?? nextSnowflake();
const optionId = (title) =>
	existingInterestPrompt?.options.find((option) => option.title === title)
		?.id ?? nextSnowflake();

const managedOnboardingOptions = [
	{
		channel_ids: [vibeCoders.id],
		description: "Build quickly, share prompts, and swap practical techniques.",
		emoji_animated: false,
		emoji_id: null,
		emoji_name: "🛠️",
		id: optionId("Vibe coding"),
		role_ids: [roleId("Vibe Coder")],
		title: "Vibe coding",
	},
	{
		channel_ids: [tokenMaxers.id],
		description: "Push context windows and serious AI workflows further.",
		emoji_animated: false,
		emoji_id: null,
		emoji_name: "⚡",
		id: optionId("Token-heavy workflows"),
		role_ids: [roleId("Token Maxer")],
		title: "Token-heavy workflows",
	},
	{
		channel_ids: [vibeScientists.id],
		description: "Run systematic experiments and share evidence.",
		emoji_animated: false,
		emoji_id: null,
		emoji_name: "🧪",
		id: optionId("Research and experiments"),
		role_ids: [roleId("Vibe Scientist")],
		title: "Research and experiments",
	},
	{
		channel_ids: [bugForum.id],
		description: "Find sharp edges and help make the product sturdier.",
		emoji_animated: false,
		emoji_id: null,
		emoji_name: "🐛",
		id: optionId("Bug hunting"),
		role_ids: [roleId("Bug Hunter")],
		title: "Bug hunting",
	},
	{
		channel_ids: [announcements.id],
		description: "Get pinged for meaningful releases and product news.",
		emoji_animated: false,
		emoji_id: null,
		emoji_name: "📣",
		id: optionId("Product updates"),
		role_ids: [roleId("Product Updates")],
		title: "Product updates",
	},
];
const managedOptionTitles = new Set(
	managedOnboardingOptions.map((option) => option.title),
);
const normalizeOnboardingOption = (option) => ({
	channel_ids: option.channel_ids,
	description: option.description,
	emoji_animated: option.emoji_animated ?? option.emoji?.animated ?? false,
	emoji_id: option.emoji_id ?? option.emoji?.id ?? null,
	emoji_name: option.emoji_name ?? option.emoji?.name ?? null,
	id: option.id,
	role_ids: option.role_ids,
	title: option.title,
});
const normalizeOnboardingPrompt = (prompt) => ({
	id: prompt.id,
	in_onboarding: prompt.in_onboarding,
	options: prompt.options.map(normalizeOnboardingOption),
	required: prompt.required,
	single_select: prompt.single_select,
	title: prompt.title,
	type: prompt.type,
});
const managedPrompt = {
	id: promptId,
	in_onboarding: true,
	options: [
		...managedOnboardingOptions,
		...(existingInterestPrompt?.options
			.filter((option) => !managedOptionTitles.has(option.title))
			.map(normalizeOnboardingOption) ?? []),
	],
	required: true,
	single_select: false,
	title: "What are you here for?",
	type: 0,
};
const managedDefaultChannelIds = [
	welcome.id,
	announcements.id,
	general.id,
	resources.id,
	bugReports.id,
];

await discord.requestJson(`/guilds/${guildId}/onboarding`, "PUT", {
	default_channel_ids: Array.from(
		new Set([
			...existingOnboarding.default_channel_ids,
			...managedDefaultChannelIds,
		]),
	),
	enabled: true,
	mode: 1,
	prompts: [
		...existingOnboarding.prompts
			.filter((prompt) => prompt.id !== existingInterestPrompt?.id)
			.map(normalizeOnboardingPrompt),
		managedPrompt,
	],
});
console.log("Enabled native role and channel selection");

const ensurePinnedEmbed = async (channel, marker, embed) => {
	const pinnedMessages = await discord.request(`/channels/${channel.id}/pins`);
	let message = pinnedMessages.find((candidate) =>
		candidate.embeds.some((candidateEmbed) =>
			candidateEmbed.footer?.text?.includes(marker),
		),
	);
	if (!message) {
		message = await discord.requestJson(
			`/channels/${channel.id}/messages`,
			"POST",
			{
				allowed_mentions: { parse: [] },
				embeds: [
					{
						...embed,
						footer: { text: marker },
					},
				],
			},
		);
		console.log(`Posted starter guide in #${channel.name}`);
	} else {
		message = await discord.requestJson(
			`/channels/${channel.id}/messages/${message.id}`,
			"PATCH",
			{
				allowed_mentions: { parse: [] },
				embeds: [
					{
						...embed,
						footer: { text: marker },
					},
				],
			},
		);
	}
	await discord.request(`/channels/${channel.id}/pins/${message.id}`, {
		method: "PUT",
	});
};

await ensurePinnedEmbed(welcome, "Zuse welcome guide", {
	color: 0x5865f2,
	description:
		"This is a focused home for people building with AI. Choose what you care about in **Channels & Roles**, then jump into a conversation.",
	fields: [
		{
			inline: false,
			name: "1 — Pick your lanes",
			value:
				"Open **Channels & Roles** above the channel list. You can change your roles and channel choices any time.",
		},
		{
			inline: false,
			name: "2 — Say hello",
			value: `Introduce yourself in <#${general.id}> and tell us what you are building.`,
		},
		{
			inline: false,
			name: "3 — Keep it useful",
			value:
				"Share context, be specific, critique ideas without attacking people, and redact secrets from screenshots or logs.",
		},
	],
	title: "Welcome to Zuse",
});

await ensurePinnedEmbed(announcements, "Zuse announcements guide", {
	color: 0xf1c40f,
	description:
		"Meaningful releases and community updates will appear here. Pick the **Product Updates** role in Channels & Roles if you want release pings.",
	title: "Signal, not noise",
});

await ensurePinnedEmbed(resources, "Zuse resources guide", {
	color: 0x2ecc71,
	description:
		"Share resources that save real time: guides, tools, reproducible workflows, useful prompts, and technical references. Add one sentence explaining why each link is worth opening.",
	title: "The useful shelf",
});

await ensurePinnedEmbed(bugReports, "Zuse bug report template", {
	color: 0xe67e22,
	description: `Create a post in <#${bugForum.id}> using this structure. One post per bug keeps discussion, status, and resolution together. Never include passwords, API keys, tokens, or private customer data.`,
	fields: [
		{
			inline: false,
			name: "What happened?",
			value: "A short, concrete description.",
		},
		{
			inline: false,
			name: "What did you expect?",
			value: "The behavior you expected instead.",
		},
		{
			inline: false,
			name: "How can we reproduce it?",
			value: "Numbered steps, starting from a clean state.",
		},
		{
			inline: false,
			name: "Environment",
			value: "App version, operating system, provider, and model.",
		},
	],
	title: "A bug report we can act on",
});

console.log("Discord community enhancement completed successfully.");
