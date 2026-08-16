import { execFileSync } from "node:child_process";
import os from "node:os";

import { Effect } from "effect";

/**
 * Best-effort human name for this machine, computed at request time (no DB
 * column, no rename RPC this pass). Prefers the macOS "Computer Name" the user
 * set in System Settings; falls back to hostname (with a trailing `.local`
 * stripped), then the login username, then a generic "Computer".
 *
 * All I/O is wrapped in `Effect.try` per repo Effect conventions; every step
 * degrades to the next candidate rather than failing, so the Effect never
 * errors.
 */
export const defaultEnvironmentLabel = (): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (process.platform === "darwin") {
      const computerName = yield* computerNameDarwin;
      if (computerName !== null) return computerName;
    }

    const hostname = yield* hostnameLabel;
    if (hostname !== null) return hostname;

    const username = yield* usernameLabel;
    if (username !== null) return username;

    return "Computer";
  });

const cleaned = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
};

const computerNameDarwin = Effect.try({
  try: () =>
    cleaned(
      execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2_000,
      }),
    ),
  catch: () => null,
}).pipe(Effect.orElseSucceed(() => null));

const hostnameLabel = Effect.try({
  try: () => cleaned(os.hostname().replace(/\.local$/i, "")),
  catch: () => null,
}).pipe(Effect.orElseSucceed(() => null));

const usernameLabel = Effect.try({
  try: () => cleaned(os.userInfo().username),
  catch: () => null,
}).pipe(Effect.orElseSucceed(() => null));
