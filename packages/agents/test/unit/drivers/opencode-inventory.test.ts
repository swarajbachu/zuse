import { describe, expect, it } from "vitest";

import {
	collectInventoryProviders,
	filterPrimaryAgents,
	isUsableOpencodeInventoryModel,
} from "../../../src/drivers/opencode.ts";

describe("OpenCode model inventory", () => {
	it("removes retired Opus 4.5 while keeping current tool-capable models", () => {
		expect(
			isUsableOpencodeInventoryModel({
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5",
			}),
		).toBe(false);
		expect(
			isUsableOpencodeInventoryModel({
				id: "claude-opus-5",
				name: "Claude Opus 5",
				capabilities: { toolcall: true },
			}),
		).toBe(true);
	});

	it("omits null descriptions and hidden internal agents", () => {
		expect(
			filterPrimaryAgents([
				{ name: "build", mode: "primary", description: "Build" },
				{ name: "plan", mode: "primary", description: null },
				{ name: "autoaccept", mode: "primary", hidden: false },
				{ name: "compaction", mode: "primary", description: null, hidden: true },
				{ name: "explore", mode: "all" },
				{ name: "hidden", mode: "subagent", description: "ignored" },
			]),
		).toEqual([
			{ name: "build", mode: "primary", description: "Build" },
			{ name: "plan", mode: "primary" },
			{ name: "autoaccept", mode: "primary" },
			{ name: "explore", mode: "all" },
		]);
	});

	it("coerces messy provider.list() rows into schema-safe inventory", () => {
		expect(
			collectInventoryProviders(
				[
					{
						id: "openai",
						name: "OpenAI",
						env: ["OPENAI_API_KEY"],
						models: {
							"gpt-4o": {
								id: "gpt-4o",
								name: "GPT-4o",
								status: "active",
								capabilities: { toolcall: true },
								variants: { high: {}, medium: {} },
							},
							tts: {
								id: "tts",
								name: "TTS",
								status: "active",
								capabilities: { toolcall: false },
							},
							broken: null,
						},
					},
					{
						id: "weird",
						name: null,
						env: null,
						models: null,
					},
					{
						id: null,
						name: "skip me",
					},
				],
				["openai", "weird"],
				new Set(),
				new Map([["openai", "https://platform.openai.com"]]),
			),
		).toEqual([
			{
				id: "openai",
				name: "OpenAI",
				connected: true,
				custom: false,
				apiKeyEnv: "OPENAI_API_KEY",
				apiKeyUrl: "https://platform.openai.com",
				models: [
					{
						id: "openai/gpt-4o",
						label: "GPT-4o",
						variants: ["high", "medium"],
					},
				],
			},
			{
				id: "weird",
				name: "weird",
				connected: true,
				custom: false,
				apiKeyEnv: "",
				apiKeyUrl: "",
				models: [],
			},
		]);
	});
});
