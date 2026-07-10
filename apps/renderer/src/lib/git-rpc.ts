import { Effect } from "effect";

import type {
  GitCommandError,
  GitFolderNotFoundError,
  GitNotARepoError,
  GitNotInstalledError,
} from "@zuse/contracts";

import { formatError } from "./format-error.ts";

/**
 * The four typed failures every `git.*` RPC can return (`GitErrors` in
 * `packages/contracts/src/git.ts`).
 */
type GitFailure =
  | GitNotARepoError
  | GitNotInstalledError
  | GitCommandError
  | GitFolderNotFoundError;

export type GitErrorTag = GitFailure["_tag"];

export type GitRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly tag: GitErrorTag | null;
      readonly message: string;
    };

/**
 * Run a `git.*` RPC effect and classify its outcome into a discriminated
 * result. The classification happens **inside** the Effect via `catchTags`,
 * which is the only place the real typed error (`GitNotARepoError`, …) is
 * visible — a `try/catch` around `Effect.runPromise` only sees an opaque
 * rejection whose `_tag` is gone, which is why the previous "not a repo"
 * detection silently never matched. The outer `try/catch` is a last-resort
 * net for transport/defect failures outside the typed error channel.
 */
export const classifyGit = async <A>(
  effect: Effect.Effect<A, GitFailure>,
): Promise<GitRpcResult<A>> => {
  try {
    return await Effect.runPromise(
      effect.pipe(
        Effect.map((value): GitRpcResult<A> => ({ ok: true, value })),
        Effect.catchTags({
          GitNotARepoError: () =>
            Effect.succeed<GitRpcResult<A>>({
              ok: false,
              tag: "GitNotARepoError",
              message: "Not a git repository",
            }),
          GitNotInstalledError: () =>
            Effect.succeed<GitRpcResult<A>>({
              ok: false,
              tag: "GitNotInstalledError",
              message: "Git is not installed",
            }),
          GitCommandError: (err) =>
            Effect.succeed<GitRpcResult<A>>({
              ok: false,
              tag: "GitCommandError",
              message: err.reason,
            }),
          GitFolderNotFoundError: () =>
            Effect.succeed<GitRpcResult<A>>({
              ok: false,
              tag: "GitFolderNotFoundError",
              message: "Folder not found",
            }),
        }),
      ),
    );
  } catch (err) {
    return { ok: false, tag: null, message: formatError(err) };
  }
};
