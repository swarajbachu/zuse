import { describe, expect, it } from "vitest";

import {
	buildUpdateCommand,
	claudeAuthTestHelpers,
	compareCliVersion,
	deriveLatestAdvisory,
	grokAuthTestHelpers,
	MIN_CODEX_CLI_VERSION,
	parseCliVersion,
	resolveCodexCapabilities,
	selectCliPathCandidate,
} from "../../src/provider/availability.ts";

const { parseGrokAuthJson, extractTier, decodeJwtPayload } =
	grokAuthTestHelpers;
const { parseClaudeCredentials } = claudeAuthTestHelpers;

describe("parseCliVersion", () => {
	it("pulls the first dotted triple out of labelled output", () => {
		expect(parseCliVersion("codex-cli 0.27.0")).toMatchObject({
			major: 0,
			minor: 27,
			patch: 0,
		});
		expect(parseCliVersion("1.0.123 (Claude Code)")).toMatchObject({
			major: 1,
			minor: 0,
			patch: 123,
		});
	});

	it("ignores pre-release suffixes when extracting the baseline triple", () => {
		expect(parseCliVersion("2.5.9-beta.3")).toMatchObject({
			major: 2,
			minor: 5,
			patch: 9,
		});
	});

	it("retains the trimmed raw string", () => {
		expect(parseCliVersion("  0.128.0  ")?.raw).toBe("0.128.0");
	});

	it("returns null for output without a version triple", () => {
		expect(parseCliVersion("no version here")).toBe(null);
		expect(parseCliVersion("1.2")).toBe(null); // only a pair, not a triple
		expect(parseCliVersion("")).toBe(null);
	});
});

describe("compareCliVersion", () => {
	const v = (major: number, minor: number, patch: number) => ({
		major,
		minor,
		patch,
		raw: `${major}.${minor}.${patch}`,
	});

	it("orders by major, then minor, then patch", () => {
		expect(compareCliVersion(v(1, 0, 0), v(0, 9, 9))).toBeGreaterThan(0);
		expect(compareCliVersion(v(0, 128, 0), v(0, 127, 9))).toBeGreaterThan(0);
		expect(compareCliVersion(v(0, 27, 1), v(0, 27, 2))).toBeLessThan(0);
	});

	it("returns 0 for equal versions", () => {
		expect(compareCliVersion(v(0, 128, 0), v(0, 128, 0))).toBe(0);
	});

	it("detects an older-than-minimum codex CLI", () => {
		const old = parseCliVersion("codex-cli 0.27.0")!;
		expect(compareCliVersion(old, MIN_CODEX_CLI_VERSION)).toBeLessThan(0);
	});
});

describe("resolveCodexCapabilities — version-gated feature floors", () => {
	it("returns no capabilities for an unparseable / null version", () => {
		expect(resolveCodexCapabilities(null)).toEqual([]);
	});

	it("enables only goalMode at the SDK floor but below the fast floor", () => {
		// 0.128.0 meets goalMode's 0.128.0 floor but is below fastMode's floor.
		expect(resolveCodexCapabilities(parseCliVersion("0.128.0"))).toEqual([
			"goalMode",
		]);
	});

	it("enables no gated features below every floor", () => {
		expect(resolveCodexCapabilities(parseCliVersion("0.27.0"))).toEqual([]);
	});

	it("enables both goalMode and fastMode once the fast floor is met", () => {
		const caps = resolveCodexCapabilities(parseCliVersion("0.145.0"));
		expect(caps).toContain("goalMode");
		expect(caps).toContain("fastMode");
	});

	it("keeps fastMode enabled for versions above the floor", () => {
		expect(resolveCodexCapabilities(parseCliVersion("0.200.3"))).toContain(
			"fastMode",
		);
	});
});

describe("grok auth probe — tier extraction & parseGrokAuthJson", () => {
	it("decodeJwtPayload handles a real-ish JWT payload", () => {
		// payload: {"tier":7,"email":"u@x.ai"}
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWVyIjo3LCJlbWFpbCI6InVAeC5haSJ9.signature";
		const claims = decodeJwtPayload(jwt);
		expect(claims).toEqual({ tier: 7, email: "u@x.ai" });
	});

	it("extractTier finds top-level tier (number)", () => {
		expect(extractTier({ tier: 7 })).toBe(7);
		expect(extractTier({ xai_tier: "5" })).toBe(5);
	});

	it("extractTier finds nested tier", () => {
		expect(extractTier({ subscription: { tier: 6 } })).toBe(6);
		expect(extractTier({ xai: { plan: { tier: 4 } } })).toBe(4);
	});

	it("extractTier DFS-finds deep tier key", () => {
		expect(extractTier({ a: { b: { weird_tier: "8" } } })).toBe(8);
	});

	it("parseGrokAuthJson accepts X Premium+ / SuperGrok tiers", () => {
		const raw = JSON.stringify({
			"user@x.ai": {
				key: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0aWVyIjo0LCJlbWFpbCI6InVzZXJAeC5haSJ9.sig",
				email: "user@x.ai",
			},
		});
		const info = parseGrokAuthJson(raw);
		expect(info.authStatus).toBe("authenticated");
		expect(info.authLabel).toBe("Grok subscription");
		expect(info.authEmail).toBe("user@x.ai");
	});

	it("parseGrokAuthJson returns Requires... only for confirmed below-entitlement tier", () => {
		const raw = JSON.stringify({
			"free@x.ai": {
				key: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0aWVyIjozLCJlbWFpbCI6ImZyZWVAeC5haSJ9.sig",
				email: "free@x.ai",
			},
		});
		const info = parseGrokAuthJson(raw);
		expect(info.authLabel).toBe("Requires SuperGrok or X Premium+");
	});

	it("parseGrokAuthJson is non-blocking (Grok label) when token present but no usable tier", () => {
		const raw = JSON.stringify({
			"paying@x.ai": {
				// token decodes but has no tier key at all
				key: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InBheWluZ0B4LmFpIn0.sig",
				email: "paying@x.ai",
			},
		});
		const info = parseGrokAuthJson(raw);
		expect(info.authLabel).toBe("Grok");
		expect(info.authEmail).toBe("paying@x.ai");
	});

	it("parseGrokAuthJson accepts access_token / jwt / token field names", () => {
		const raw = JSON.stringify({
			"u@x.ai": {
				access_token:
					"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0aWVyIjo1LCJlbWFpbCI6InVAeC5haSJ9.sig",
				email: "u@x.ai",
			},
		});
		expect(parseGrokAuthJson(raw).authLabel).toBe("Grok subscription");
	});

	it("parseGrokAuthJson for unparseable file still returns authenticated (non-blocking)", () => {
		const info = parseGrokAuthJson("{not json");
		expect(info.authStatus).toBe("authenticated");
		expect(info.authLabel).toBe("Grok");
	});

	it("parseGrokAuthJson for empty entry still authenticated", () => {
		const info = parseGrokAuthJson(JSON.stringify({}));
		expect(info.authLabel).toBe("Grok");
	});
});

describe("parseClaudeCredentials — subscription gating", () => {
	const blob = (subscriptionType?: string, email = "user@anthropic.com") =>
		JSON.stringify({
			claudeAiOauth: {
				...(subscriptionType !== undefined ? { subscriptionType } : {}),
				emailAddress: email,
			},
		});

	it("labels a Pro plan without gating it", () => {
		const info = parseClaudeCredentials(blob("pro"));
		expect(info.authStatus).toBe("authenticated");
		expect(info.authLabel).toBe("Claude Pro Subscription");
		expect(info.authLabel?.toLowerCase()).not.toContain("require");
		expect(info.authEmail).toBe("user@anthropic.com");
	});

	it("labels a Max plan without gating it", () => {
		const info = parseClaudeCredentials(blob("max"));
		expect(info.authLabel).toBe("Claude Max Subscription");
		expect(info.authLabel?.toLowerCase()).not.toContain("require");
	});

	it("normalises tier casing before matching", () => {
		expect(parseClaudeCredentials(blob("Pro")).authLabel).toBe(
			"Claude Pro Subscription",
		);
	});

	it("does NOT gate an unknown/unmapped tier (a paid login is still valid)", () => {
		// Regression: a base Pro user whose tier string we don't map (or whose blob
		// omits it) must not be told to subscribe — the OAuth login proves a paid
		// account and the runtime does the real entitlement check.
		const info = parseClaudeCredentials(blob("max_5x_20250101"));
		expect(info.authStatus).toBe("authenticated");
		expect(info.authLabel?.toLowerCase()).not.toContain("require");
	});

	it("does NOT gate when subscriptionType is missing", () => {
		const info = parseClaudeCredentials(blob(undefined));
		expect(info.authStatus).toBe("authenticated");
		expect(info.authLabel?.toLowerCase()).not.toContain("require");
	});

	it("gates only an explicitly free tier", () => {
		const info = parseClaudeCredentials(blob("free"));
		expect(info.authLabel).toBe("Requires Claude Pro");
		expect(info.authLabel?.toLowerCase()).toContain("require");
	});

	it("falls back to authenticated for non-JSON / OAuth-less blobs", () => {
		expect(parseClaudeCredentials("{not json").authStatus).toBe(
			"authenticated",
		);
		expect(parseClaudeCredentials(JSON.stringify({})).authStatus).toBe(
			"authenticated",
		);
	});
});

describe("deriveLatestAdvisory — update-available verdict", () => {
	it("reports behind when installed < latest", () => {
		expect(deriveLatestAdvisory("1.0.5", "1.0.9")).toBe("behind");
		expect(deriveLatestAdvisory("0.128.0", "0.130.2")).toBe("behind");
		expect(deriveLatestAdvisory("1.2.3", "2.0.0")).toBe("behind");
	});

	it("reports current when installed == or > latest", () => {
		expect(deriveLatestAdvisory("1.0.9", "1.0.9")).toBe("current");
		expect(deriveLatestAdvisory("2.1.0", "2.0.5")).toBe("current");
	});

	it("tolerates label-wrapped version strings (parser pulls the triple)", () => {
		// `claude --version` prints "1.0.123 (Claude Code)"
		expect(deriveLatestAdvisory("1.0.123 (Claude Code)", "1.0.140")).toBe(
			"behind",
		);
		expect(deriveLatestAdvisory("codex-cli 0.130.0", "0.130.0")).toBe(
			"current",
		);
	});

	it("reports unknown when either side is missing or unparsable", () => {
		expect(deriveLatestAdvisory(undefined, "1.0.0")).toBe("unknown");
		expect(deriveLatestAdvisory("1.0.0", null)).toBe("unknown");
		expect(deriveLatestAdvisory("not-a-version", "1.0.0")).toBe("unknown");
	});
});

describe("selectCliPathCandidate", () => {
	it("prefers a user Codex install over a managed Codex shim", () => {
		expect(
			selectCliPathCandidate("codex", [
				"/Users/me/Library/Application Support/app.memoize.desktop/./bin/codex",
				"/Users/me/.nvm/versions/node/v23.10.0/bin/codex",
			]),
		).toBe("/Users/me/.nvm/versions/node/v23.10.0/bin/codex");
	});

	it("does not select a managed Codex shim when it is the only candidate", () => {
		expect(
			selectCliPathCandidate("codex", [
				"/Users/me/Library/Application Support/app.memoize.desktop/./bin/codex",
			]),
		).toBeNull();
	});

	it("skips managed Codex shims owned by other desktop apps too", () => {
		expect(
			selectCliPathCandidate("codex", [
				"/Users/me/Library/Application Support/com.example.app/./bin/codex",
				"/Users/me/Library/Application Support/com.example.app/agent-binaries/codex/0.144.0/codex",
				"/Users/me/.nvm/versions/node/v24.18.0/bin/codex",
			]),
		).toBe("/Users/me/.nvm/versions/node/v24.18.0/bin/codex");
	});

	it("keeps first PATH match for non-Codex providers", () => {
		expect(
			selectCliPathCandidate("claude", [
				"/opt/homebrew/bin/claude",
				"/Users/me/.local/bin/claude",
			]),
		).toBe("/opt/homebrew/bin/claude");
	});
});

describe("buildUpdateCommand — install-method detection", () => {
	it("does not offer an updater for a managed standalone Codex shim", () => {
		expect(
			buildUpdateCommand("codex", [
				"/Users/me/Library/Application Support/app.memoize.desktop/./bin/codex",
				"/Users/me/Library/Application Support/app.memoize.desktop/agent-binaries/codex/0.138.0/codex",
			]),
		).toBeNull();
	});

	it("uses the native self-updater for a native Claude install", () => {
		expect(buildUpdateCommand("claude", ["/Users/me/.local/bin/claude"])).toBe(
			"claude update",
		);
	});

	it("uses the native self-updater for a native OpenCode install", () => {
		expect(
			buildUpdateCommand("opencode", ["/Users/me/.opencode/bin/opencode"]),
		).toBe("opencode upgrade");
	});

	it("uses npm (uninstall-then-install) for an nvm/npm-global install", () => {
		// `which` returns the bin symlink; realpath points into node_modules.
		const cmd = buildUpdateCommand("codex", [
			"/Users/me/.nvm/versions/node/v23.10.0/bin/codex",
			"/Users/me/.nvm/versions/node/v23.10.0/lib/node_modules/@openai/codex/bin/codex.js",
		]);
		expect(cmd).toBe(
			"npm uninstall -g @openai/codex || true; npm install -g @openai/codex@latest",
		);
	});

	it("uses bun / pnpm for those global installs", () => {
		expect(buildUpdateCommand("codex", ["/Users/me/.bun/bin/codex"])).toBe(
			"bun i -g @openai/codex@latest",
		);
		expect(
			buildUpdateCommand("codex", ["/Users/me/.local/share/pnpm/codex"]),
		).toBe("pnpm add -g @openai/codex@latest");
	});

	it("uses brew when the binary lives under a Homebrew prefix", () => {
		expect(buildUpdateCommand("codex", ["/opt/homebrew/bin/codex"])).toBe(
			"brew upgrade codex",
		);
	});

	it("defaults npm providers to npm when the path is unknown / absent", () => {
		expect(buildUpdateCommand("gemini", [])).toBe(
			"npm uninstall -g @google/gemini-cli || true; npm install -g @google/gemini-cli@latest",
		);
	});

	it("does not update npm when an npm provider path is an unknown absolute install", () => {
		expect(buildUpdateCommand("codex", ["/opt/custom/codex"])).toBeNull();
	});

	it("reinstalls via the install one-liner for curl-based CLIs (Grok)", () => {
		expect(buildUpdateCommand("grok", ["/Users/me/.local/bin/grok"])).toBe(
			"curl -fsSL https://x.ai/cli/install.sh | bash",
		);
	});
});
