import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
	AgentAvailability,
	type ResolvedModelCatalogProvider,
} from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	buildUpdateCommand,
	claudeAuthTestHelpers,
	compareCliVersion,
	deriveLatestAdvisory,
	extraWellKnownCliPaths,
	grokAuthTestHelpers,
	MIN_CODEX_CLI_VERSION,
	MIN_GROK_CLI_VERSION,
	opencodeAuthTestHelpers,
	parseCliVersion,
	resolveCliPath,
	resolveCodexCapabilities,
	SUPPORTED_PROVIDER_CLIS,
	selectCliPathCandidate,
	selectNewestCliPathCandidate,
	withOpencodeInventoryAccount,
} from "../../src/provider/availability.ts";

const { parseGrokModelsAuth, probeGrokAccount } = grokAuthTestHelpers;
const { parseClaudeCredentials, probeNamedClaudeAccount } =
	claudeAuthTestHelpers;

describe("supported provider CLIs", () => {
	it("exposes Serve detection from the provider availability registry", () => {
		expect(
			SUPPORTED_PROVIDER_CLIS.map(({ providerId, cliBinary }) => [
				providerId,
				cliBinary,
			]),
		).toEqual([
			["claude", "claude"],
			["codex", "codex"],
			["grok", "grok"],
			["gemini", "gemini"],
			["opencode", "opencode"],
			["opencode2", "opencode2"],
			["pi", "pi"],
			["kiro", "kiro-cli"],
		]);
	});
});

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

	it("enforces the native ACP floor for Grok", () => {
		expect(
			compareCliVersion(
				parseCliVersion("grok 0.2.100 (abc)")!,
				MIN_GROK_CLI_VERSION,
			),
		).toBeLessThan(0);
		expect(
			compareCliVersion(
				parseCliVersion("grok 0.2.101 (abc)")!,
				MIN_GROK_CLI_VERSION,
			),
		).toBe(0);
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

describe("Grok CLI authentication", () => {
	it.each([
		"You are logged in with grok.com.\nAvailable models:\n * grok-4.6 (default)",
		"You are logged in with grok.com.\nSuperGrok Heavy",
		"You are logged in with grok.com.\nSuperGrok Pro",
	])("accepts the CLI login without inferring a subscription tier", (output) => {
		expect(parseGrokModelsAuth(output)).toEqual({
			authStatus: "authenticated",
			authType: "cli",
			authLabel: "Grok account",
		});
	});
	it.each([
		"You are not logged in.",
		"Not authenticated",
	])("recognizes signed-out output", (output) => {
		expect(parseGrokModelsAuth(output)).toEqual({
			authStatus: "unauthenticated",
		});
	});
	it.each([
		"",
		"Available models:\n * grok-4.6",
		"Unexpected CLI response",
	])("keeps inconclusive output unknown", (output) => {
		expect(parseGrokModelsAuth(output)).toEqual({ authStatus: "unknown" });
	});
});

describe.skipIf(process.platform === "win32")("Grok CLI probe", () => {
	it.each([
		["console.log('You are logged in with grok.com.')", "authenticated"],
		["console.error('You are logged in with grok.com.')", "authenticated"],
		["console.log('You are not logged in.')", "unauthenticated"],
		[
			"console.log('You are logged in with grok.com.'); process.exitCode = 1",
			"unknown",
		],
		["console.log('Unrecognized output')", "unknown"],
	])("uses only a successful models command: %s", async (body, authStatus) => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-grok-probe-"));
		try {
			const cli = join(directory, "grok");
			await writeFile(
				cli,
				`#!${process.execPath}\nif (process.argv[2] !== 'models') process.exit(2);\n${body}\n`,
				{ mode: 0o755 },
			);
			const result = await Effect.runPromise(
				probeGrokAccount(cli).pipe(Effect.provide(NodeServices.layer)),
			);
			expect(result.authStatus).toBe(authStatus);
			expect(result.authLabel ?? "").not.toContain("Requires");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("bounds a stalled CLI probe", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-grok-timeout-"));
		try {
			const cli = join(directory, "grok");
			await writeFile(
				cli,
				`#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
				{ mode: 0o755 },
			);
			expect(
				await Effect.runPromise(
					probeGrokAccount(cli).pipe(Effect.provide(NodeServices.layer)),
				),
			).toEqual({ authStatus: "unknown" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 7000);
	it("keeps a missing executable inconclusive", async () => {
		expect(
			await Effect.runPromise(
				probeGrokAccount("/nonexistent/zuse-grok").pipe(
					Effect.provide(NodeServices.layer),
				),
			),
		).toEqual({ authStatus: "unknown" });
	});
});

describe.skipIf(process.platform === "win32")(
	"named Claude account probe",
	() => {
		it.each([
			["free", "Requires Claude Pro"],
			["Pro", "Claude Pro Subscription"],
			["MAX", "Claude Max Subscription"],
			["unknown-tier", "Claude subscription"],
			[undefined, "Claude subscription"],
		])("preserves subscription gating for %s", async (subscriptionType, authLabel) => {
			const directory = await mkdtemp(
				join(tmpdir(), "zuse-claude-account-probe-"),
			);
			try {
				const cli = join(directory, "claude");
				await writeFile(
					join(directory, "status.json"),
					JSON.stringify({
						loggedIn: true,
						email: "named@example.com",
						subscriptionType,
					}),
				);
				await writeFile(
					cli,
					`#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nif (process.argv.slice(2).join(' ') !== 'auth status --json') process.exit(2);\nconsole.log(readFileSync(process.env.CLAUDE_CONFIG_DIR + '/status.json', 'utf8'));\n`,
					{ mode: 0o755 },
				);
				const info = await Effect.runPromise(
					probeNamedClaudeAccount(cli, directory).pipe(
						Effect.provide(NodeServices.layer),
					),
				);
				expect(info).toEqual({
					authStatus: "authenticated",
					authType: "oauth",
					authEmail: "named@example.com",
					authLabel,
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	},
);

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

describe("selectNewestCliPathCandidate", () => {
	it("selects the newest installed Codex binary instead of the first PATH match", () => {
		expect(
			selectNewestCliPathCandidate([
				{
					path: "/Users/me/.nvm/bin/codex",
					version: parseCliVersion("codex-cli 0.145.0"),
				},
				{
					path: "/Applications/ChatGPT.app/Contents/Resources/codex",
					version: parseCliVersion("codex-cli 0.146.0-alpha.9.2"),
				},
			]),
		).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
	});

	it("keeps PATH order when versions cannot be determined", () => {
		expect(
			selectNewestCliPathCandidate([
				{ path: "/first/codex", version: null },
				{ path: "/second/codex", version: null },
			]),
		).toBe("/first/codex");
	});

	it("selects a current OpenCode binary over a colliding older PATH hit", () => {
		expect(
			selectNewestCliPathCandidate([
				{
					path: "/opt/homebrew/bin/opencode",
					version: parseCliVersion("0.0.55"),
				},
				{
					path: "/Users/me/.opencode/bin/opencode",
					version: parseCliVersion("1.18.19"),
				},
			]),
		).toBe("/Users/me/.opencode/bin/opencode");
	});
});

describe("extraWellKnownCliPaths", () => {
	it("adds OpenCode's native installer location", () => {
		expect(extraWellKnownCliPaths("opencode")).toEqual([
			join(homedir(), ".opencode", "bin", "opencode"),
		]);
		expect(extraWellKnownCliPaths("opencode2")).toEqual([
			join(homedir(), ".opencode", "bin", "opencode2"),
		]);
	});

	it("does not invent extra paths for other CLIs", () => {
		expect(extraWellKnownCliPaths("claude")).toEqual([]);
		expect(extraWellKnownCliPaths("codex")).toEqual([]);
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

	it("uses the native self-updater only for a native OpenCode 2 install", () => {
		expect(
			buildUpdateCommand("opencode2", ["/Users/me/.opencode/bin/opencode2"]),
		).toBe("opencode2 upgrade");
		expect(
			buildUpdateCommand("opencode2", ["/usr/local/bin/opencode2"]),
		).toBeNull();
		expect(
			buildUpdateCommand("opencode2", [
				"/usr/local/bin/opencode2",
				"/usr/local/lib/node_modules/@opencode/cli/bin/opencode2.exe",
			]),
		).toBe(
			"npm uninstall -g @opencode/cli || true; npm install -g @opencode/cli@latest",
		);
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

describe("provider binary overrides", () => {
	const resolve = (path: string) =>
		Effect.runPromise(
			resolveCliPath("pi", { pi: path }).pipe(
				Effect.provide(NodeServices.layer),
			),
		);
	it("uses an explicit absolute executable without PATH discovery", async () => {
		expect(await resolve(process.execPath)).toBe(process.execPath);
	});
	it("rejects invalid overrides without falling back to PATH", async () => {
		for (const path of ["relative/pi", "/missing-zuse-test/pi", "/tmp"])
			expect(await resolve(path)).toBeNull();
	});
});

describe("OpenCode account probing", () => {
	it("does not require login when the legacy auth file is missing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-opencode-auth-"));
		const previous = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = directory;
		try {
			const account = await Effect.runPromise(
				opencodeAuthTestHelpers.probeOpencodeAccount.pipe(
					Effect.provide(NodeServices.layer),
				),
			);
			expect(account.authStatus).toBe("unknown");
		} finally {
			if (previous === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"null",
		"[]",
		"invalid",
		"{}",
	])("does not claim login from an inconclusive legacy file: %s", (raw) => {
		expect(opencodeAuthTestHelpers.parseOpencodeAuth(raw).authStatus).toBe(
			"unknown",
		);
	});
});

describe("OpenCode inventory account status", () => {
	const catalogFor = (
		id: "opencode" | "opencode2",
		connected: boolean,
	): ResolvedModelCatalogProvider => ({
		models: [],
		aliases: {},
		defaultModelId: "",
		live: { status: "ok", authoritative: true, fetchedAt: 1, error: null },
		[id]: {
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					connected,
					custom: false,
					apiKeyEnv: "",
					apiKeyUrl: "",
					models: [],
				},
			],
			agents: [],
		},
	});

	it.each([
		"opencode",
		"opencode2",
	] as const)("uses cached connected providers for %s without a legacy auth file", (id) => {
		const availability = AgentAvailability.make({
			providerId: id,
			displayName: id,
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus: "unknown",
		});
		expect(
			withOpencodeInventoryAccount(availability, catalogFor(id, true)),
		).toMatchObject({
			authStatus: "authenticated",
			cliLoggedIn: true,
			authLabel: "Connected to OpenAI",
			status: "ready",
		});
		expect(
			withOpencodeInventoryAccount(availability, catalogFor(id, false)),
		).toMatchObject({
			authStatus: "unauthenticated",
			cliLoggedIn: false,
			status: "warning",
		});
	});

	it("keeps an inconclusive probe when live inventory failed", () => {
		const availability = AgentAvailability.make({
			providerId: "opencode2",
			displayName: "OpenCode 2",
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus: "unknown",
		});
		const catalog = catalogFor("opencode2", false);
		expect(
			withOpencodeInventoryAccount(availability, {
				...catalog,
				live: { ...catalog.live, status: "error" },
			}),
		).toBe(availability);
	});

	it("does not hide an outdated CLI behind successful auth", () => {
		const availability = AgentAvailability.make({
			providerId: "opencode",
			displayName: "OpenCode",
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus: "unknown",
			cliVersionStatus: "outdated",
		});
		expect(
			withOpencodeInventoryAccount(availability, catalogFor("opencode", true))
				.status,
		).toBe("warning");
	});
});
