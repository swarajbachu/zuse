import assert from "node:assert/strict";
import test from "node:test";

import {
	buildCommunityPlan,
	COMMUNITY_LAYOUT,
	DISCORD_CHANNEL_TYPES,
} from "./discord-community-plan.mjs";

test("plans the complete community layout for an empty server", () => {
	const operations = buildCommunityPlan([]);

	assert.equal(
		operations.filter((operation) => operation.type === "create-category")
			.length,
		2,
	);
	assert.equal(
		operations.filter((operation) => operation.type === "create-text-channel")
			.length,
		6,
	);
});

test("does not duplicate existing categories or text channels", () => {
	const existingChannels = [
		...COMMUNITY_LAYOUT.map((category, index) => ({
			id: `category-${index}`,
			name: category.name.toLowerCase(),
			type: DISCORD_CHANNEL_TYPES.category,
		})),
		...COMMUNITY_LAYOUT.flatMap((category, categoryIndex) =>
			category.channels.map((channel, index) => ({
				id: `${category.name}-${index}`,
				name: channel.name.toUpperCase(),
				parent_id: `category-${categoryIndex}`,
				type: DISCORD_CHANNEL_TYPES.text,
			})),
		),
	];

	assert.deepEqual(buildCommunityPlan(existingChannels), []);
});

test("moves a uniquely named existing channel into the target category", () => {
	const operations = buildCommunityPlan([
		{
			id: "existing-general",
			name: "general",
			parent_id: null,
			type: DISCORD_CHANNEL_TYPES.text,
		},
	]);

	assert.deepEqual(
		operations.find((operation) => operation.name === "general"),
		{
			type: "move-text-channel",
			categoryName: "COMMUNITY",
			channelId: "existing-general",
			name: "general",
		},
	);
});

test("does not guess when multiple same-named channels exist outside the target category", () => {
	const operations = buildCommunityPlan([
		{
			id: "general-one",
			name: "general",
			parent_id: null,
			type: DISCORD_CHANNEL_TYPES.text,
		},
		{
			id: "general-two",
			name: "GENERAL",
			parent_id: "another-category",
			type: DISCORD_CHANNEL_TYPES.text,
		},
	]);

	assert.equal(
		operations.find((operation) => operation.name === "general")?.type,
		"create-text-channel",
	);
});

test("does not move a same-named channel from another category", () => {
	const operations = buildCommunityPlan([
		{
			id: "existing-resources",
			name: "resources",
			parent_id: "unrelated-category",
			type: DISCORD_CHANNEL_TYPES.text,
		},
	]);

	assert.equal(
		operations.find((operation) => operation.name === "resources")?.type,
		"create-text-channel",
	);
});

test("fails safely when multiple categories have the desired name", () => {
	assert.throws(
		() =>
			buildCommunityPlan([
				{
					id: "community-one",
					name: "COMMUNITY",
					type: DISCORD_CHANNEL_TYPES.category,
				},
				{
					id: "community-two",
					name: "community",
					type: DISCORD_CHANNEL_TYPES.category,
				},
			]),
		/Multiple Discord categories match the desired name: COMMUNITY/,
	);
});
