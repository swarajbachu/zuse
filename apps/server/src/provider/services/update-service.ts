import { Effect, Mailbox, type Scope, Stream } from "effect";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as readline from "node:readline";
import { homedir } from "node:os";
import type { Readable } from "node:stream";

import {
  AgentSessionStartError,
  type ProviderId,
  type ProviderUpdateEvent,
} from "@zuse/wire";

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Hard ceiling on a single update. npm global installs + curl bootstrap
// scripts finish well inside this; the cap just stops a wedged installer from
// streaming forever.
const UPDATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Spawn a provider's update/install command and stream its output back to the
 * renderer, ending with a terminal `done`. The command runs in a **login
 * shell** (`bash -lc`) for two reasons:
 *   1. PATH — npm/bun/pnpm and the provider binary resolve the same way they
 *      do in the user's terminal (the app may be launched from Finder).
 *   2. Pipes — curl-based installers (Grok, Cursor) are full shell pipelines
 *      (`curl … | bash`), which only work through a shell.
 *
 * Cancellation mirrors `startProviderLogin`: wrapped in `Stream.unwrapScoped`,
 * so unsubscribing (or an IPC drop) closes the scope and the finalizer kills
 * the child (SIGTERM → SIGKILL).
 */
export const startProviderUpdate = (
  providerId: ProviderId,
  command: string | null,
): Stream.Stream<ProviderUpdateEvent, AgentSessionStartError> => {
  if (command === null) {
    const event: ProviderUpdateEvent = {
      _tag: "done",
      ok: false,
      reason: `No update command is available for ${providerId}.`,
    };
    return Stream.succeed(event);
  }
  return Stream.unwrapScoped(spawnUpdate(providerId, command));
};

const spawnUpdate = (
  providerId: ProviderId,
  command: string,
): Effect.Effect<
  Stream.Stream<ProviderUpdateEvent>,
  AgentSessionStartError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox.make<ProviderUpdateEvent>();

    // stdin closed (`ignore`) so an installer never blocks waiting on input.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // `-l` (login) loads the user's profile so version managers (nvm, fnm,
      // volta, asdf) put the right npm/binary on PATH; `-c` runs the command.
      child = spawn("bash", ["-lc", command], {
        cwd: homedir(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      yield* mailbox.end;
      return yield* Effect.fail(
        new AgentSessionStartError({
          providerId,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    let exited = false;
    let lastLine = "";

    const handleLine = (raw: string): void => {
      const cleaned = raw.replace(ANSI_PATTERN, "").trim();
      if (cleaned.length === 0) return;
      lastLine = cleaned;
      mailbox.unsafeOffer({ _tag: "log", text: cleaned });
    };

    const rlOut = readline.createInterface({ input: child.stdout });
    const rlErr = readline.createInterface({ input: child.stderr });
    rlOut.on("line", handleLine);
    rlErr.on("line", handleLine);

    const finish = (ok: boolean, reason?: string): void => {
      if (exited) return;
      exited = true;
      mailbox.unsafeOffer({
        _tag: "done",
        ok,
        ...(reason !== undefined ? { reason } : {}),
      });
      void mailbox.end.pipe(Effect.runPromise);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish(false, "Update timed out after 5 minutes.");
    }, UPDATE_TIMEOUT_MS);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0;
      const reason = ok
        ? undefined
        : signal !== null
          ? `Update was terminated (${signal}).`
          : `Update failed (exit ${code ?? "?"})${
              lastLine.length > 0 ? `: ${lastLine}` : "."
            }`;
      finish(ok, reason);
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimeout(timer);
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

    return Mailbox.toStream(mailbox);
  });
