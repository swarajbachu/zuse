import { Effect, Queue, type Scope, Stream } from "effect";
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
} from "@zuse/wire";

// Each provider's interactive login command prints an OAuth URL to stdout (or
// to stderr inside its TUI frame) and waits for the user to complete the flow
// in their browser. We anchor each pattern on the provider's own hosts to
// avoid matching install-instruction or doc URLs the CLI may also print on
// startup.
const CURSOR_URL_PATTERN = /https?:\/\/[^\s]*cursor\.(?:com|sh|so)\/[^\s]*/i;
// `claude auth login` runs an OAuth 2.0 + PKCE flow against claude.ai with a
// localhost callback server, so it auto-completes once the browser approves —
// no code paste-back. The authorize URL lives on claude.ai / anthropic.com.
const CLAUDE_URL_PATTERN =
  /https?:\/\/[^\s]*(?:claude\.ai|(?:console\.)?anthropic\.com)\/[^\s]*/i;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

interface LoginSpawnSpec {
  readonly providerId: ProviderId;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly urlPattern: RegExp;
}

const LOGIN_SPECS: Partial<Record<ProviderId, LoginSpawnSpec>> = {
  cursor: {
    providerId: "cursor",
    command: "cursor-agent",
    args: ["login"],
    urlPattern: CURSOR_URL_PATTERN,
  },
  claude: {
    providerId: "claude",
    command: "claude",
    // `--claudeai` selects the Claude subscription OAuth (vs `--console` API
    // billing), matching the default the interactive `/login` menu offers.
    args: ["auth", "login", "--claudeai"],
    urlPattern: CLAUDE_URL_PATTERN,
  },
};

/**
 * Spawn a provider's interactive login subcommand and stream progress back
 * to the renderer. Today `cursor` and `claude` have real handlers — other
 * providers resolve to an immediate `{ kind: "done", ok: false, reason: … }`.
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
    const mailbox = yield* Queue.make<LoginEvent>();

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
      yield* mailbox.end;
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
      const cleaned = raw.replace(ANSI_PATTERN, "").trim();
      if (cleaned.length === 0) return;
      Queue.offerUnsafe(mailbox, { _tag: "log", text: cleaned });
      if (!urlEmitted) {
        const m = cleaned.match(spec.urlPattern);
        if (m !== null) {
          urlEmitted = true;
          Queue.offerUnsafe(mailbox, { _tag: "url", url: m[0] });
        }
      }
    };

    const rlOut = readline.createInterface({ input: child.stdout });
    const rlErr = readline.createInterface({ input: child.stderr });
    rlOut.on("line", handleLine);
    rlErr.on("line", handleLine);

    child.once("exit", (code, signal) => {
      exited = true;
      const ok = code === 0;
      const reason = ok
        ? undefined
        : signal !== null
          ? `${spec.command} login was terminated (${signal})`
          : `${spec.command} login exited with code ${code ?? "?"}`;
      Queue.offerUnsafe(mailbox, {
        _tag: "done",
        ok,
        ...(reason !== undefined ? { reason } : {}),
      });
      void mailbox.end.pipe(Effect.runPromise);
    });

    child.once("error", (err) => {
      exited = true;
      Queue.offerUnsafe(mailbox, {
        _tag: "done",
        ok: false,
        reason: err.message,
      });
      void mailbox.end.pipe(Effect.runPromise);
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

    return Stream.fromQueue(mailbox);
  });
