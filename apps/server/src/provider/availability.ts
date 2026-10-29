import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, win32 } from "node:path";
import type { PlanType } from "@zuse/agents/codex-generated/PlanType";
import type { Account } from "@zuse/agents/codex-generated/v2/Account";
import type { GetAccountResponse } from "@zuse/agents/codex-generated/v2/GetAccountResponse";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import { readKiroAuthContext } from "@zuse/agents/drivers/kiro-auth";
import { isolatedProviderAccountEnv } from "@zuse/agents/drivers/provider-account-env";
import type { CliProviderId } from "@zuse/contracts";
import {
	AgentAvailability,
	type CliVersionStatus,
	type CodexFeature,
	type LatestVersionStatus,
	type ProviderAuthStatus,
	type ProviderHealthStatus,
	type ProviderId,
	type ResolvedModelCatalogProvider,
} from "@zuse/contracts";
import { Duration, Effect, FileSystem, Stream } from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { PROVIDER_CLI_REGISTRY } from "./provider-cli-registry.ts";

export { SUPPORTED_PROVIDER_CLIS } from "./provider-cli-registry.ts";

interface ProviderProbe {
	readonly providerId: CliProviderId;
	readonly displayName: string;
	readonly cliBinary: string;

	readonly minVersion: CliVersion | null;

	readonly upgradeCommand: string | null;

	/** Official installer when it differs per host OS; also used to upgrade. */
	readonly installCommand?: {
		readonly posix: string;
		readonly win32: string;
	};

	readonly npmPackage: string | null;

	readonly homebrewFormula: string | null;

	readonly nativeUpdate: {
		readonly command: string;
		readonly matches: (normalizedPath: string) => boolean;
	} | null;
}

/** Minimum release with the typed native ACP extensions used by our driver. */
export const MIN_GROK_CLI_VERSION: CliVersion = {
	major: 0,
	minor: 2,
	patch: 101,
	raw: "0.2.101",
};

const PROBES: ReadonlyArray<ProviderProbe> = [
	{
		...PROVIDER_CLI_REGISTRY.muse,
		minVersion: { major: 1, minor: 4, patch: 6, raw: "1.4.6" },
		upgradeCommand: null,
		// Meta's script uses `set -o pipefail`, which Debian's dash `sh` rejects.
		installCommand: {
			posix: "curl -fsSL https://dev.meta.ai/install.sh | bash",
			win32: "irm https://dev.meta.ai/install.ps1 | iex",
		},
		npmPackage: null,
		homebrewFormula: null,
		nativeUpdate: null,
	},
	{
		...PROVIDER_CLI_REGISTRY.pi,
		minVersion: null,
		upgradeCommand:
			"npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
		npmPackage: "@earendil-works/pi-coding-agent",
		homebrewFormula: null,
		nativeUpdate: null,
	},
	{
		...PROVIDER_CLI_REGISTRY.claude,

		minVersion: null,
		upgradeCommand: null,
		npmPackage: "@anthropic-ai/claude-code",
		homebrewFormula: "claude-code",

		nativeUpdate: {
			command: "claude update",
			matches: (p) => p.endsWith("/.local/bin/claude"),
		},
	},
	{
		...PROVIDER_CLI_REGISTRY.codex,
		minVersion: { major: 0, minor: 128, patch: 0, raw: "0.128.0" },
		upgradeCommand: "npm i -g @openai/codex@latest",
		npmPackage: "@openai/codex",
		homebrewFormula: "codex",
		nativeUpdate: null,
	},
	{
		...PROVIDER_CLI_REGISTRY.grok,
		minVersion: MIN_GROK_CLI_VERSION,
		upgradeCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",

		npmPackage: null,
		homebrewFormula: null,
		nativeUpdate: null,
	},
	{
		...PROVIDER_CLI_REGISTRY.gemini,

		minVersion: null,
		upgradeCommand: "npm i -g @google/gemini-cli",
		npmPackage: "@google/gemini-cli",
		homebrewFormula: "gemini-cli",
		nativeUpdate: null,
	},
	{
		...PROVIDER_CLI_REGISTRY.opencode,
		// The SDK we bundle (`@opencode-ai/sdk`) targets the v2 HTTP shape that
		// landed in `opencode` 1.3.15. Older binaries respond to
		// `client.session.prompt` with a 404 (route renamed) — pin the floor
		// so we surface the upgrade card before the user hits that.
		minVersion: { major: 1, minor: 3, patch: 15, raw: "1.3.15" },
		upgradeCommand: "curl -fsSL https://opencode.ai/install | bash",
		npmPackage: "opencode-ai",
		homebrewFormula: "anomalyco/tap/opencode",

		nativeUpdate: {
			command: "opencode upgrade",
			matches: (p) => p.endsWith("/.opencode/bin/opencode"),
		},
	},
	{
		...PROVIDER_CLI_REGISTRY.opencode2,

		minVersion: null,
		upgradeCommand: "curl -fsSL https://opencode.ai/v2/install | bash",
		npmPackage: "@opencode/cli",
		homebrewFormula: null,
		nativeUpdate: {
			command: "opencode2 upgrade",
			matches: (p) =>
				p.endsWith("/.opencode/bin/opencode2") ||
				p.endsWith("/.opencode/bin/opencode2.exe"),
		},
	},
	{
		...PROVIDER_CLI_REGISTRY.kiro,

		minVersion: null,
		upgradeCommand: "kiro-cli update",
		npmPackage: null,
		homebrewFormula: null,
		nativeUpdate: {
			command: "kiro-cli update",
			matches: (p) => p.endsWith("/kiro-cli") || p.includes("/Kiro CLI.app/"),
		},
	},
];

const PROBE_TIMEOUT = Duration.seconds(4);

const collectText = (
	s: Stream.Stream<Uint8Array, import("effect/PlatformError").PlatformError>,
) =>
	s.pipe(
		Stream.decodeText({ encoding: "utf-8" }),
		Stream.runFold(
			() => "",
			(acc, chunk) => acc + chunk,
		),
	);

const runCapture = (cmd: Command.Command, includeStderr = false) =>
	Effect.gen(function* () {
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const proc = yield* executor.spawn(cmd);
		const [stdout, stderr] = yield* Effect.all(
			[
				collectText(proc.stdout),
				includeStderr ? collectText(proc.stderr) : Effect.succeed(""),
			],
			{ concurrency: "unbounded" },
		);
		const exitCode = yield* proc.exitCode;
		return { stdout: `${stdout}\n${stderr}`.trim(), exitCode };
	}).pipe(Effect.scoped);

const splitCommandPaths = (stdout: string): ReadonlyArray<string> =>
	stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

export const selectCliPathCandidate = (
	cliBinary: string,
	candidates: ReadonlyArray<string>,
	platform: NodeJS.Platform = process.platform,
	pathExists: (path: string) => boolean = existsSync,
): string | null => {
	if (candidates.length === 0) return null;
	if (platform === "win32" && cliBinary === "claude") {
		// `where.exe claude` returns npm's extensionless POSIX shim first and its
		// `.cmd` wrapper second. Neither can be passed to Node's spawn() as the
		// SDK's native executable. Prefer a native install; otherwise use npm's
		// JavaScript entrypoint, which the SDK intentionally launches through Node.
		const native = candidates.find(
			(candidate) => extname(candidate).toLowerCase() === ".exe",
		);
		if (native !== undefined) return native;
		for (const candidate of candidates) {
			const npmEntrypoint = win32.join(
				win32.dirname(candidate),
				"node_modules",
				"@anthropic-ai",
				"claude-code",
				"cli.js",
			);
			if (pathExists(npmEntrypoint)) return npmEntrypoint;
		}
		return null;
	}
	if (cliBinary !== "codex") return candidates[0] ?? null;

	return (
		candidates.find(
			(candidate) => !isManagedCodexShimPath(normalizeCommandPath(candidate)),
		) ?? null
	);
};

export const selectNewestCliPathCandidate = (
	candidates: ReadonlyArray<{
		readonly path: string;
		readonly version: CliVersion | null;
	}>,
): string | null => {
	const first = candidates[0];
	if (first === undefined) return null;
	const versioned = candidates.filter(
		(
			candidate,
		): candidate is { readonly path: string; readonly version: CliVersion } =>
			candidate.version !== null,
	);
	const firstVersioned = versioned[0];
	if (firstVersioned === undefined) return first.path;
	let newest = firstVersioned;
	for (const candidate of versioned.slice(1)) {
		if (compareCliVersion(candidate.version, newest.version) > 0) {
			newest = candidate;
		}
	}
	return newest.path;
};

/**
 * Install locations `which -a` can miss. GUI apps inherit a login PATH that
 * often omits native-installer dirs; OpenCode's official installer drops the
 * binary at `~/.opencode/bin/opencode`.
 */
export const extraWellKnownCliPaths = (
	cliBinary: string,
): ReadonlyArray<string> => {
	if (cliBinary === "opencode") {
		return [join(homedir(), ".opencode", "bin", "opencode")];
	}
	if (cliBinary === "opencode2") {
		return [join(homedir(), ".opencode", "bin", "opencode2")];
	}
	return [];
};

const CLI_BINARIES_SELECT_NEWEST = new Set(["codex", "opencode", "opencode2"]);

const executableCliPath = (path: string): string | null => {
	try {
		if (!isAbsolute(path) || !statSync(path).isFile()) return null;
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return null;
	}
};

/**
 * Resolve the absolute path to a provider's CLI binary on PATH, or `null` if
 * not found. Used by `ProviderService.start` to feed the SDK's
 * `pathToClaudeCodeExecutable` option (the SDK ships its own bundled CLI as
 * an optional native dep that may not install in every environment).
 */
export const resolveCliPath = (
	cliBinary: string,
	overrides: Readonly<Record<string, string>> = {},
): Effect.Effect<string | null, never, CommandExecutor.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const provider = Object.values(PROVIDER_CLI_REGISTRY).find(
			(p) => p.cliBinary === cliBinary,
		);
		const override = provider
			? overrides[provider.providerId]?.trim()
			: undefined;
		if (override) {
			return executableCliPath(override);
		}

		const toolchain = process.env.ZUSE_MANAGED_TOOLCHAIN_BIN;
		if (toolchain) {
			const pinned = executableCliPath(join(toolchain, cliBinary));
			if (pinned !== null) return pinned;
		}
		const locator = cliLocatorCommand(process.platform, cliBinary);
		const result = yield* runCapture(
			Command.make(locator.command, locator.args),
		).pipe(
			Effect.timeoutOption(PROBE_TIMEOUT),
			Effect.catch(() => Effect.succeedNone),
		);
		const fromWhich =
			result._tag === "Some" && result.value.exitCode === 0
				? splitCommandPaths(result.value.stdout)
				: [];
		const candidates = [
			...new Set([...fromWhich, ...extraWellKnownCliPaths(cliBinary)]),
		];
		if (candidates.length === 0) return null;
		if (!CLI_BINARIES_SELECT_NEWEST.has(cliBinary)) {
			return selectCliPathCandidate(cliBinary, candidates);
		}

		const fromWhichSet = new Set(fromWhich);
		const eligible =
			cliBinary === "codex"
				? candidates.filter(
						(candidate) =>
							!isManagedCodexShimPath(normalizeCommandPath(candidate)),
					)
				: candidates;
		const versioned = yield* Effect.forEach(
			eligible,
			(path) =>
				probeCliVersion(path).pipe(
					Effect.map((version) => ({ path, version })),
				),
			{ concurrency: "unbounded" },
		);

		const usable = versioned.filter(
			(candidate) =>
				candidate.version !== null || fromWhichSet.has(candidate.path),
		);
		return selectNewestCliPathCandidate(usable);
	});

export const cliLocatorCommand = (
	platform: NodeJS.Platform,
	cliBinary: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
	platform === "win32"
		? { command: "where.exe", args: [cliBinary] }
		: { command: "which", args: ["-a", cliBinary] };

export const cliInvocationCommand = (
	cliPath: string,
	args: ReadonlyArray<string>,
	platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
	platform === "win32" && /\.(?:c|m)?js$/iu.test(cliPath)
		? { command: "node", args: [cliPath, ...args] }
		: { command: cliPath, args };

export interface CliVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly raw: string;
}

// Codex SDK 0.128 unconditionally invokes `codex exec --experimental-json`;
// that flag landed in the matching CLI release, so any older codex binary
// crashes inside the SDK with "unexpected argument '--experimental-json'".
// Keep in lock-step with the provider implementation in `@zuse/agents`.
export const MIN_CODEX_CLI_VERSION: CliVersion = {
	major: 0,
	minor: 128,
	patch: 0,
	raw: "0.128.0",
};

export const CODEX_FEATURE_FLOORS: ReadonlyArray<{
	readonly feature: CodexFeature;
	readonly min: CliVersion;
}> = [
	{
		feature: "goalMode",
		min: { major: 0, minor: 128, patch: 0, raw: "0.128.0" },
	},

	{
		feature: "fastMode",
		min: { major: 0, minor: 145, patch: 0, raw: "0.145.0" },
	},
];

/**
 * Resolve the version-gated features a Codex CLI of `parsed` version supports.
 * Empty when the version couldn't be parsed (caller treats unknown versions as
 * "no extra capabilities" — the renderer falls back to hiding gated controls).
 */
export const resolveCodexCapabilities = (
	parsed: CliVersion | null,
): ReadonlyArray<CodexFeature> =>
	parsed === null
		? []
		: CODEX_FEATURE_FLOORS.filter(
				({ min }) => compareCliVersion(parsed, min) >= 0,
			).map(({ feature }) => feature);

export const parseCliVersion = (raw: string): CliVersion | null => {
	const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (match === null || !match[1] || !match[2] || !match[3]) return null;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		raw: raw.trim(),
	};
};

export const compareCliVersion = (a: CliVersion, b: CliVersion): number => {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
};

/**
 * Run `<cliBinary> --version` and parse the output. Returns `null` for any
 * failure (timeout, non-zero exit, unparsable output) so callers can choose
 * between "block on a probe miss" (strict) and "let the SDK speak for itself"
 * (lenient). The codex driver uses the lenient policy.
 */
export const probeCliVersion = (
	cliBinary: string,
): Effect.Effect<
	CliVersion | null,
	never,
	CommandExecutor.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const invocation = cliInvocationCommand(cliBinary, ["--version"]);
		const result = yield* runCapture(
			Command.make(invocation.command, invocation.args),
		).pipe(
			Effect.timeoutOption(PROBE_TIMEOUT),
			Effect.catch(() => Effect.succeedNone),
		);
		if (result._tag !== "Some" || result.value.exitCode !== 0) return null;
		return parseCliVersion(result.value.stdout);
	});

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const latestVersionCache = new Map<
	string,
	{ readonly version: string | null; readonly expiresAt: number }
>();

interface NpmLatestResponse {
	readonly version?: unknown;
}

const fetchNpmLatestVersion = (
	packageName: string,
): Effect.Effect<string | null> =>
	Effect.tryPromise({
		try: async (signal) => {
			const res = await fetch(
				`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
				{ headers: { accept: "application/json" }, signal },
			);
			if (!res.ok) return null;
			const body = (await res.json()) as NpmLatestResponse;
			const version =
				typeof body.version === "string" && body.version.trim().length > 0
					? body.version.trim()
					: null;
			return version;
		},
		catch: () => null,
	}).pipe(
		Effect.timeoutOption(PROBE_TIMEOUT),
		Effect.map((opt) => (opt._tag === "Some" ? opt.value : null)),
		Effect.catch(() => Effect.succeed(null)),
	);

const resolveLatestVersion = (
	probe: ProviderProbe,
): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		if (probe.npmPackage === null) return null;
		const now = Date.now();
		const cached = latestVersionCache.get(probe.npmPackage);
		if (cached !== undefined && cached.expiresAt > now) {
			return cached.version;
		}
		const version = yield* fetchNpmLatestVersion(probe.npmPackage);
		latestVersionCache.set(probe.npmPackage, {
			version,
			expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
		});
		return version;
	});

/**
 * Compare the installed CLI version string against the latest published
 * version. Reuses the SDK-floor parser/comparator so the semantics match.
 * `"unknown"` whenever either side is missing or unparsable.
 */
export const deriveLatestAdvisory = (
	cliVersion: string | undefined,
	latestVersion: string | null,
): LatestVersionStatus => {
	if (cliVersion === undefined || latestVersion === null) return "unknown";
	const installed = parseCliVersion(cliVersion);
	const latest = parseCliVersion(latestVersion);
	if (installed === null || latest === null) return "unknown";
	return compareCliVersion(installed, latest) < 0 ? "behind" : "current";
};

const normalizeCommandPath = (p: string): string =>
	p.replaceAll("\\", "/").replaceAll("/./", "/").toLowerCase();

const isBunGlobalPath = (p: string): boolean => p.includes("/.bun/bin/");

const isPnpmGlobalPath = (p: string): boolean =>
	p.includes("/.local/share/pnpm/") ||
	p.includes("/library/pnpm/") ||
	p.includes("/pnpm/global/");

const isNpmGlobalPath = (p: string): boolean =>
	p.includes("/lib/node_modules/") ||
	p.includes("/node_modules/.bin/") ||
	p.includes("/npm/node_modules/");

const isHomebrewPath = (p: string): boolean =>
	p.includes("/cellar/") ||
	p.includes("/caskroom/") ||
	p.startsWith("/opt/homebrew/bin/") ||
	p.startsWith("/usr/local/bin/");

const isManagedCodexShimPath = (p: string): boolean =>
	/\/application support\/[^/]+\/bin\/codex$/.test(p) ||
	(p.includes("/agent-binaries/codex/") && p.endsWith("/codex"));

// A plain `npm i -g <pkg>@latest` re-install fails with ENOTEMPTY during npm's
// "retire old dir" rename step when a prior install left files behind (common
// with packages shipping optional per-platform binaries, e.g.
// @anthropic-ai/claude-code). Uninstall first so install lays down a clean
// tree. npm treats an already-absent global package as a successful uninstall,
// so `&&` remains portable across POSIX shells and Windows cmd.exe.
const npmGlobalUpdate = (pkg: string): string =>
	`npm uninstall -g ${pkg} && npm install -g ${pkg}@latest`;

/**
 * Pure resolver: pick the update command for a provider given the candidate
 * binary paths (the `which` result plus its realpath). Detection order:
 * native self-update → bun → pnpm → npm → homebrew. Falls back to the
 * provider's install one-liner (curl installers reinstall latest), else
 * `null`.
 */
export const buildUpdateCommand = (
	providerId: ProviderId,
	candidatePaths: ReadonlyArray<string>,
	platform: NodeJS.Platform = "linux",
): string | null => {
	const probe = PROBES.find((p) => p.providerId === providerId);
	if (probe === undefined) return null;

	const norms = candidatePaths
		.filter((p) => p.length > 0)
		.map(normalizeCommandPath);

	if (
		probe.nativeUpdate !== null &&
		norms.some((p) => probe.nativeUpdate?.matches(p))
	) {
		return probe.nativeUpdate.command;
	}

	if (probe.npmPackage !== null) {
		if (norms.some(isBunGlobalPath)) {
			return `bun i -g ${probe.npmPackage}@latest`;
		}
		if (norms.some(isPnpmGlobalPath)) {
			return `pnpm add -g ${probe.npmPackage}@latest`;
		}
		if (norms.some(isNpmGlobalPath)) {
			return npmGlobalUpdate(probe.npmPackage);
		}
		if (probe.homebrewFormula !== null && norms.some(isHomebrewPath)) {
			return `brew upgrade ${probe.homebrewFormula}`;
		}
		if (candidatePaths.some((p) => p.includes("/") || p.includes("\\"))) {
			return null;
		}

		return npmGlobalUpdate(probe.npmPackage);
	}

	// Non-npm providers reinstall via their official one-liner.
	return platform === "win32" ? null : probe.upgradeCommand;
};

export const installCommandFor = (
	providerId: ProviderId,
	platform: NodeJS.Platform,
): string | null => {
	const install = PROBES.find(
		(p) => p.providerId === providerId,
	)?.installCommand;
	if (install === undefined) return null;
	return platform === "win32" ? install.win32 : install.posix;
};

/**
 * Resolve the update command for a provider by locating its binary and its
 * realpath, then delegating to {@link buildUpdateCommand}. Run server-side via
 * a login shell so PATH + pipes resolve — see `update-service.ts`.
 */
export const resolveUpdateCommand = (
	providerId: ProviderId,
): Effect.Effect<
	string | null,
	never,
	CommandExecutor.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const probe = PROBES.find((p) => p.providerId === providerId);
		if (probe === undefined) return null;
		const cliPath = yield* resolveCliPath(probe.cliBinary);
		if (cliPath === null) {
			// Not on PATH — fall back to a path-less resolution (npm default /
			// install one-liner) so the command still does something sensible.
			return buildUpdateCommand(providerId, [], process.platform);
		}
		const fs = yield* FileSystem.FileSystem;
		const realPath = yield* fs
			.realPath(cliPath)
			.pipe(Effect.catch(() => Effect.succeed(cliPath)));
		return buildUpdateCommand(
			providerId,
			[cliPath, realPath],
			process.platform,
		);
	});

interface AccountInfo {
	readonly authStatus: ProviderAuthStatus;
	readonly authEmail?: string;
	readonly authLabel?: string;
	readonly authType?: string;

	readonly statusMessage?: string;
}

const CODEX_PLAN_LABEL: Partial<Record<PlanType, string>> = {
	plus: "ChatGPT Plus Subscription",
	pro: "ChatGPT Pro Subscription",
	prolite: "ChatGPT Pro Lite Subscription",
	team: "ChatGPT Team Subscription",
	enterprise: "ChatGPT Enterprise Subscription",
	enterprise_cbp_usage_based: "ChatGPT Enterprise Subscription",
	business: "ChatGPT Business Subscription",
	self_serve_business_usage_based: "ChatGPT Business Subscription",
	edu: "ChatGPT Edu",
	go: "ChatGPT Go",
	free: "Free",
};

const codexAccountLabel = (account: Account): string | undefined => {
	switch (account.type) {
		case "apiKey":
			return "OpenAI API Key";
		case "amazonBedrock":
			return "Amazon Bedrock";
		case "chatgpt":
			return CODEX_PLAN_LABEL[account.planType] ?? "ChatGPT Subscription";
	}
};

const probeCodexAccount = (
	codexPath: string,
	accountHome?: string,
): Effect.Effect<AccountInfo> =>
	Effect.promise(async () => {
		try {
			const response = await withCodexControlClient(
				codexPath,
				(client) => client.request<GetAccountResponse>("account/read", {}),
				accountHome,
			);
			if (response.account === null) {
				return {
					authStatus: "unauthenticated",
					...(response.requiresOpenaiAuth
						? { statusMessage: "Sign in required" }
						: {}),
				} satisfies AccountInfo;
			}
			const account = response.account;
			const label = codexAccountLabel(account);
			return {
				authStatus: "authenticated",
				authType: account.type,
				...(label ? { authLabel: label } : {}),
				...(account.type === "chatgpt" && account.email.length > 0
					? { authEmail: account.email }
					: {}),
			} satisfies AccountInfo;
		} catch (err) {
			return {
				authStatus: "unknown",
				statusMessage:
					err instanceof Error ? err.message : "Could not verify Codex auth",
			} satisfies AccountInfo;
		}
	});

const CLAUDE_SUB_LABEL: Record<string, string> = {
	max: "Claude Max Subscription",
	pro: "Claude Pro Subscription",

	free: "Requires Claude Pro",
};

const claudeSubscriptionLabel = (subscriptionType?: string): string => {
	const tier = subscriptionType?.toLowerCase();
	return (tier && CLAUDE_SUB_LABEL[tier]) || "Claude subscription";
};

interface ClaudeCredentialBlob {
	readonly oauthAccount?: {
		readonly emailAddress?: string;
		readonly email?: string;
	};
	readonly claudeAiOauth?: {
		readonly subscriptionType?: string;
		readonly emailAddress?: string;
		readonly email?: string;
	};
}

const parseClaudeCredentials = (raw: string): AccountInfo => {
	let parsed: ClaudeCredentialBlob;
	try {
		parsed = JSON.parse(raw) as ClaudeCredentialBlob;
	} catch {
		return { authStatus: "authenticated" };
	}
	const oauth = parsed.claudeAiOauth;
	if (!oauth) return { authStatus: "authenticated" };
	const email = oauth.emailAddress ?? oauth.email;

	const authLabel = claudeSubscriptionLabel(oauth.subscriptionType);
	return {
		authStatus: "authenticated",
		authType: "oauth",
		authLabel,
		...(email ? { authEmail: email } : {}),
	};
};

const parseClaudeAccountFile = (raw: string): AccountInfo | null => {
	try {
		const parsed = JSON.parse(raw) as ClaudeCredentialBlob;
		const oauth = parsed.oauthAccount;
		if (!oauth) return null;
		const email = oauth.emailAddress ?? oauth.email;
		return {
			authStatus: "authenticated",
			authType: "oauth",
			authLabel: "Claude subscription",
			...(email ? { authEmail: email } : {}),
		};
	} catch {
		return null;
	}
};

const readOptionalFile = (
	path: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs
			.exists(path)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return null;
		return yield* fs
			.readFileString(path)
			.pipe(Effect.catch(() => Effect.succeed(null)));
	});

const probeClaudeAccount: Effect.Effect<
	AccountInfo,
	never,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const accountRaw = yield* readOptionalFile(join(homedir(), ".claude.json"));
	if (accountRaw !== null) {
		const account = parseClaudeAccountFile(accountRaw);
		if (account !== null) return account;
	}
	const credentialsRaw = yield* readOptionalFile(
		join(homedir(), ".claude", ".credentials.json"),
	);
	if (credentialsRaw === null) return { authStatus: "unauthenticated" };
	return credentialsRaw.length === 0
		? { authStatus: "authenticated" }
		: parseClaudeCredentials(credentialsRaw);
});

const parseGrokModelsAuth = (output: string): AccountInfo => {
	if (/not authenticated|not logged in/i.test(output)) {
		return { authStatus: "unauthenticated" };
	}
	if (/you are logged in/i.test(output)) {
		return {
			authStatus: "authenticated",
			authType: "cli",
			authLabel: "Grok account",
		};
	}
	return { authStatus: "unknown" };
};

const probeGrokAccount = (
	cliPath: string,
): Effect.Effect<AccountInfo, never, CommandExecutor.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const result = yield* runCapture(
			Command.make(cliPath, ["models"], { stderr: "pipe" }),
			true,
		).pipe(
			Effect.timeoutOption(PROBE_TIMEOUT),
			Effect.catch(() => Effect.succeedNone),
		);
		if (result._tag !== "Some" || result.value.exitCode !== 0) {
			return { authStatus: "unknown" } satisfies AccountInfo;
		}
		return parseGrokModelsAuth(result.value.stdout);
	});

export const grokAuthTestHelpers = { parseGrokModelsAuth, probeGrokAccount };

const probeGeminiAccount: Effect.Effect<
	AccountInfo,
	never,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = join(homedir(), ".gemini");
	const exists = yield* fs
		.exists(path)
		.pipe(Effect.catch(() => Effect.succeed(false)));
	return exists
		? ({ authStatus: "authenticated", authType: "cli" } satisfies AccountInfo)
		: ({ authStatus: "unauthenticated" } satisfies AccountInfo);
});

const probeKiroAccount: Effect.Effect<
	AccountInfo,
	never,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const auth = yield* Effect.sync(() =>
		readKiroAuthContext({ refreshIfExpired: false }),
	).pipe(Effect.catch(() => Effect.succeed(null)));
	if (auth !== null) {
		return {
			authStatus: "authenticated",
			authType: "cli",
			authLabel: "Kiro",
		} satisfies AccountInfo;
	}

	const fs = yield* FileSystem.FileSystem;
	const cacheDir = join(homedir(), ".aws", "sso", "cache");
	const candidates = [
		join(cacheDir, "kiro-auth-token-cli.json"),
		join(cacheDir, "kiro-auth-token.json"),
	];
	for (const path of candidates) {
		const exists = yield* fs
			.exists(path)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (exists) {
			return {
				authStatus: "authenticated",
				authType: "cli",
				authLabel: "Kiro",
			} satisfies AccountInfo;
		}
	}
	return { authStatus: "unauthenticated" } satisfies AccountInfo;
});

interface OpencodeAuthBlob {
	readonly [providerId: string]: unknown;
}

const opencodeAccountForProviders = (
	names: ReadonlyArray<string>,
): AccountInfo => {
	if (names.length === 0) return { authStatus: "unauthenticated" };
	return {
		authStatus: "authenticated",
		authType: "cli",
		authLabel:
			names.length === 1
				? `Connected to ${names[0]}`
				: `Connected to ${names.length} providers`,
	};
};

const parseOpencodeAuth = (raw: string): AccountInfo => {
	let parsed: OpencodeAuthBlob;
	try {
		parsed = JSON.parse(raw) as OpencodeAuthBlob;
	} catch {
		return { authStatus: "unknown" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { authStatus: "unknown" };
	}
	const providerIds = Object.keys(parsed).filter(
		(k) => parsed[k] !== null && parsed[k] !== undefined,
	);
	if (providerIds.length === 0) {
		return { authStatus: "unknown" };
	}
	return opencodeAccountForProviders(providerIds);
};

const probeOpencodeAccount: Effect.Effect<
	AccountInfo,
	never,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const xdg = process.env.XDG_DATA_HOME?.trim();
	const dataHome =
		xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	const authPath = join(dataHome, "opencode", "auth.json");
	const exists = yield* fs
		.exists(authPath)
		.pipe(Effect.catch(() => Effect.succeed(false)));
	if (!exists) {
		return { authStatus: "unknown" } satisfies AccountInfo;
	}
	const raw = yield* fs
		.readFileString(authPath)
		.pipe(Effect.catch(() => Effect.succeed("")));
	return parseOpencodeAuth(raw);
});

/** Use the already-cached inventory without starting another provider process. */
export const withOpencodeInventoryAccount = (
	availability: AgentAvailability,
	catalog: ResolvedModelCatalogProvider | undefined,
): AgentAvailability => {
	const id = availability.providerId;
	if (
		(id !== "opencode" && id !== "opencode2") ||
		!availability.cliInstalled ||
		catalog?.live.status !== "ok"
	)
		return availability;
	const inventory = catalog[id];
	if (inventory === undefined) return availability;
	const account = opencodeAccountForProviders(
		inventory.providers
			.filter((provider) => provider.connected)
			.map((provider) => provider.name),
	);
	return AgentAvailability.make({
		...availability,
		...account,
		cliLoggedIn: account.authStatus === "authenticated",
		authType: account.authType,
		authLabel: account.authLabel,
		status: computeHealthStatus({
			cliInstalled: true,
			cliVersionStatus: availability.cliVersionStatus ?? "unknown",
			authStatus: account.authStatus,
		}),
	});
};

export const opencodeAuthTestHelpers = {
	parseOpencodeAuth,
	probeOpencodeAccount,
};

const probeAccount = (
	providerId: CliProviderId,
	cliPath: string,
): Effect.Effect<
	AccountInfo,
	never,
	FileSystem.FileSystem | CommandExecutor.ChildProcessSpawner
> => {
	switch (providerId) {
		case "claude":
			return probeClaudeAccount;
		case "codex":
			return probeCodexAccount(cliPath);
		case "grok":
			return probeGrokAccount(cliPath);
		case "gemini":
			return probeGeminiAccount;
		case "opencode":
			return probeOpencodeAccount;
		case "opencode2":
			return Effect.succeed({ authStatus: "unknown" } satisfies AccountInfo);
		case "kiro":
			return probeKiroAccount;
		case "muse":
			return Effect.succeed({
				authStatus: "unknown",
				authLabel: "Managed by Muse Code",
			});
		case "pi":
			return Effect.succeed({
				cliLoggedIn: false,
				authStatus: "unknown",
				authLabel: "Managed by Pi",
			});
	}
};

const computeHealthStatus = (input: {
	cliInstalled: boolean;
	cliVersionStatus: CliVersionStatus;
	authStatus: ProviderAuthStatus;
}): ProviderHealthStatus => {
	if (!input.cliInstalled) return "error";
	if (input.cliVersionStatus === "outdated") return "warning";
	if (input.authStatus === "authenticated") return "ready";
	if (input.authStatus === "unauthenticated") return "warning";
	return "warning";
};

const probeNamedClaudeAccount = (
	cliPath: string,
	home: string,
): Effect.Effect<AccountInfo, never, CommandExecutor.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const invocation = cliInvocationCommand(cliPath, [
			"auth",
			"status",
			"--json",
		]);
		const result = yield* runCapture(
			Command.make(invocation.command, invocation.args, {
				env: isolatedProviderAccountEnv("claude", home, process.env),
				extendEnv: false,
			}),
		).pipe(
			Effect.timeoutOption(PROBE_TIMEOUT),
			Effect.catch(() => Effect.succeedNone),
		);
		if (result._tag === "None")
			return { authStatus: "unknown" } satisfies AccountInfo;
		try {
			const parsed = JSON.parse(result.value.stdout) as {
				loggedIn?: boolean;
				email?: string;
				subscriptionType?: string;
			};
			if (parsed.loggedIn !== true)
				return { authStatus: "unauthenticated" } satisfies AccountInfo;
			return {
				authStatus: "authenticated",
				authType: "oauth",
				authEmail: parsed.email,
				authLabel: claudeSubscriptionLabel(parsed.subscriptionType),
			} satisfies AccountInfo;
		} catch {
			return { authStatus: "unknown" } satisfies AccountInfo;
		}
	});

export const claudeAuthTestHelpers = {
	parseClaudeCredentials,
	probeNamedClaudeAccount,
};

const probeOne = (
	probe: ProviderProbe,
	overrides: Readonly<Record<string, string>> = {},
	accountHomes: Readonly<Record<string, string>> = {},
): Effect.Effect<
	AgentAvailability,
	never,
	CommandExecutor.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const lastCheckedAt = new Date();
		const cliPath = yield* resolveCliPath(probe.cliBinary, overrides);

		if (cliPath === null || cliPath.length === 0) {
			return AgentAvailability.make({
				providerId: probe.providerId,
				displayName: probe.displayName,
				cliInstalled: false,
				cliLoggedIn: false,
				hasApiKey: false,
				cliInstallCommand:
					installCommandFor(probe.providerId, process.platform) ?? undefined,
				status: "error",
				statusMessage: overrides[probe.providerId]
					? `Invalid ${probe.displayName} binary path: ${overrides[probe.providerId]}. Choose an absolute executable path.`
					: `${probe.displayName} CLI not found on PATH.`,
				lastCheckedAt,
			});
		}

		const versionInvocation = cliInvocationCommand(cliPath, ["--version"]);
		const versionResult = yield* runCapture(
			Command.make(versionInvocation.command, versionInvocation.args),
		).pipe(
			Effect.timeoutOption(PROBE_TIMEOUT),
			Effect.catch(() => Effect.succeedNone),
		);

		const cliVersion =
			versionResult._tag === "Some" && versionResult.value.exitCode === 0
				? versionResult.value.stdout.split(/\r?\n/)[0]?.trim() || undefined
				: undefined;

		const parsedVersion =
			cliVersion !== undefined ? parseCliVersion(cliVersion) : null;
		let cliVersionStatus: CliVersionStatus = "unknown";
		let cliVersionMinRequired: string | undefined;
		let cliUpgradeCommand: string | undefined;
		if (probe.minVersion !== null) {
			cliVersionMinRequired = probe.minVersion.raw;
			cliUpgradeCommand =
				probe.upgradeCommand ??
				installCommandFor(probe.providerId, process.platform) ??
				undefined;
			if (parsedVersion === null) {
				cliVersionStatus = "unknown";
			} else if (compareCliVersion(parsedVersion, probe.minVersion) < 0) {
				cliVersionStatus = "outdated";
			} else {
				cliVersionStatus = "ok";
			}
		}

		const capabilities =
			probe.providerId === "codex"
				? resolveCodexCapabilities(parsedVersion)
				: probe.providerId === "grok"
					? ["goalMode"]
					: [];

		const latestVersionRaw = yield* resolveLatestVersion(probe);
		const latestVersion = latestVersionRaw ?? undefined;
		const latestVersionStatus = deriveLatestAdvisory(
			cliVersion,
			latestVersionRaw,
		);

		const fs = yield* FileSystem.FileSystem;
		const realPath = yield* fs
			.realPath(cliPath)
			.pipe(Effect.catch(() => Effect.succeed(cliPath)));
		const updateCommand =
			buildUpdateCommand(
				probe.providerId,
				[cliPath, realPath],
				process.platform,
			) ?? undefined;

		const accountHome = accountHomes[probe.providerId];
		const account = yield* accountHome && probe.providerId === "claude"
			? probeNamedClaudeAccount(cliPath, accountHome)
			: accountHome && probe.providerId === "codex"
				? probeCodexAccount(cliPath, accountHome)
				: probeAccount(probe.providerId, cliPath);
		const cliLoggedIn = account.authStatus === "authenticated";

		const status = computeHealthStatus({
			cliInstalled: true,
			cliVersionStatus,
			authStatus: account.authStatus,
		});

		const statusMessage =
			account.statusMessage ??
			(cliVersionStatus === "outdated"
				? `Update required — ${probe.displayName} ${cliVersion ?? ""} below ${
						cliVersionMinRequired ?? "minimum"
					}.`
				: undefined);

		return AgentAvailability.make({
			providerId: probe.providerId,
			displayName: probe.displayName,
			cliInstalled: true,
			cliVersion,
			cliPath,
			cliLoggedIn,
			hasApiKey: false,
			cliVersionStatus,
			cliVersionMinRequired,
			cliUpgradeCommand,
			capabilities,
			latestVersion,
			latestVersionStatus,
			updateCommand,
			authStatus: account.authStatus,
			authEmail: account.authEmail,
			authLabel: account.authLabel,
			authType: account.authType,
			status,
			statusMessage,
			lastCheckedAt,
		});
	});

export const probeProvidersWithPaths = (
	overrides: Readonly<Record<string, string>>,
	accountHomes: Readonly<Record<string, string>> = {},
) =>
	Effect.all(
		PROBES.map((probe) => probeOne(probe, overrides, accountHomes)),
		{ concurrency: "unbounded" },
	);
