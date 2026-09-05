import {
	booleanDescriptor,
	claudeCodeModel,
	claudeContextWindowDescriptor,
	claudeEffortDescriptor,
	codexReasoningModel,
	staticContextWindowDescriptor,
} from "./authoring.ts";
import type { ModelCatalog } from "./schema.ts";

/**
 * Bundled snapshot of the curated model catalog.
 *
 * This is the single hand-maintained source of truth for model metadata.
 * It ships inside every build as the offline fallback and is published to
 * `https://zuse.sh/models/v1.json` by `scripts/generate-model-catalog.ts` so
 * installed apps pick up additions without a desktop release.
 *
 * To add or change a model:
 *   1. edit the entry below,
 *   2. bump `revision` (format `YYYYMMDDNN`),
 *   3. run `bun run catalog:generate` and commit the regenerated JSON.
 *
 * Ordering = newest first so the picker opens on the latest recommended
 * model. Live provider inventories are merged on top of this seed at
 * runtime (see `resolve.ts`); curated entries always win for labels,
 * badges, and option descriptors.
 */
export const BUNDLED_MODEL_CATALOG = {
	schemaVersion: 1,
	revision: 2026090401,
	generatedAt: "2026-09-04T00:00:00.000Z",
	providers: {
		// Claude Code. Effort tiers and per-model knobs match the published
		// Claude Agent SDK contract.
		claude: {
			models: [
				claudeCodeModel("claude-fable-5-1", "Fable 5.1", {
					badgeLabel: "New",
					defaultModel: true,
					fastMode: true,
				}),
				claudeCodeModel("claude-fable-5", "Fable 5", { fastMode: true }),
				claudeCodeModel("claude-opus-5", "Opus 5", { contextWindow: "1m" }),
				claudeCodeModel("claude-sonnet-5", "Sonnet 5", {
					effortOptions: [
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
						{ id: "max", label: "Max" },
						{ id: "ultracode", label: "Ultracode" },
					],
				}),
			],
			// Short / vendor-formatted slugs and pre-pricing-reset names route to
			// the canonical slugs above, so a user typing `opus` or `sonnet-4.6`
			// resolves to the current model id.
			aliases: {
				fable: "claude-fable-5-1",
				"fable-5.1": "claude-fable-5-1",
				"fable-5-1": "claude-fable-5-1",
				"claude-fable-5.1": "claude-fable-5-1",
				"claude-fable-5-1": "claude-fable-5-1",
				"fable-5": "claude-fable-5",
				"claude-fable-5": "claude-fable-5",
				opus: "claude-opus-5",
				"opus-5": "claude-opus-5",
				"claude-opus-5": "claude-opus-5",
				"opus-4.8": "claude-opus-4-8",
				"claude-opus-4.8": "claude-opus-4-8",
				"opus-4.7": "claude-opus-4-7",
				"claude-opus-4.7": "claude-opus-4-7",
				"opus-4.6": "claude-opus-4-6",
				"claude-opus-4.6": "claude-opus-4-6",
				sonnet: "claude-sonnet-5",
				"sonnet-5": "claude-sonnet-5",
				"claude-sonnet-5": "claude-sonnet-5",
				"sonnet-4.6": "claude-sonnet-4-6",
				"claude-sonnet-4.6": "claude-sonnet-4-6",
				haiku: "claude-haiku-4-5",
				"haiku-4.5": "claude-haiku-4-5",
				"claude-haiku-4.5": "claude-haiku-4-5",
			},
		},
		codex: {
			models: [
				codexReasoningModel("gpt-6-astra", "GPT-6 Astra", {
					badgeLabel: "New",
					defaultModel: true,
				}),
				codexReasoningModel("gpt-5.6-sol", "GPT-5.6 Sol"),
				codexReasoningModel("gpt-5.6-terra", "GPT-5.6 Terra"),
				codexReasoningModel("gpt-5.6-luna", "GPT-5.6 Luna"),
			],
			// Current Codex CLI rejects `gpt-5-codex` / `gpt-5` on ChatGPT accounts;
			// persisted settings and in-flight resumes are rewritten through here
			// so existing sessions don't crash.
			aliases: {
				"gpt-6": "gpt-6-astra",
				"gpt-5-codex": "gpt-5.5",
				"gpt-5": "gpt-5.5",
			},
		},
		// Seed list — Grok CLI's `-m` flag accepts any model id it knows, so a
		// custom slug typed by the user still works; this list is just what the
		// picker shows by default. `grok-build` unlocks with a paid Grok
		// entitlement. Passing a slug the account can't access yields a clean
		// 403 surfaced through grok's streaming-json `type: "error"` envelope.
		grok: {
			models: [
				{
					id: "grok-build",
					label: "Grok Build",
					supportsPlanMode: true,
					supportsWebSearch: "queryOnly",
				},
				{
					id: "grok-4.6",
					label: "Grok 4.6",
					supportsPlanMode: true,
					supportsWebSearch: "queryOnly",
				},
				{
					id: "grok-composer-2.5-fast",
					label: "Grok Composer 2.5 Fast",
					supportsPlanMode: true,
					supportsWebSearch: "queryOnly",
				},
			],
			aliases: {
				"grok-4.6-latest": "grok-4.6",
				"grok-4.5-latest": "grok-4.5",
				"grok-build-latest": "grok-4.6",
			},
		},
		// Gemini CLI accepts any model slug it knows via the ACP `_meta.model`
		// hint. Gemini's ACP server does not expose a runtime reasoning-effort
		// knob, so no reasoning descriptor is declared.
		gemini: {
			models: [
				{
					id: "gemini-3-pro-preview",
					label: "Gemini 3 Pro",
					supportsPlanMode: true,
					supportsWebSearch: "queryOnly",
				},
				{
					id: "gemini-3-flash-preview",
					label: "Gemini 3 Flash",
					supportsPlanMode: true,
					supportsWebSearch: "queryOnly",
				},
			],
			aliases: {
				"gemini-3-pro": "gemini-3-pro-preview",
				"gemini-3.1-pro-preview": "gemini-3-pro-preview",
			},
		},
		// Kiro CLI (`kiro-cli acp`) speaks standard ACP. Model ids match
		// `kiro-cli chat --list-models --format json` (dotted versions). The
		// live inventory is authoritative; this seed supplies curated labels.
		kiro: {
			models: [
				{ id: "auto", label: "Auto", supportsPlanMode: true },
				{
					id: "claude-fable-5.1",
					label: "Claude Fable 5.1",
					badgeLabel: "Experimental",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "claude-opus-5",
					label: "Claude Opus 5",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "claude-sonnet-5",
					label: "Claude Sonnet 5",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "gpt-6-astra",
					label: "GPT-6 Astra",
					badgeLabel: "Experimental",
					supportsPlanMode: true,
				},
				{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", supportsPlanMode: true },
				{
					id: "gpt-5.6-terra",
					label: "GPT-5.6 Terra",
					supportsPlanMode: true,
				},
				{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", supportsPlanMode: true },
			],
			// Common shorthand / hyphen-vs-dotted variants users may persist.
			aliases: {
				"claude-fable-5-1": "claude-fable-5.1",
				"claude-opus-4-8": "claude-opus-4.8",
				"claude-opus-4-7": "claude-opus-4.7",
				"claude-opus-4-6": "claude-opus-4.6",
				"claude-sonnet-4-6": "claude-sonnet-4.6",
				"claude-sonnet-4-5": "claude-sonnet-4.5",
				"claude-haiku-4-5": "claude-haiku-4.5",
			},
		},
		// The bundled Cursor SDK exposes a broad model catalog. This curated
		// shortlist is only the picker seed, not a whitelist. The `default` slug
		// maps to the SDK's current recommended composer model.
		cursor: {
			models: [
				{ id: "default", label: "Auto", supportsPlanMode: true },
				{
					id: "composer-2.5",
					label: "Composer 2.5",
					defaultModel: true,
					supportsPlanMode: true,
				},
				{
					id: "claude-fable-5-1",
					label: "Fable 5.1",
					badgeLabel: "New",
					supportsPlanMode: true,
				},
				{
					id: "gpt-6-astra",
					label: "GPT-6 Astra",
					badgeLabel: "New",
					supportsPlanMode: true,
				},
				{ id: "claude-fable-5", label: "Fable 5", supportsPlanMode: true },
				{ id: "claude-opus-5", label: "Opus 5", supportsPlanMode: true },
				{
					id: "claude-sonnet-5",
					label: "Sonnet 5",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", supportsPlanMode: true },
				{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra", supportsPlanMode: true },
				{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", supportsPlanMode: true },
				{
					id: "gemini-3.1-pro",
					label: "Gemini 3.1 Pro",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "gemini-3.7-flash",
					label: "Gemini 3.7 Flash",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{ id: "grok-4.6", label: "Grok 4.6", supportsPlanMode: true },
			],
			// Cursor retired the old `gpt-5` / `sonnet-4*` / `opus-4.x` slugs.
			// Existing user settings persisted by earlier builds get re-aliased to
			// current catalogue entries so re-opening the app doesn't send the
			// agent a slug it'll silently ignore.
			aliases: {
				"gpt-5": "composer-2",
				"sonnet-4": "claude-sonnet-4-6",
				"sonnet-4-thinking": "claude-sonnet-4-6",
				"opus-4.1": "claude-opus-4-7",
				"composer-2-fast": "composer-2",
				"composer-2.5-fast": "composer-2.5",
				"gpt-5.5-medium": "gpt-5.5",
				"gpt-5.5-medium-fast": "gpt-5.5",
				"gpt-5.5-high": "gpt-5.5",
				"gpt-5.5-high-fast": "gpt-5.5",
				"gpt-5.5-low": "gpt-5.5",
				"gpt-5.5-low-fast": "gpt-5.5",
				"gpt-5.5-extra-high": "gpt-5.5",
				"gpt-5.5-extra-high-fast": "gpt-5.5",
				"gpt-5.5-none": "gpt-5.5",
				"gpt-5.5-none-fast": "gpt-5.5",
				"gpt-5.4-high": "gpt-5.4",
				"gpt-5.4-high-fast": "gpt-5.4",
				"gpt-5.3-codex-fast": "gpt-5.3-codex",
				auto: "default",
			},
		},
		// OpenCode is a meta-provider: it spawns a local `opencode serve` and
		// forwards prompts to whichever underlying provider the user has
		// authenticated locally. Model ids carry a `<providerID>/<modelID>` slug
		// so the driver can split them on the slash. The live inventory is
		// authoritative; this seed supplies curated labels and badges.
		opencode: {
			models: [
				{
					id: "opencode/x-preview-f-free",
					label: "OpenCode · Ox Alpha Free",
					badgeLabel: "Free",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/claude-fable-5-1",
					label: "OpenCode · Claude Fable 5.1",
					badgeLabel: "New",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gpt-6-astra",
					label: "OpenCode · GPT-6 Astra",
					badgeLabel: "New",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/claude-fable-5",
					label: "OpenCode · Claude Fable 5",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/claude-opus-5",
					label: "OpenCode · Claude Opus 5",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/claude-sonnet-5",
					label: "OpenCode · Claude Sonnet 5",
					defaultModel: true,
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gpt-5.6-sol",
					label: "OpenCode · GPT-5.6 Sol",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gpt-5.6-terra",
					label: "OpenCode · GPT-5.6 Terra",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gpt-5.6-luna",
					label: "OpenCode · GPT-5.6 Luna",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gemini-3.1-pro",
					label: "OpenCode · Gemini 3.1 Pro",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/gemini-3.7-flash",
					label: "OpenCode · Gemini 3.7 Flash",
					optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
					supportsPlanMode: true,
				},
				{
					id: "opencode/grok-4.6",
					label: "OpenCode · Grok 4.6",
					supportsPlanMode: true,
				},
			],
			aliases: {},
		},
	},
	// 2026-05 Anthropic pricing reset — every Opus tier landed at the same
	// $5/$25 per-million numbers. `fastMode` doubles those for ~2.5x
	// throughput; the renderer's cost footer applies the multiplier. 1M
	// context window: no per-token premium. Retired ids stay so historical
	// sessions still price. Fable 5.1 assumes Fable 5 pricing until Anthropic
	// publishes a separate rate.
	pricing: {
		"claude-fable-5-1": {
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheCreate: 12.5,
		},
		"claude-fable-5": {
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheCreate: 12.5,
		},
		"claude-opus-5": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheCreate: 6.25,
		},
		"claude-opus-4-8": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheCreate: 6.25,
		},
		"claude-opus-4-7": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheCreate: 6.25,
		},
		"claude-opus-4-6": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheCreate: 6.25,
		},
		"claude-sonnet-5": {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheCreate: 3.75,
		},
		"claude-sonnet-4-6": {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheCreate: 3.75,
		},
		"claude-haiku-4-5": {
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheCreate: 1.25,
		},
	},
} as const satisfies ModelCatalog;

// Re-exported so callers that only need the descriptor helpers for
// authoring custom entries don't have to reach into `authoring.ts`.
export {
	booleanDescriptor,
	claudeContextWindowDescriptor,
	claudeEffortDescriptor,
};
