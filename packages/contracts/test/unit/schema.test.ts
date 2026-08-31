import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	AdvertisedEndpoint,
	AgentEvent,
	ApiAuthTokenGrant,
	ApiEnvironmentList,
	ApiLinkStatus,
	Chat,
	ComposerInput,
	defaultModelEnabledByProvider,
	defaultModelFor,
	EnvironmentDescriptor,
	FsFileContent,
	GitBranchInfo,
	GitReviewSummary,
	isModelVisible,
	Message,
	MODELS_BY_PROVIDER,
	PokemonPokedexEntry,
	RepositorySettingsFile,
	resolveModelSlug,
	Session,
	SessionTimelineFrame,
	SettingsFile,
	visibleModelsForProvider,
	Worktree,
} from "../../src/index.ts";

/**
 * These guard the renderer↔server wire contract: every payload that crosses
 * the RPC boundary is encoded to plain JSON on one side and decoded on the
 * other. A round-trip (decode∘encode) that isn't the identity, or a schema
 * that silently accepts malformed input, is a contract break.
 */

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, encoded: I): void => {
	const decoded = Schema.decodeUnknownSync(schema)(encoded);
	const reEncoded = Schema.encodeSync(schema)(decoded);
	expect(reEncoded).toEqual(encoded);
};

describe("Environment capabilities", () => {
	it("decodes an older environment descriptor with no capabilities", () => {
		roundTrip(EnvironmentDescriptor, {
			environmentId: "environment-1",
			providerKind: "desktop" as const,
			endpoint: {
				httpBaseUrl: "http://127.0.0.1:47837",
				wsBaseUrl: "ws://127.0.0.1:47837",
			},
		});
	});

	it("round-trips additive mobile capabilities", () => {
		roundTrip(EnvironmentDescriptor, {
			environmentId: "environment-1",
			providerKind: "desktop" as const,
			endpoint: {
				httpBaseUrl: "http://127.0.0.1:47837",
				wsBaseUrl: "ws://127.0.0.1:47837",
			},
			capabilities: {
				version: 1,
				features: [
					"mobile-terminal-v1",
					"attachment-read-v1",
					"voice-account-transcription-v1",
					"git-remote-actions-v1",
					"desktop-handoff-v1",
				] as const,
			},
		});
	});
});

describe("FsFileContent round-trip", () => {
	it("preserves binary bytes over the wire", () => {
		roundTrip(FsFileContent, {
			kind: "binary",
			bytes: "AAEC/w==",
			size: 4,
		});
	});
});

describe("AgentEvent round-trips", () => {
	const cases: ReadonlyArray<{ name: string; encoded: unknown }> = [
		{
			name: "Started",
			encoded: {
				_tag: "Started",
				sessionId: "s1",
				providerId: "claude",
				mode: "sdk",
			},
		},
		{
			name: "Status",
			encoded: { _tag: "Status", status: "running" },
		},
		{
			name: "AssistantMessage",
			encoded: { _tag: "AssistantMessage", itemId: "i1", text: "hello" },
		},
		{
			name: "Thinking",
			encoded: { _tag: "Thinking", itemId: "i2", text: "hmm", redacted: false },
		},
		{
			name: "ToolUse (unknown input survives)",
			encoded: {
				_tag: "ToolUse",
				itemId: "i3",
				tool: "Edit",
				input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
			},
		},
		{
			name: "ToolResult",
			encoded: {
				_tag: "ToolResult",
				itemId: "i4",
				output: "done",
				isError: false,
			},
		},
		{
			name: "Error",
			encoded: { _tag: "Error", message: "boom" },
		},
		{
			name: "UsageDelta",
			encoded: {
				_tag: "UsageDelta",
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				model: "claude-opus-4-8",
			},
		},
		{
			name: "ContextCompaction",
			encoded: {
				_tag: "ContextCompaction",
				itemId: "compact1",
				providerId: "codex",
				startedAt: 1_800_000_000,
				durationMs: 37_000,
				beforeTokens: 231_450,
				afterTokens: 9_535,
				status: "completed",
			},
		},
		{
			name: "Completed",
			encoded: { _tag: "Completed", reason: "ended" },
		},
	];

	for (const c of cases) {
		it(`round-trips ${c.name}`, () => {
			roundTrip(AgentEvent, c.encoded as never);
		});
	}

	it("rejects an event with no _tag", () => {
		expect(() =>
			Schema.decodeUnknownSync(AgentEvent)({ text: "no tag" }),
		).toThrow();
	});

	it("rejects an unknown _tag", () => {
		expect(() =>
			Schema.decodeUnknownSync(AgentEvent)({ _tag: "Nonsense" }),
		).toThrow();
	});

	it("rejects a known event missing a required field", () => {
		expect(() =>
			Schema.decodeUnknownSync(AgentEvent)({
				_tag: "ToolResult",
				itemId: "i",
				output: "o",
			}),
		).toThrow(); // isError missing
	});

	it("rejects an invalid enum literal", () => {
		expect(() =>
			Schema.decodeUnknownSync(AgentEvent)({
				_tag: "Status",
				status: "spinning",
			}),
		).toThrow();
	});
});

describe("AdvertisedEndpoint round-trip", () => {
	const encoded = {
		id: "tunnel:managed-api",
		label: "Managed tunnel",
		providerKind: "tunnel" as const,
		httpBaseUrl: "https://env.example.test",
		wsBaseUrl: "wss://env.example.test/rpc",
		reachability: "tunnel" as const,
		compatibility: { hostedHttpsApp: "compatible" as const },
		status: "available" as const,
		isDefault: true,
	};

	it("round-trips the advertised endpoint wire shape", () => {
		roundTrip(AdvertisedEndpoint, encoded);
	});

	it("rejects invalid enum literals", () => {
		expect(() =>
			Schema.decodeUnknownSync(AdvertisedEndpoint)({
				...encoded,
				reachability: "vpn",
			}),
		).toThrow();
	});
});

describe("ApiLinkStatus advertised endpoint compatibility", () => {
	const base = {
		linked: true,
		apiUrl: "https://api.example.test",
		environmentId: "env_123",
		label: "Mac",
		heartbeatActive: true,
	};

	it("decodes legacy status without advertisedEndpoints", () => {
		const decoded = Schema.decodeUnknownSync(ApiLinkStatus)(base);
		expect(decoded.linked).toBe(true);
		expect(decoded.advertisedEndpoints).toBeUndefined();
	});

	it("round-trips status with advertisedEndpoints", () => {
		roundTrip(ApiLinkStatus, {
			...base,
			advertisedEndpoints: [
				{
					id: "core:lan",
					label: "LAN",
					providerKind: "core" as const,
					httpBaseUrl: "http://192.168.1.10:8787",
					wsBaseUrl: "ws://192.168.1.10:8787",
					reachability: "lan" as const,
					compatibility: { hostedHttpsApp: "mixed-content-blocked" as const },
					status: "available" as const,
					isDefault: true,
				},
			],
		});
	});
});

describe("ApiAuthTokenGrant", () => {
	it("accepts authorization-code and refresh-token grants", () => {
		roundTrip(ApiAuthTokenGrant, {
			grantType: "authorization_code",
			code: "code",
			codeVerifier: "verifier",
		});
		roundTrip(ApiAuthTokenGrant, {
			grantType: "refresh_token",
			refreshToken: "refresh-token",
		});
	});

	it("rejects incomplete grants", () => {
		expect(() =>
			Schema.decodeUnknownSync(ApiAuthTokenGrant)({
				grantType: "authorization_code",
				code: "code",
			}),
		).toThrow();
	});
});

describe("ApiEnvironmentList compatibility", () => {
	it("decodes legacy environment records without endpoint", () => {
		const decoded = Schema.decodeUnknownSync(ApiEnvironmentList)({
			environments: [
				{
					environmentId: "env_123",
					label: "Mac",
					providerKind: "desktop",
					linkedAt: Date.now(),
				},
			],
		});

		expect(decoded.environments[0]?.endpoint).toBeUndefined();
	});
});

describe("GitReviewSummary compatibility", () => {
	it("decodes summaries from desktops that predate headRef", () => {
		const decoded = Schema.decodeUnknownSync(GitReviewSummary)({
			baseRef: "origin/main",
			baseSha: "base",
			headSha: "head",
			files: [],
			additions: 0,
			deletions: 0,
		});

		expect(decoded.headRef).toBeNull();
		expect(decoded.scope).toBe("branch");
	});
});

describe("Session round-trip", () => {
	const encoded = {
		id: "sess1",
		projectId: "proj1",
		title: "My session",
		titleProvenance: "manual" as const,
		providerId: "claude" as const,
		model: "claude-opus-4-8",
		status: "idle" as const,
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none" as const,
		runtimeMode: "approval-required" as const,
		worktreeId: null,
		chatId: "chat1",
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default" as const,
		toolSearch: false,
		createdAt: "2026-06-17T00:00:00.000Z",
		updatedAt: "2026-06-17T00:00:00.000Z",
	};

	it("decodes dates and re-encodes them as ISO strings", () => {
		const session = Schema.decodeUnknownSync(Session)(encoded);
		expect(session.createdAt).toBeInstanceOf(Date);
		expect(Schema.encodeSync(Session)(session)).toEqual(encoded);
	});

	it("round-trips an archived session", () => {
		roundTrip(Session, {
			...encoded,
			archivedAt: "2026-06-17T12:00:00.000Z",
			cursor: "claude-session-abc",
			resumeStrategy: "claude-session-id" as const,
		});
	});

	it("rejects an unknown status literal", () => {
		expect(() =>
			Schema.decodeUnknownSync(Session)({ ...encoded, status: "zombie" }),
		).toThrow();
	});
});

describe("Session timeline frame round-trip", () => {
	it("round-trips an automatic historical snapshot chunk", () => {
		roundTrip(SessionTimelineFrame, {
			kind: "snapshot-chunk",
			sessionId: "session-restored",
			throughVersion: 3,
			cursor: { epoch: "restore-2", version: 3 },
			messages: [],
			olderMessageSequence: null,
		});
	});

	it("keeps reset cursor and head version together", () => {
		roundTrip(SessionTimelineFrame, {
			kind: "reset-required",
			sessionId: "session-restored",
			throughVersion: 3,
			cursor: { epoch: "restore-2", version: 3 },
			reason: "restored" as const,
		});
	});
});

describe("Message round-trip", () => {
	const base = {
		id: "msg1",
		sessionId: "sess1",
		createdAt: "2026-06-17T00:00:00.000Z",
	};

	it("round-trips a user message", () => {
		roundTrip(Message, {
			...base,
			role: "user" as const,
			content: { _tag: "user", text: "hi" },
		});
	});

	it("round-trips a rich user message with code annotations", () => {
		roundTrip(Message, {
			...base,
			role: "user" as const,
			content: {
				_tag: "user_rich",
				text: "please adjust this",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [
					{
						id: "ann1",
						relPath: "src/app.ts",
						absPath: "/repo/src/app.ts",
						startLine: 10,
						endLine: 12,
						comment: "make this clearer",
					},
				],
			},
		});
	});

	it("decodes legacy rich user messages without annotations", () => {
		const decoded = Schema.decodeUnknownSync(Message)({
			...base,
			role: "user" as const,
			content: {
				_tag: "user_rich",
				text: "legacy",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			},
		});
		expect(decoded.content._tag).toBe("user_rich");
		if (decoded.content._tag === "user_rich") {
			expect(decoded.content.annotations).toEqual([]);
		}
	});

	it("round-trips a tool_use message with unknown input", () => {
		roundTrip(Message, {
			...base,
			role: "assistant" as const,
			content: {
				_tag: "tool_use",
				itemId: "i1",
				tool: "Bash",
				input: { command: "ls" },
			},
		});
	});

	it("round-trips a context compaction message", () => {
		roundTrip(Message, {
			...base,
			role: "system" as const,
			content: {
				_tag: "context_compaction",
				itemId: "compact1",
				providerId: "codex",
				startedAt: 1_800_000_000,
				durationMs: 37_000,
				beforeTokens: 231_450,
				afterTokens: 9_535,
				status: "completed",
			},
		});
	});

	it("rejects an unknown content _tag", () => {
		expect(() =>
			Schema.decodeUnknownSync(Message)({
				...base,
				role: "user",
				content: { _tag: "telepathy", text: "hi" },
			}),
		).toThrow();
	});
});

describe("Pokemon and Worktree round-trips", () => {
	it("round-trips an unlocked Pokedex entry", () => {
		roundTrip(PokemonPokedexEntry, {
			number: 25,
			slug: "pikachu",
			name: "Pikachu",
			generation: 1,
			rarity: "rare" as const,
			points: 75,
			unlocked: true,
			unlockedAt: "2026-06-18T00:00:00.000Z",
			worktreeId: "wt1",
			spriteUrl: "zuse://pokemon/25",
			silhouetteUrl:
				"https://img.pokemondb.net/sprites/scarlet-violet/icon/pikachu.png",
			variants: [
				{
					id: "home",
					label: "Home",
					spriteUrl: "zuse://pokemon/25-home",
				},
			],
			evolutionLine: [
				{
					number: 25,
					slug: "pikachu",
					name: "Pikachu",
					rarity: "rare" as const,
					unlocked: true,
					spriteUrl: "zuse://pokemon/25",
					silhouetteUrl:
						"https://img.pokemondb.net/sprites/scarlet-violet/icon/pikachu.png",
				},
			],
		});
	});

	it("round-trips a worktree with Pokémon metadata", () => {
		roundTrip(Worktree, {
			id: "wt1",
			projectId: "proj1",
			path: "/tmp/pikachu",
			name: "pikachu",
			branch: "pikachu",
			branchProvenance: "manual" as const,
			baseBranch: "main",
			createdAt: "2026-06-18T00:00:00.000Z",
			setupStatus: "skipped" as const,
			setupOutput: "",
			setupStartedAt: null,
			setupFinishedAt: null,
			pokemon: {
				number: 25,
				slug: "pikachu",
				name: "Pikachu",
				generation: 1,
				rarity: "rare" as const,
				points: 75,
				spriteUrl: "zuse://pokemon/25",
			},
		});
	});
});

describe("Chat round-trip", () => {
	it("round-trips a chat row", () => {
		roundTrip(Chat, {
			id: "chat1",
			projectId: "proj1",
			worktreeId: null,
			title: "Chat",
			titleProvenance: "manual" as const,
			activeSessionId: "sess1",
			originSessionId: null,
			archivedAt: null,
			lastMessageAt: null,
			lastReadAt: "2026-06-17T00:00:00.000Z",
			createdAt: "2026-06-17T00:00:00.000Z",
			updatedAt: "2026-06-17T00:00:00.000Z",
		});
	});
});

describe("ComposerInput round-trip", () => {
	it("round-trips code annotations", () => {
		roundTrip(ComposerInput, {
			text: "review these",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
			annotations: [
				{
					id: "ann1",
					relPath: "src/app.ts",
					absPath: "/repo/src/app.ts",
					startLine: 4,
					endLine: 8,
					comment: "extract this branch",
					diffSide: "deletions" as const,
					diffAnchorLine: 8,
					oldPath: "src/old-app.ts",
					baseRef: "main",
				},
			],
		});
	});

	it("round-trips browser annotations", () => {
		roundTrip(ComposerInput, {
			text: "",
			attachments: [
				{
					id: "screenshot-1",
					mimeType: "image/png",
					originalName: "browser-annotation.png",
				},
			],
			fileRefs: [],
			skillRefs: [],
			annotations: [
				{
					_tag: "browser",
					id: "ann-browser-1",
					comment: "tighten the hero copy",
					createdAt: "2026-07-07T00:00:00.000Z",
					pageUrl: "https://example.com/",
					pageTitle: "Example Domain",
					elements: [
						{
							tagName: "h1",
							selector: "h1",
							label: "h1",
							rect: { x: 10, y: 20, width: 300, height: 60 },
							textPreview: "Example Domain",
						},
					],
					regions: [],
					strokes: [],
					screenshotAttachment: {
						id: "screenshot-1",
						mimeType: "image/png",
						originalName: "browser-annotation.png",
					},
				},
			],
		});
	});

	it("round-trips mixed code and browser annotations", () => {
		roundTrip(ComposerInput, {
			text: "review these",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
			annotations: [
				{
					id: "ann-code-1",
					relPath: "src/app.ts",
					absPath: "/repo/src/app.ts",
					startLine: 4,
					endLine: 8,
					comment: "extract this branch",
				},
				{
					_tag: "browser",
					id: "ann-browser-1",
					comment: "make this button clearer",
					createdAt: "2026-07-07T00:00:00.000Z",
					pageUrl: "http://localhost:3000/",
					pageTitle: null,
					elements: [],
					regions: [
						{ id: "region-1", rect: { x: 1, y: 2, width: 3, height: 4 } },
					],
					strokes: [],
					screenshotAttachment: null,
				},
			],
		});
	});
});

describe("SettingsFile round-trip", () => {
	it("round-trips completion sound settings", () => {
		roundTrip(SettingsFile, {
			schemaVersion: 1,
			defaultProviderId: "claude",
			defaultModelByProvider: {
				claude: "claude-opus-4-8",
				codex: "gpt-5-codex",
				grok: "grok-code-fast-1",
				cursor: "composer-2",
				gemini: "gemini-3-pro",
				opencode: "sonnet",
				kiro: "auto",
			},
			defaultRuntimeMode: "approval-required",
			defaultAutoCreateWorktree: false,
			defaultAutonomyLevel: "off",
			onboardingCompleted: true,
			appearanceMode: "system",
			completionSoundEnabled: true,
			completionSoundPreset: "bloom",
			providerEnabled: {
				claude: true,
				codex: true,
				grok: true,
				cursor: true,
				gemini: true,
				opencode: true,
				kiro: true,
			},
			modelEnabledByProvider: {
				...defaultModelEnabledByProvider(),
			},
			customModelIdsByProvider: {
				claude: ["claude-haiku-4-5"],
				codex: [],
				grok: [],
				cursor: [],
				gemini: [],
				opencode: [],
				kiro: [],
			},
			opencodeProviderVisible: { openai: true, openrouter: false },
			opencodeModelVisibleByProvider: {
				openai: { "openai/gpt-5": true },
			},
			opencodeCustomProviders: [
				{
					id: "my-llm",
					name: "My LLM",
					baseURL: "https://api.example.com/v1",
					npm: "@ai-sdk/openai-compatible",
					models: [{ id: "my-model", name: "My Model" }],
				},
			],
			mcpDisabledServers: ["claude:posthog"],
			subagents: { enableForNewSessions: true, presets: {} },
			branchNamingStyle: "username-slug",
			branchNamingPrefix: "",
			mergePrefs: { method: "squash", deleteBranch: true },
			notchTrayEnabled: true,
			notchTrayPinned: false,
		});
	});

	it("rejects an unknown completion sound preset", () => {
		expect(() =>
			Schema.decodeUnknownSync(SettingsFile)({
				schemaVersion: 1,
				defaultProviderId: "claude",
				defaultModelByProvider: {
					claude: "claude-opus-4-8",
					codex: "gpt-5-codex",
					grok: "grok-code-fast-1",
					cursor: "composer-2",
					gemini: "gemini-3-pro",
					opencode: "sonnet",
					kiro: "auto",
				},
				defaultRuntimeMode: "approval-required",
				defaultAutoCreateWorktree: false,
				onboardingCompleted: true,
				appearanceMode: "dark",
				completionSoundEnabled: true,
				completionSoundPreset: "airhorn",
				providerEnabled: {
					claude: true,
					codex: true,
					grok: true,
					cursor: true,
					gemini: true,
					opencode: true,
					kiro: true,
				},
				modelEnabledByProvider: defaultModelEnabledByProvider(),
				subagents: { enableForNewSessions: true, presets: {} },
				branchNamingStyle: "username-slug",
				branchNamingPrefix: "",
				mergePrefs: { method: "merge", deleteBranch: false },
				notchTrayEnabled: false,
				notchTrayPinned: false,
			}),
		).toThrow();
	});

	it("rejects an unknown appearance mode", () => {
		expect(() =>
			Schema.decodeUnknownSync(SettingsFile)({
				schemaVersion: 1,
				defaultProviderId: "claude",
				defaultModelByProvider: {
					claude: "claude-opus-4-8",
					codex: "gpt-5-codex",
					grok: "grok-code-fast-1",
					cursor: "composer-2",
					gemini: "gemini-3-pro",
					opencode: "sonnet",
					kiro: "auto",
				},
				defaultRuntimeMode: "approval-required",
				defaultAutoCreateWorktree: false,
				onboardingCompleted: true,
				appearanceMode: "sepia",
				completionSoundEnabled: true,
				completionSoundPreset: "chime",
				providerEnabled: {
					claude: true,
					codex: true,
					grok: true,
					cursor: true,
					gemini: true,
					opencode: true,
					kiro: true,
				},
				modelEnabledByProvider: defaultModelEnabledByProvider(),
				subagents: { enableForNewSessions: true, presets: {} },
				branchNamingStyle: "username-slug",
				branchNamingPrefix: "",
				mergePrefs: { method: "merge", deleteBranch: false },
				notchTrayEnabled: false,
				notchTrayPinned: false,
			}),
		).toThrow();
	});
});

describe("model visibility helpers", () => {
	it("exposes GPT-5.6 variants in quality order with their supported reasoning efforts", () => {
		expect(MODELS_BY_PROVIDER.codex.map((model) => model.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		expect(defaultModelFor("codex")).toBe("gpt-5.6-sol");

		const reasoningOptions = (modelId: string) => {
			const descriptor = MODELS_BY_PROVIDER.codex
				.find((model) => model.id === modelId)
				?.optionDescriptors?.find(
					(option) => option.kind === "select" && option.id === "reasoning",
				);
			return descriptor?.kind === "select"
				? descriptor.options.map(({ id, label }) => ({ id, label }))
				: [];
		};

		const gpt56Options = [
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "Extra High" },
			{ id: "max", label: "Max" },
			{ id: "ultra", label: "Ultra" },
		];
		for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
			expect(reasoningOptions(modelId)).toEqual(gpt56Options);
		}
	});

	it("uses Sonnet 5 as the default visible Claude model", () => {
		expect(defaultModelFor("claude")).toBe("claude-sonnet-5");
		expect(visibleModelsForProvider("claude")[0]?.id).toBe("claude-fable-5");
		expect(visibleModelsForProvider("claude")[1]?.id).toBe("claude-opus-5");
		expect(isModelVisible("claude", "claude-sonnet-5")).toBe(true);
		expect(isModelVisible("claude", "claude-fable-5")).toBe(true);
		expect(isModelVisible("claude", "claude-opus-5")).toBe(true);
		expect(resolveModelSlug("claude", "fable")).toBe("claude-fable-5");
		expect(resolveModelSlug("claude", "opus")).toBe("claude-opus-5");
		expect(resolveModelSlug("claude", "opus-5")).toBe("claude-opus-5");
		expect(
			MODELS_BY_PROVIDER.claude.find((m) => m.id === "claude-sonnet-5")
				?.badgeLabel,
		).toBe("New");
		expect(
			MODELS_BY_PROVIDER.claude.find((m) => m.id === "claude-fable-5")
				?.badgeLabel,
		).toBe("Available now");
		expect(
			MODELS_BY_PROVIDER.claude.find((m) => m.id === "claude-opus-5")
				?.badgeLabel,
		).toBe("New");
		expect(MODELS_BY_PROVIDER.claude.map((model) => model.id)).toEqual([
			"claude-fable-5",
			"claude-opus-5",
			"claude-sonnet-5",
		]);
	});

	it("keeps retired models out of every built-in catalog", () => {
		for (const models of Object.values(MODELS_BY_PROVIDER)) {
			expect(models.every((model) => model.defaultVisible !== false)).toBe(
				true,
			);
		}
		expect(MODELS_BY_PROVIDER.kiro.map((model) => model.id)).toEqual([
			"auto",
			"claude-opus-5",
			"claude-sonnet-5",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
	});

	it("surfaces current Grok models without changing the Grok default", () => {
		expect(defaultModelFor("grok")).toBe("grok-build");
		expect(MODELS_BY_PROVIDER.grok.some((m) => m.id === "grok-4.6")).toBe(true);
		expect(
			visibleModelsForProvider("grok").some((m) => m.id === "grok-4.6"),
		).toBe(true);
		expect(MODELS_BY_PROVIDER.grok.some((m) => m.id === "grok-4.5")).toBe(
			false,
		);
		expect(resolveModelSlug("grok", "grok-4.6-latest")).toBe("grok-4.6");
		expect(resolveModelSlug("grok", "grok-build-latest")).toBe("grok-4.6");
	});

	it("promotes Ox Alpha alongside the current OpenCode default", () => {
		expect(defaultModelFor("opencode")).toBe("opencode/claude-sonnet-5");
		const oxAlpha = MODELS_BY_PROVIDER.opencode.find(
			(model) => model.id === "opencode/x-preview-f-free",
		);
		expect(oxAlpha).toMatchObject({
			label: "OpenCode · Ox Alpha Free",
			badgeLabel: "Free",
			supportsPlanMode: true,
		});
		expect(oxAlpha?.optionDescriptors).toEqual([
			{
				kind: "select",
				id: "contextWindow",
				label: "Context Window",
				options: [{ id: "1m", label: "1M" }],
				defaultId: "1m",
			},
		]);
	});

	it("uses the current Cursor catalog and Composer 2.5 default", () => {
		expect(defaultModelFor("cursor")).toBe("composer-2.5");
		expect(MODELS_BY_PROVIDER.cursor.map((model) => model.id)).toEqual([
			"default",
			"composer-2.5",
			"claude-fable-5",
			"claude-opus-5",
			"claude-sonnet-5",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gemini-3.1-pro",
			"gemini-3.7-flash",
			"grok-4.6",
		]);
	});
});

describe("RepositorySettingsFile round-trip", () => {
	it("round-trips the editable repository settings JSON shape", () => {
		roundTrip(RepositorySettingsFile, {
			schemaVersion: 1,
			defaultProviderId: "codex",
			defaultModel: "gpt-5-codex",
			defaultRuntimeMode: "auto-accept-edits",
			autoCreateWorktree: true,
			worktreeBaseDir: "/tmp/worktrees",
			archiveCleanupScript: "rm -rf node_modules",
			setupScript: "bun install",
			runScript: "bun dev",
			autoRunAfterSetup: true,
			environmentVariables: {
				NODE_ENV: "development",
			},
			cloudEnvironmentVariables: {},
			fileIncludeGlobs: ".env\n.env.local\n",
			mcpDisabledServers: ["codex:pencil"],
		});
	});
});

describe("Git branch round-trip", () => {
	it("round-trips a local branch", () => {
		roundTrip(GitBranchInfo, {
			name: "feature/top-bar",
			current: true,
			remote: null,
			upstream: "origin/feature/top-bar",
			kind: "local" as const,
		});
	});

	it("round-trips a remote-only branch", () => {
		roundTrip(GitBranchInfo, {
			name: "main",
			current: false,
			remote: "origin/main",
			upstream: null,
			kind: "remote" as const,
		});
	});
});
