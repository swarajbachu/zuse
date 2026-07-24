import { type Cause, Effect, Queue, type Scope, Stream } from "effect";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import * as readline from "node:readline";
import { homedir } from "node:os";

import {
  AgentSessionStartError,
  type LoginEvent,
  type ProviderId,
} from "@zuse/contracts";

// Each provider's interactive login command prints an OAuth URL to stdout (or
// to stderr inside its TUI frame) and waits for the user to complete the flow
// in their browser. Fixed-host providers use an allow-list pattern. Grok may
// use an arbitrary enterprise IdP, so its candidates are scheme/host validated
// instead.
type LoginUrlPolicy = (url: URL) => boolean;

const hasDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

const CURSOR_URL_POLICY: LoginUrlPolicy = ({ hostname }) =>
  ["cursor.com", "cursor.sh", "cursor.so"].some((domain) =>
    hasDomain(hostname, domain),
  );
// `claude auth login` runs an OAuth 2.0 + PKCE flow against claude.ai with a
// localhost callback server, so it auto-completes once the browser approves —
// no code paste-back. The authorize URL lives on claude.ai / anthropic.com.
const CLAUDE_URL_POLICY: LoginUrlPolicy = ({ hostname }) =>
  hasDomain(hostname, "claude.ai") || hasDomain(hostname, "anthropic.com");
const ESC = "\u001B";
const BEL = "\u0007";
// Constructed from a string so the source contains no control characters in a
// regex literal. This is the same CSI/single-escape matcher used previously.
// biome-ignore lint/complexity/useRegexLiterals: a literal is rejected for containing control characters
const CSI_PATTERN = new RegExp(
  "\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])",
  "g",
);
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.;\]}]+$/;

interface LoginSpawnSpec {
  readonly providerId: ProviderId;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly urlPolicy?: LoginUrlPolicy;
}

const LOGIN_SPECS: Partial<Record<ProviderId, LoginSpawnSpec>> = {
  cursor: {
    providerId: "cursor",
    command: "cursor-agent",
    args: ["login"],
    urlPolicy: CURSOR_URL_POLICY,
  },
  claude: {
    providerId: "claude",
    command: "claude",
    // `--claudeai` selects the Claude subscription OAuth (vs `--console` API
    // billing), matching the default the interactive `/login` menu offers.
    args: ["auth", "login", "--claudeai"],
    urlPolicy: CLAUDE_URL_POLICY,
  },
  grok: {
    providerId: "grok",
    command: "grok",
    // Use the short-code browser approval flow. External providers still run
    // first, and enterprise OIDC falls back to its supported loopback flow.
    args: ["login", "--device-auth"],
  },
};

export const getProviderLoginCommand = (
  providerId: ProviderId,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} | null => {
  const spec = LOGIN_SPECS[providerId];
  return spec === undefined
    ? null
    : { command: spec.command, args: spec.args };
};

const oscTerminator = (
  raw: string,
  from: number,
): { readonly index: number; readonly length: number } | null => {
  const bel = raw.indexOf(BEL, from);
  const stringTerminator = raw.indexOf(`${ESC}\\`, from);
  if (bel === -1 && stringTerminator === -1) return null;
  if (bel !== -1 && (stringTerminator === -1 || bel < stringTerminator)) {
    return { index: bel, length: BEL.length };
  }
  return { index: stringTerminator, length: 2 };
};

const oscHyperlinkUrls = (raw: string): ReadonlyArray<string> => {
  const urls: string[] = [];
  const prefix = `${ESC}]8;`;
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(prefix, cursor);
    if (start === -1) break;
    const urlStart = raw.indexOf(";", start + prefix.length);
    if (urlStart === -1) break;
    const terminator = oscTerminator(raw, urlStart + 1);
    if (terminator === null) break;
    const url = raw.slice(urlStart + 1, terminator.index);
    if (url.length > 0) urls.push(url);
    cursor = terminator.index + terminator.length;
  }
  return urls;
};

const stripOscSequences = (raw: string): string => {
  let output = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(`${ESC}]`, cursor);
    if (start === -1) {
      output += raw.slice(cursor);
      break;
    }
    output += raw.slice(cursor, start);
    const terminator = oscTerminator(raw, start + 2);
    if (terminator === null) {
      output += raw.slice(start);
      break;
    }
    cursor = terminator.index + terminator.length;
  }
  return output;
};

export const stripLoginTerminalControls = (raw: string): string =>
  stripOscSequences(raw).replace(CSI_PATTERN, "");

const safeLoginUrl = (candidate: string): URL | null => {
  try {
    const parsed = new URL(candidate);
    if (parsed.username.length > 0 || parsed.password.length > 0) return null;
    if (parsed.protocol === "https:") return parsed;
    if (parsed.protocol !== "http:") return null;
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]";
    return isLoopback ? parsed : null;
  } catch {
    return null;
  }
};

const normalizedUrlCandidate = (
  candidate: string,
  policy: LoginUrlPolicy | undefined,
): string | null => {
  const trimmed = candidate.replace(TRAILING_URL_PUNCTUATION, "");
  const parsed = safeLoginUrl(trimmed);
  if (parsed === null || (policy !== undefined && !policy(parsed))) return null;
  return trimmed;
};

export const extractProviderLoginUrl = (
  raw: string,
  urlPolicy?: LoginUrlPolicy,
): string | null => {
  const candidates = [...oscHyperlinkUrls(raw)];
  const cleaned = stripLoginTerminalControls(raw);
  for (const match of cleaned.matchAll(URL_CANDIDATE_PATTERN)) {
    if (match[0] !== undefined) candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    const normalized = normalizedUrlCandidate(candidate, urlPolicy);
    if (normalized !== null) return normalized;
  }
  return null;
};

/**
 * Spawn a provider's interactive login subcommand and stream progress back
 * to the renderer. Today `cursor`, `claude`, and `grok` have real handlers;
 * other providers resolve to an immediate `done(ok=false)`.
 *
 * Cancellation: the stream is wrapped in `Stream.unwrap`, so when the
 * renderer unsubscribes (or the IPC drops), the scope closes and the
 * registered finalizer kills the child process with SIGTERM (escalating to
 * SIGKILL after a short grace period).
 */
export const startProviderLogin = (
  providerId: ProviderId,
): Stream.Stream<LoginEvent, AgentSessionStartError> => {
  const spec = LOGIN_SPECS[providerId];
  if (spec === undefined) {
    const event: LoginEvent = {
      _tag: "done",
      ok: false,
      reason: `Login flow not supported for ${providerId}`,
    };
    return Stream.succeed(event);
  }
  return Stream.unwrap(spawnLoginProcess(spec));
};

const spawnLoginProcess = (
  spec: LoginSpawnSpec,
): Effect.Effect<
  Stream.Stream<LoginEvent>,
  AgentSessionStartError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const events = yield* Queue.make<LoginEvent, Cause.Done>();

    // Spawn into the user's home dir — login doesn't touch the project tree
    // and we don't want a project-local stale state to interfere.
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: homedir(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      yield* Queue.end(events);
      return yield* Effect.fail(
        new AgentSessionStartError({
          providerId: spec.providerId,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    let urlEmitted = false;
    let exited = false;

    const handleLine = (raw: string): void => {
      const cleaned = stripLoginTerminalControls(raw).trim();
      if (cleaned.length === 0) return;
      Queue.offerUnsafe(events, { _tag: "log", text: cleaned });
      if (!urlEmitted) {
        const url = extractProviderLoginUrl(raw, spec.urlPolicy);
        if (url !== null) {
          urlEmitted = true;
          Queue.offerUnsafe(events, { _tag: "url", url });
        }
      }
    };

    const rlOut = readline.createInterface({ input: child.stdout });
    const rlErr = readline.createInterface({ input: child.stderr });
    rlOut.on("line", handleLine);
    rlErr.on("line", handleLine);

    const finish = (ok: boolean, reason?: string): void => {
      if (exited) return;
      exited = true;
      Queue.offerUnsafe(events, {
        _tag: "done",
        ok,
        ...(reason !== undefined ? { reason } : {}),
      });
      Queue.endUnsafe(events);
    };

    child.once("exit", (code, signal) => {
      const ok = code === 0;
      const reason = ok
        ? undefined
        : signal !== null
          ? `${spec.command} login was terminated (${signal})`
          : `${spec.command} login exited with code ${code ?? "?"}`;
      finish(ok, reason);
    });

    child.once("error", (err) => {
      finish(false, err.message);
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rlOut.close();
        rlErr.close();
        if (exited) return;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!exited) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        }, 1_000);
      }),
    );

    return Stream.fromQueue(events);
  });
