import assert from "node:assert/strict";
import test from "node:test";

import {
	buildEnhancementPlan,
	createDiscordSnowflakeGenerator,
	ENHANCEMENT_CHANNELS,
	ENHANCEMENT_FORUMS,
	ENHANCEMENT_ROLES,
} from "./discord-community-enhancement.mjs";
import { DISCORD_CHANNEL_TYPES } from "./discord-community-plan.mjs";

test("plans a compact enhancement for a new Discord server", () => {
	const operations = buildEnhancementPlan({
		guild: { features: [] },
		roles: [{ id: "guild", name: "@everyone" }],
		channels: [
			{ id: "text-category", name: "Text Channels", type: 4 },
			{ id: "voice-category", name: "Voice Channels", type: 4 },
			{
				id: "voice-general",
				name: "General",
				parent_id: "voice-category",
				type: 2,
			},
		],
	});

	assert.equal(
		operations.filter((operation) => operation.type === "create-role").length,
		ENHANCEMENT_ROLES.length,
	);
	assert.equal(
		operations.filter((operation) => operation.type === "create-text-channel")
			.length,
		ENHANCEMENT_CHANNELS.length,
	);
	assert.equal(
		operations.some(
			(operation) =>
				operation.type === "rename-channel" && operation.name === "START HERE",
		),
		true,
	);
	assert.equal(
		operations.some((operation) => operation.type === "enable-community"),
		true,
	);
});

test("does not recreate existing roles or enhancement channels", () => {
	const startHereId = "start-here";
	const operations = buildEnhancementPlan({
		guild: { features: ["COMMUNITY"] },
		roles: ENHANCEMENT_ROLES.map((role, index) => ({
			...role,
			id: `role-${index}`,
		})),
		channels: [
			{
				id: startHereId,
				name: "START HERE",
				type: DISCORD_CHANNEL_TYPES.category,
			},
			{
				id: "hangout",
				name: "HANGOUT",
				type: DISCORD_CHANNEL_TYPES.category,
			},
			...ENHANCEMENT_CHANNELS.map((channel, index) => ({
				id: `channel-${index}`,
				name: channel.name,
				parent_id: startHereId,
				type: DISCORD_CHANNEL_TYPES.text,
			})),
		],
	});

	assert.deepEqual(operations, []);
});

test("generates unique numeric Discord snowflakes within the same millisecond", () => {
	const nextSnowflake = createDiscordSnowflakeGenerator(
		() => 1_784_652_000_000,
	);
	const first = nextSnowflake();
	const second = nextSnowflake();

	assert.match(first, /^\d+$/);
	assert.match(second, /^\d+$/);
	assert.notEqual(first, second);
});

test("plans the bug tracker forum under Help & Resources", () => {
	const operations = buildEnhancementPlan({
		guild: { features: ["COMMUNITY"] },
		roles: [],
		channels: [
			{
				id: "help",
				name: "HELP & RESOURCES",
				type: DISCORD_CHANNEL_TYPES.category,
			},
		],
	});

	assert.deepEqual(
		operations.filter((operation) => operation.type === "create-forum-channel"),
		[
			{
				type: "create-forum-channel",
				...ENHANCEMENT_FORUMS[0],
			},
		],
	);
});
