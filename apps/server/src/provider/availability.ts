import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanType } from "@zuse/agents/codex-generated/PlanType";
import type { Account } from "@zuse/agents/codex-generated/v2/Account";
import type { GetAccountResponse } from "@zuse/agents/codex-generated/v2/GetAccountResponse";
import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import {
  AgentAvailability,
  type CliVersionStatus,
  type CodexFeature,
  type LatestVersionStatus,
  type ProviderAuthStatus,
  type ProviderHealthStatus,
  type ProviderId,
} from "@zuse/contracts";
import { Duration, Effect, FileSystem, Stream } from "effect";
import {
  ChildProcess as Command,
  ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { decodeJwtPayload } from "./jwt.ts";

interface ProviderProbe {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly cliBinary: string;
  /**
   * Minimum CLI version the bundled SDK requires. `null` means we don't
   * enforce a floor for this provider — version status is reported as
   * `"unknown"` and the renderer treats it as "let them try".
   */
  readonly minVersion: CliVersion | null;
  /**
   * Suggested one-liner the renderer shows in the upgrade card. Per-provider
   * because npm vs brew vs cargo channels differ.
   */
  readonly upgradeCommand: string | null;
  /**
   * npm package name used to resolve the *latest published* version (for the
   * informational "update available" layer). `null` for providers installed
   * outside npm (curl scripts) — those report `latestVersionStatus: "unknown"`
   * and surface no update affordance.
   */
  readonly npmPackage: string | null;
  /** Homebrew formula, when the CLI is also distributed via brew. */
  readonly homebrewFormula: string | null;
  /**
   * Native self-update (e.g. `claude update`, `opencode upgrade`) used when
   * the on-PATH binary is the provider's own native install rather than a
   * package-manager one. `matches` is given the normalized (lowercased,
   * forward-slash) binary path.
   */
  readonly nativeUpdate: {
    readonly command: string;
    readonly matches: (normalizedPath: string) => boolean;
  } | null;
}

const PROBES: ReadonlyArray<ProviderProbe> = [
  {
    providerId: "claude",
    displayName: "Claude Code",
    cliBinary: "claude",
    // Claude Agent SDK 0.2 doesn't break on older CLIs the way codex-sdk
    // 0.128 does — leave the floor open until we see a concrete failure
    // mode we can pin to a version.
    minVersion: null,
    upgradeCommand: null,
    npmPackage: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    // Native installer drops the binary in `~/.local/bin/claude` and ships a
    // `claude update` self-updater. npm can't touch that install.
    nativeUpdate: {
      command: "claude update",
      matches: (p) => p.endsWith("/.local/bin/claude"),
    },
  },
  {
    providerId: "codex",
    displayName: "Codex",
    cliBinary: "codex",
    minVersion: { major: 0, minor: 128, patch: 0, raw: "0.128.0" },
    upgradeCommand: "npm i -g @openai/codex@latest",
    npmPackage: "@openai/codex",
    homebrewFormula: "codex",
    nativeUpdate: null,
  },
  {
    providerId: "grok",
    displayName: "Grok",
    cliBinary: "grok",
    // No floor yet — xAI ships Grok Build CLI as a single official channel
    // and hasn't published an SDK we'd need to keep in lock-step with.
    // Revisit if a future release breaks the streaming-json contract.
    minVersion: null,
    upgradeCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
    // xAI ships Grok via a curl installer, not npm — no registry to poll.
    // The installer reinstalls the latest build, so it doubles as the updater.
    npmPackage: null,
    homebrewFormula: null,
    nativeUpdate: null,
  },
  {
    providerId: "gemini",
    displayName: "Gemini",
    cliBinary: "gemini",
    // We speak ACP directly via `gemini --experimental-acp`, so there's no
    // SDK pin to keep in lock-step with. Revisit if Google renames the
    // flag or breaks the handshake.
    minVersion: null,
    upgradeCommand: "npm i -g @google/gemini-cli",
    npmPackage: "@google/gemini-cli",
    homebrewFormula: "gemini-cli",
    nativeUpdate: null,
  },
  {
    providerId: "cursor",
    displayName: "Cursor",
    cliBinary: "cursor-agent",
    // No version floor yet. ACP support landed in a recent `cursor-agent`
    // release; older builds will surface a handshake timeout when the user
    // tries to start a session. Revisit once we pin the exact
    // ACP-introducing version.
    minVersion: null,
    upgradeCommand: "curl https://cursor.com/install -fsS | bash",
    // cursor-agent ships via a curl installer, not npm. Its install script
    // reinstalls the latest build, so it doubles as the updater.
    npmPackage: null,
    homebrewFormula: null,
    nativeUpdate: null,
  },
  {
    providerId: "opencode",
    displayName: "OpenCode",
    cliBinary: "opencode",
    // The SDK we bundle (`@opencode-ai/sdk`) targets the v2 HTTP shape that
    // landed in `opencode` 1.3.15. Older binaries respond to
    // `client.session.prompt` with a 404 (route renamed) — pin the floor
    // so we surface the upgrade card before the user hits that.
    minVersion: { major: 1, minor: 3, patch: 15, raw: "1.3.15" },
    upgradeCommand: "curl -fsSL https://opencode.ai/install | bash",
    npmPackage: "opencode-ai",
    homebrewFormula: "anomalyco/tap/opencode",
    // Native installer drops the binary in `~/.opencode/bin/opencode` and
    // ships an `opencode upgrade` self-updater.
    nativeUpdate: {
      command: "opencode upgrade",
      matches: (p) => p.endsWith("/.opencode/bin/opencode"),
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

const runCapture = (cmd: Command.Command) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.ChildProcessSpawner;
    const proc = yield* executor.spawn(cmd);
    const stdout = yield* collectText(proc.stdout);
    const exitCode = yield* proc.exitCode;
    return { stdout: stdout.trim(), exitCode };
  }).pipe(Effect.scoped);

const splitCommandPaths = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const selectCliPathCandidate = (
  cliBinary: string,
  candidates: ReadonlyArray<string>,
): string | null => {
  if (candidates.length === 0) return null;
  if (cliBinary !== "codex") return candidates[0]!;

  // Some environments can prepend a managed Codex shim to PATH for internals.
  // Provider settings should report the user's real Codex install, not that
  // managed binary.
  return (
    candidates.find(
      (candidate) => !isManagedCodexShimPath(normalizeCommandPath(candidate)),
    ) ?? null
  );
};

/**
 * Resolve the absolute path to a provider's CLI binary on PATH, or `null` if
 * not found. Used by `ProviderService.start` to feed the SDK's
 * `pathToClaudeCodeExecutable` option (the SDK ships its own bundled CLI as
 * an optional native dep that may not install in every environment).
 */
export const resolveCliPath = (
  cliBinary: string,
): Effect.Effect<string | null, never, CommandExecutor.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* runCapture(
      Command.make("which", ["-a", cliBinary]),
    ).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.catch(() => Effect.succeedNone),
    );
    if (result._tag !== "Some" || result.value.exitCode !== 0) return null;
    return selectCliPathCandidate(
      cliBinary,
      splitCommandPaths(result.value.stdout),
    );
  });

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

// Per-feature minimum Codex CLI version. This is the *pre-session* gate: the
// renderer reads the resolved `capabilities` list off `AgentAvailability` to
// show/hide a feature's control before any session exists. Each entry is one
// `CodexFeature`. Adding a feature is additive — add it here and to the wire
// `CodexFeature` literal, then gate the UI on the capability.
//
// Note for `fastMode`: the live `model/list` `serviceTiers` (emitted by the
// driver as a `Capabilities` event) are the authoritative per-model gate, so
// this floor only governs when the toggle first becomes visible — an
// approximate value is safe.
export const CODEX_FEATURE_FLOORS: ReadonlyArray<{
  readonly feature: CodexFeature;
  readonly min: CliVersion;
}> = [
  // Goal mode uses the `thread/goal/*` RPCs, which exist as of our SDK floor
  // (0.128). Pinned at the floor so it's effectively always-on whenever Codex
  // is new enough to run at all.
  {
    feature: "goalMode",
    min: { major: 0, minor: 128, patch: 0, raw: "0.128.0" },
  },
  // Fast mode (`serviceTier: "fast"`) landed in a later release. TODO: confirm
  // the exact CLI version; the runtime `serviceTiers` check is the real gate.
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

// `codex --version` prints `codex-cli 0.27.0`; `claude --version` prints
// `1.0.123 (Claude Code)`. Pull the first dotted triple we can find; ignore
// surrounding labels and pre-release suffixes — the comparator only cares
// about the major.minor.patch baseline.
export const parseCliVersion = (raw: string): CliVersion | null => {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
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
    const result = yield* runCapture(
      Command.make(cliBinary, ["--version"]),
    ).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.catch(() => Effect.succeedNone),
    );
    if (result._tag !== "Some" || result.value.exitCode !== 0) return null;
    return parseCliVersion(result.value.stdout);
  });

// ---------------------------------------------------------------------------
// Latest-version advisory (informational "update available" layer).
//
// Separate from the SDK floor above: this polls the npm registry for the
// latest *published* release and compares it to what's installed. Everything
// here is failure-tolerant — any miss collapses to `"unknown"` so a flaky
// network never blocks (or even surfaces in) availability.
// ---------------------------------------------------------------------------

// In-memory cache so we hit the registry at most once per package per hour.
// `probeAllProviders` runs on every settings open + window focus; without this
// every focus would fan out a burst of registry calls.
const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const latestVersionCache = new Map<
  string,
  { readonly version: string | null; readonly expiresAt: number }
>();

interface NpmLatestResponse {
  readonly version?: unknown;
}

/**
 * Resolve the latest published version of an npm package via the registry's
 * lightweight `/<pkg>/latest` endpoint. Returns `null` on any failure
 * (offline, non-2xx, malformed JSON, timeout) so callers treat it as
 * "unknown" rather than erroring.
 */
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

/**
 * Cached wrapper around {@link fetchNpmLatestVersion}. Returns `null` for
 * providers with no npm package (curl-installed CLIs we don't version-check).
 */
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

// ---------------------------------------------------------------------------
// Install-method detection. The right update command depends on HOW the
// on-PATH binary was installed — a native install (`~/.local/bin/claude`)
// can't be updated by npm, a brew install needs `brew upgrade`, etc. We
// inspect the resolved binary path (and its realpath, since global bins are
// symlinks into `…/lib/node_modules/…`).
// ---------------------------------------------------------------------------

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
  p.endsWith("/application support/app.memoize.desktop/bin/codex") ||
  (p.includes(
    "/application support/app.memoize.desktop/agent-binaries/codex/",
  ) &&
    p.endsWith("/codex"));

// A plain `npm i -g <pkg>@latest` re-install fails with ENOTEMPTY during npm's
// "retire old dir" rename step when a prior install left files behind (common
// with packages shipping optional per-platform binaries, e.g.
// @anthropic-ai/claude-code). Uninstall first so install lays down a clean
// tree; `|| true` keeps a not-installed case from aborting the chain.
const npmGlobalUpdate = (pkg: string): string =>
  `npm uninstall -g ${pkg} || true; npm install -g ${pkg}@latest`;

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
): string | null => {
  const probe = PROBES.find((p) => p.providerId === providerId);
  if (probe === undefined) return null;

  const norms = candidatePaths
    .filter((p) => p.length > 0)
    .map(normalizeCommandPath);

  if (
    probe.nativeUpdate !== null &&
    norms.some((p) => probe.nativeUpdate!.matches(p))
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
    // No path available: default to npm, which is how these packages are most
    // commonly installed. Unknown absolute paths stay manual-only so we don't
    // update a different install than the one being probed.
    return npmGlobalUpdate(probe.npmPackage);
  }

  // Non-npm providers (Grok, Cursor): reinstall via the official one-liner.
  return probe.upgradeCommand;
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
      return buildUpdateCommand(providerId, []);
    }
    const fs = yield* FileSystem.FileSystem;
    const realPath = yield* fs
      .realPath(cliPath)
      .pipe(Effect.catch(() => Effect.succeed(cliPath)));
    return buildUpdateCommand(providerId, [cliPath, realPath]);
  });

// ---------------------------------------------------------------------------
// Verified-auth probes per provider.
//
// `cliLoggedIn` proves a credential *file* exists; `AccountInfo` proves we
// could actually parse the credential and extract a user identity (email +
// subscription tier). The renderer uses both: `cliLoggedIn` lights up the dot
// before the slow per-driver verification finishes, and `AccountInfo`
// upgrades the card to "Authenticated as <email> · <subscription>".
// ---------------------------------------------------------------------------

interface AccountInfo {
  readonly authStatus: ProviderAuthStatus;
  readonly authEmail?: string;
  readonly authLabel?: string;
  readonly authType?: string;
  /**
   * One-line probe error to display under the "Needs attention" headline
   * when verification failed even though a credential file is present.
   */
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

const ACCOUNT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Spawn a short-lived `codex app-server`, call `account/read`, and pull
 * email + plan label off the response. Always resolves to an `AccountInfo`
 * — spawn failures, timeouts, and protocol errors all flow through to a
 * tagged "unknown" result with the error message in `statusMessage` so the
 * UI can show "Needs attention" without crashing the whole availability
 * RPC.
 */
const probeCodexAccount = (codexPath: string): Effect.Effect<AccountInfo> =>
  Effect.promise(async () => {
    let client: CodexAppServerClient | null = null;
    try {
      client = await CodexAppServerClient.start({
        codexPath,
        startupTimeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
        onNotification: () => {},
        onServerRequest: (_req, respond) => respond(null),
      });
      const response = await client.request<GetAccountResponse>(
        "account/read",
        {},
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
    } finally {
      // Kill the child process — without this the `codex app-server`
      // subprocess leaks for several minutes per probe.
      client?.close();
    }
  });

const CLAUDE_SUB_LABEL: Record<string, string> = {
  max: "Claude Max Subscription",
  pro: "Claude Pro Subscription",
  // Only an *explicitly* free tier surfaces as "Requires …" so the renderer's
  // subscription-gate rail (matches authLabel.includes("require")) disables the
  // toggle and shows the Subscribe CTA, same as Grok/Cursor. Unknown/missing
  // tiers are NOT gated — see parseClaudeCredentials.
  free: "Requires Claude Pro",
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
  const sub = oauth.subscriptionType?.toLowerCase();
  const email = oauth.emailAddress ?? oauth.email;
  // A present OAuth login already proves a paid Claude account — Claude Code
  // agent usage is not available on the free tier. So only an *explicitly*
  // recognised free tier surfaces the subscription gate; an unknown or missing
  // subscriptionType is treated as a valid (non-blocking) login, with the
  // runtime performing the real entitlement check. (Mirrors the Grok probe,
  // which only blocks on a *confirmed* below-entitlement tier.) Defaulting
  // unknown tiers to "Requires …" wrongly nagged Pro users — and anyone whose
  // tier string we don't map — to subscribe despite an active subscription.
  const authLabel =
    sub && CLAUDE_SUB_LABEL[sub]
      ? CLAUDE_SUB_LABEL[sub]
      : "Claude subscription";
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

interface GrokAuthEntry {
  readonly key?: string; // JWT access token (contains "tier" claim)
  readonly access_token?: string;
  readonly token?: string;
  readonly jwt?: string;
  readonly email?: string;
  readonly first_name?: string;
}

/**
 * Minimum `tier` value from the xAI OIDC JWT that includes Grok Build CLI
 * access. xAI now exposes Grok Build to SuperGrok and X Premium+ subscribers;
 * locally-observed X Premium+ tokens carry tier 4, while older SuperGrok Heavy
 * tokens carried tier 5+.
 */
const MIN_GROK_BUILD_TIER = 4;

/**
 * Best-effort extraction of a numeric `tier` claim from a JWT payload.
 * Handles:
 *  - top-level `tier`, `xai_tier`, `plan_tier`, `subscription.tier`
 *  - string values that look like numbers
 *  - deep search for any key containing "tier" whose value is a usable number
 * Returns null when nothing plausible is found.
 */
const extractTier = (claims: unknown): number | null => {
  if (!claims || typeof claims !== "object") return null;
  const obj = claims as Record<string, unknown>;

  const directCandidates = [
    "tier",
    "xai_tier",
    "plan_tier",
    "subscription_tier",
    "agent_tier",
  ];
  for (const k of directCandidates) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }

  // Nested objects (e.g. { subscription: { tier: 7 } }, { xai: { tier: 5 } })
  const nested = ["subscription", "xai", "plan", "account", "user", "profile"];
  for (const n of nested) {
    const sub = obj[n];
    if (sub && typeof sub === "object") {
      const t = extractTier(sub);
      if (t !== null) return t;
    }
  }

  // Last resort: DFS for any *tier* key with a numeric-ish value
  const stack: unknown[] = [obj];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (k.toLowerCase().includes("tier")) {
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const n = Number(v);
          if (Number.isFinite(n)) return n;
        }
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
};

const GROK_DEBUG = process.env.MEMOIZE_DEBUG_GROK === "1";

const parseGrokAuthJson = (raw: string): AccountInfo => {
  try {
    const data = JSON.parse(raw) as Record<string, GrokAuthEntry>;
    const entry = Object.values(data)[0];
    if (!entry) {
      // No entries but file existed → treat as authenticated (runtime will enforce)
      return {
        authStatus: "authenticated",
        authType: "cli",
        authLabel: "Grok",
      } satisfies AccountInfo;
    }

    const email = entry.email?.trim();

    // Try every plausible token field the CLI might use now or in the future
    const token =
      entry.key || entry.access_token || entry.token || entry.jwt || null;

    let authLabel = "Grok";
    let tierFound: number | null = null;

    if (token) {
      const claims = decodeJwtPayload(token);
      tierFound = extractTier(claims);
      if (GROK_DEBUG) {
        process.stderr.write(
          `[grok.probe] claimsKeys=${claims ? Object.keys(claims).slice(0, 8).join(",") : "null"} tier=${tierFound}\n`,
        );
      }
      if (typeof tierFound === "number") {
        if (tierFound >= MIN_GROK_BUILD_TIER) {
          authLabel = "Grok subscription";
        } else {
          authLabel = "Requires SuperGrok or X Premium+";
        }
      }
      // else: we have a token but no usable tier claim → non-blocking "Grok"
      // (runtime ACP still does the real entitlement check)
    } else if (GROK_DEBUG) {
      process.stderr.write(
        `[grok.probe] entry present but no token field found\n`,
      );
    }

    return {
      authStatus: "authenticated",
      authType: "cli",
      ...(email ? { authEmail: email } : {}),
      authLabel,
    } satisfies AccountInfo;
  } catch (e) {
    if (GROK_DEBUG) {
      process.stderr.write(`[grok.probe] parse error: ${e}\n`);
    }
    // Unparseable auth.json but file existed → authenticated (don't hard-block)
    return {
      authStatus: "authenticated",
      authType: "cli",
      authLabel: "Grok",
    } satisfies AccountInfo;
  }
};

// Exported for tests / debug only. Not part of the public module surface.
export const grokAuthTestHelpers = {
  parseGrokAuthJson,
  extractTier,
  decodeJwtPayload,
};

// Exported for tests only. Not part of the public module surface.
export const claudeAuthTestHelpers = {
  parseClaudeCredentials,
};

// Grok stores OIDC credentials (JWT + email + tier claim) in `~/.grok/auth.json`
// after `grok login`. We parse the JWT to read the `tier` claim and decide the
// plan status (best-effort only — the ACP binary is the source of truth):
//
// - tier >= 4 → "Grok subscription"   (nice label, toggle enabled)
// - tier < 4  → "Requires SuperGrok or X Premium+" (violet nag + disabled)
// - token present but tier unreadable / missing / new shape → "Grok" (non-blocking)
//   The runtime will surface the precise AuthorizationRequired if the account
//   truly lacks the agent entitlement.
//
// This change (from always-requires on parse failure) stops paying SuperGrok
// Heavy users from being incorrectly locked out by our heuristic when the
// auth.json shape or claim location differs from what we first shipped.
const probeGrokAccount: Effect.Effect<
  AccountInfo,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = join(homedir(), ".grok");
  const authPath = join(dir, "auth.json");

  const authExists = yield* fs
    .exists(authPath)
    .pipe(Effect.catch(() => Effect.succeed(false)));

  if (authExists) {
    const raw = yield* fs
      .readFileString(authPath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    if (raw.length > 0) {
      return parseGrokAuthJson(raw);
    }
  }

  // No auth.json at all → unauthenticated (user has never run `grok login`)
  const dirExists = yield* fs
    .exists(dir)
    .pipe(Effect.catch(() => Effect.succeed(false)));
  return dirExists
    ? ({
        authStatus: "authenticated",
        authType: "cli",
        authLabel: "Grok",
      } satisfies AccountInfo)
    : ({ authStatus: "unauthenticated" } satisfies AccountInfo);
});

// Gemini CLI writes OAuth tokens + settings under `~/.gemini/` after the
// first interactive sign-in. Same file-existence heuristic as Grok — we
// don't yet have a verified-auth call we can make to the gemini CLI to
// extract email/plan, so the card stays at "Authenticated" without the
// subscription label.
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

// Strip ANSI escape sequences (cursor-positioning, colors, etc). The
// cursor-agent CLI emits a TUI-style status frame before its final answer,
// e.g. ` Starting login process...\n[2K[1A[2K[G\n Not logged in`. We only
// want to read the final human-readable line.
const ANSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const stripAnsi = (raw: string): string => raw.replace(ANSI_PATTERN, "");

// `cursor-agent status` is the CLI's own auth signal. It prints either
// "Not logged in" or a positive line — `Logged in as <email>` on newer
// builds, `Login successful!` on older ones. The directory at
// `~/.local/share/cursor-agent/` is created on install regardless of
// login state, so we never trust it.
//
// We don't set the "Requires Cursor Pro" gating label, even though the
// ACP runtime does need a paid plan: cursor-agent has no `whoami`/`me`
// subcommand, so once a user is signed in we have no way to tell Pro
// from non-Pro. Falsely labelling every signed-in user as gated nags
// people who already pay. The ACP server enforces the real check at
// session start and surfaces a clear error there if the plan is missing.
const CURSOR_EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w+/;

const parseCursorStatusOutput = (raw: string): AccountInfo => {
  const cleanedRaw = stripAnsi(raw);
  const cleaned = cleanedRaw.toLowerCase();
  if (cleaned.includes("not logged in") || cleaned.includes("not signed in")) {
    return { authStatus: "unauthenticated" };
  }
  const emailMatch = cleanedRaw.match(CURSOR_EMAIL_PATTERN);
  if (
    cleaned.includes("logged in as") ||
    cleaned.includes("signed in as") ||
    cleaned.includes("login successful") ||
    cleaned.includes("authenticated") ||
    emailMatch !== null
  ) {
    return {
      authStatus: "authenticated",
      authType: "cli",
      ...(emailMatch !== null ? { authEmail: emailMatch[0] } : {}),
    } satisfies AccountInfo;
  }
  return { authStatus: "unknown" };
};

const probeCursorAccount: Effect.Effect<
  AccountInfo,
  never,
  CommandExecutor.ChildProcessSpawner
> = Effect.gen(function* () {
  const executor = yield* CommandExecutor.ChildProcessSpawner;
  const result = yield* Effect.gen(function* () {
    const proc = yield* executor.spawn(
      Command.make("cursor-agent", ["status"]),
    );
    const stdout = yield* collectText(proc.stdout);
    const stderr = yield* collectText(proc.stderr);
    const exitCode = yield* proc.exitCode;
    return { stdout, stderr, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.catch(() => Effect.succeedNone),
  );
  if (result._tag !== "Some") {
    return { authStatus: "unknown" } satisfies AccountInfo;
  }
  // Exit code is not a reliable signal — the CLI returns 0 even when not
  // logged in. Parse the text instead.
  return parseCursorStatusOutput(
    `${result.value.stdout}\n${result.value.stderr}`,
  );
});

// OpenCode stores per-provider credentials in `~/.local/share/opencode/auth.json`
// after `opencode auth login <provider>`. Each top-level key is a provider id
// (anthropic, openai, …) and the value carries the access token or API key.
// We treat a non-empty file with at least one entry as "authenticated"; the
// renderer then surfaces "Connected to N providers" once we wire the
// dynamic inventory in. Falling back to the directory presence check
// matches the Gemini/Cursor pattern when the file is missing but the CLI
// has been installed.
interface OpencodeAuthBlob {
  readonly [providerId: string]: unknown;
}

const parseOpencodeAuth = (raw: string): AccountInfo => {
  let parsed: OpencodeAuthBlob;
  try {
    parsed = JSON.parse(raw) as OpencodeAuthBlob;
  } catch {
    return { authStatus: "authenticated", authType: "cli" };
  }
  const providerIds = Object.keys(parsed).filter(
    (k) => parsed[k] !== null && parsed[k] !== undefined,
  );
  if (providerIds.length === 0) {
    return { authStatus: "unauthenticated" };
  }
  return {
    authStatus: "authenticated",
    authType: "cli",
    authLabel:
      providerIds.length === 1
        ? `Connected to ${providerIds[0]}`
        : `Connected to ${providerIds.length} providers`,
  };
};

const probeOpencodeAccount: Effect.Effect<
  AccountInfo,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  const exists = yield* fs
    .exists(authPath)
    .pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) {
    return { authStatus: "unauthenticated" } satisfies AccountInfo;
  }
  const raw = yield* fs
    .readFileString(authPath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  return raw.length === 0
    ? { authStatus: "authenticated", authType: "cli" }
    : parseOpencodeAuth(raw);
});

const probeAccount = (
  providerId: ProviderId,
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
      return probeGrokAccount;
    case "gemini":
      return probeGeminiAccount;
    case "cursor":
      return probeCursorAccount;
    case "opencode":
      return probeOpencodeAccount;
  }
};

/**
 * Roll the per-field signals (`cliInstalled`, `cliVersionStatus`, `authStatus`)
 * up into the single dot color the renderer paints. The precedence keeps the
 * server-derived status aligned with the client-side fallback when both run.
 */
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

const probeOne = (
  probe: ProviderProbe,
): Effect.Effect<
  AgentAvailability,
  never,
  CommandExecutor.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const lastCheckedAt = new Date();
    const cliPath = yield* resolveCliPath(probe.cliBinary);

    if (cliPath === null || cliPath.length === 0) {
      return AgentAvailability.make({
        providerId: probe.providerId,
        displayName: probe.displayName,
        cliInstalled: false,
        cliLoggedIn: false,
        hasApiKey: false,
        status: "error",
        statusMessage: `${probe.displayName} CLI not found on PATH.`,
        lastCheckedAt,
      });
    }

    const versionResult = yield* runCapture(
      Command.make(cliPath, ["--version"]),
    ).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.catch(() => Effect.succeedNone),
    );

    const cliVersion =
      versionResult._tag === "Some" && versionResult.value.exitCode === 0
        ? versionResult.value.stdout.split(/\r?\n/)[0]?.trim() || undefined
        : undefined;

    // Compute the version verdict alongside the raw string so the renderer
    // doesn't need its own parser. `unknown` covers both "no min tracked for
    // this provider" and "we tried to parse and failed" — both are
    // "let them try" cases as far as the upgrade card is concerned.
    const parsedVersion =
      cliVersion !== undefined ? parseCliVersion(cliVersion) : null;
    let cliVersionStatus: CliVersionStatus = "unknown";
    let cliVersionMinRequired: string | undefined;
    let cliUpgradeCommand: string | undefined;
    if (probe.minVersion !== null) {
      cliVersionMinRequired = probe.minVersion.raw;
      cliUpgradeCommand = probe.upgradeCommand ?? undefined;
      if (parsedVersion === null) {
        cliVersionStatus = "unknown";
      } else if (compareCliVersion(parsedVersion, probe.minVersion) < 0) {
        cliVersionStatus = "outdated";
      } else {
        cliVersionStatus = "ok";
      }
    }

    // Version-gated features the installed CLI supports (pre-session UI gate).
    // Codex resolves its set from the CLI version; Grok ships a single
    // curl-installed channel with no version floor, so we advertise its
    // `goalMode` (native `/goal`, forwarded as a slash command by the driver)
    // unconditionally. Other providers resolve to `[]`.
    const capabilities =
      probe.providerId === "codex"
        ? resolveCodexCapabilities(parsedVersion)
        : probe.providerId === "grok"
          ? ["goalMode"]
          : [];

    // Informational "update available" layer — independent of the SDK floor.
    // Only providers with a registry package are checked; the rest report
    // `"unknown"` and surface no update affordance.
    const latestVersionRaw = yield* resolveLatestVersion(probe);
    const latestVersion = latestVersionRaw ?? undefined;
    const latestVersionStatus = deriveLatestAdvisory(
      cliVersion,
      latestVersionRaw,
    );
    // Install-method-aware update command (native / brew / bun / pnpm / npm /
    // curl). Resolve the binary's realpath too, since global bins are symlinks
    // into `…/lib/node_modules/…`. Set for every provider that has any update
    // path so the renderer can offer one-click update.
    const fs = yield* FileSystem.FileSystem;
    const realPath = yield* fs
      .realPath(cliPath)
      .pipe(Effect.catch(() => Effect.succeed(cliPath)));
    const updateCommand =
      buildUpdateCommand(probe.providerId, [cliPath, realPath]) ?? undefined;

    const account = yield* probeAccount(probe.providerId, cliPath);
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

/**
 * Probe each known provider for CLI install status, version, and local-login
 * state. `ProviderService.availability()` calls this and overlays `hasApiKey`
 * from the keychain.
 */
export const probeAllProviders: Effect.Effect<
  ReadonlyArray<AgentAvailability>,
  never,
  CommandExecutor.ChildProcessSpawner | FileSystem.FileSystem
> = Effect.all(PROBES.map(probeOne), { concurrency: "unbounded" });
